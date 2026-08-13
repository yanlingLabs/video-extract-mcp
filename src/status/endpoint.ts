import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { StatusItem, StatusRegistry } from './registry.js';

export interface StatusEndpoint { url: Promise<string | null>; close(): void; }

/** The subset of `buildServer()`'s own state the endpoint needs to report
 *  `server.*` in the payload -- passed in rather than imported, so this
 *  module has no dependency on src/mcp.ts (spec §5's consumers include the
 *  CLI, which never constructs an MCP server at all). */
export interface StatusServerInfo {
  pid: number;
  version: string;
  startedAt: number;
  concurrency: () => { cap: number; running: number; queued: number };
}

/**
 * A localhost-only, best-effort status endpoint. Spec §5 / §10: the
 * listener must never hold the process open (the 0.2.0 zombie-server
 * class), and a bind failure degrades the endpoint to permanently absent
 * rather than affecting the rest of the server in any way.
 *
 * `port`: number to pin, 0 for ephemeral, null for disabled (never
 * listens -- no `http.createServer` call happens at all in that branch, so
 * "never listens" is structural rather than an unreached code path).
 */
export function startStatusEndpoint(
  registry: StatusRegistry,
  server: StatusServerInfo,
  port: number | null,
): StatusEndpoint {
  if (port === null) {
    return { url: Promise.resolve(null), close() { /* nothing was ever opened */ } };
  }

  // Every accepted connection is tracked so close() can force it shut
  // rather than waiting for the client to disconnect (http.Server#close
  // only stops accepting NEW connections; it does not touch open ones).
  const sockets = new Set<Socket>();
  const srv: Server = createServer((req, res) => { handleRequest(req, res, registry, server); });

  srv.on('connection', (socket) => {
    // Unref every socket, not just the listener itself -- an idle
    // keep-alive connection must not hold the process open any more than
    // the listener does (same 0.2.0 lesson, one level down the handle
    // tree). Harmless to call twice; Node no-ops a repeat unref().
    socket.unref();
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  let settled = false;
  const url = new Promise<string | null>((resolve) => {
    const settleNull = () => { if (!settled) { settled = true; resolve(null); } };
    // Persistent listener, not `.once` -- an emitter with zero 'error'
    // listeners throws on the NEXT error event too (e.g. an accept-time
    // EMFILE well after a successful listen), and Node's rule is "at least
    // one listener for the emitter's lifetime", not "for the first event".
    // The promise itself still only ever settles once (see settleNull).
    srv.on('error', settleNull);
    srv.on('listening', () => {
      if (settled) return;
      settled = true;
      srv.unref(); // after listen succeeds: the listener never holds the process open.
      const addr = srv.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      resolve(`http://127.0.0.1:${actualPort}/status`);
    });
    try {
      srv.listen(port, '127.0.0.1');
    } catch {
      // A pinned port outside 0-65535 throws SYNCHRONOUSLY from listen()
      // itself (RangeError ERR_SOCKET_BAD_PORT) rather than emitting
      // 'error' -- confirmed empirically, not assumed (see task report).
      // Same degrade-to-null contract as EADDRINUSE: never throw out of
      // this function, no matter which of the two failure shapes hits.
      settleNull();
    }
  });

  return {
    url,
    close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      srv.close();
    },
  };
}

function handleRequest(
  req: IncomingMessage, res: ServerResponse,
  registry: StatusRegistry, server: StatusServerInfo,
): void {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('method not allowed');
    return;
  }
  const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (parsed.pathname !== '/status') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  // Everything below is sampled fresh, per request -- running/queued and
  // uptime are live values, and the two per-item samples are request-time
  // observables by design (spec §5: "the agent polls twice and diffs").
  const urls = parsed.searchParams.getAll('url');
  const { items, evicted } = registry.snapshot(urls);
  const { cap, running, queued } = server.concurrency();
  const payload = {
    server: {
      pid: server.pid,
      version: server.version,
      startedAt: server.startedAt,
      uptimeSeconds: (Date.now() - server.startedAt) / 1000,
      concurrencyCap: cap,
      running,
      queued,
    },
    items: items.map(decorateItem),
    evicted,
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  // JSON.stringify drops undefined-valued properties -- exactly the
  // "absent on failure" contract for workDirBytes/childCpuSeconds below;
  // no conditional spreading needed to hide a failed sample.
  res.end(JSON.stringify(payload));
}

function decorateItem(item: StatusItem): StatusItem & { workDirBytes?: number; childCpuSeconds?: number } {
  return {
    ...item,
    workDirBytes: workDirBytesOf(item.destinationPath),
    childCpuSeconds: item.childPid !== undefined ? childCpuSecondsOf(item.childPid) : undefined,
  };
}

/**
 * Recursive byte size of `dir`. This is the plan-level resolution of spec
 * §3's registry-level "workDir" field: `StatusItem` deliberately has no
 * such field (see src/status/registry.ts / task-1-report.md) because for a
 * URL source the pipeline's working directory already IS `destinationPath`
 * (the outDir passed down to the resolver), and for a local-file source the
 * internal mkdtemp the pipeline may use is never known at the agent layer
 * that populates the registry. `destinationPath` is the one directory this
 * feature owns and can observe for *every* item, URL or local, and it is
 * where downloads and frames actually accumulate on disk -- so it is what
 * gets sampled here, at request time, rather than a separate tracked field.
 *
 * Best-effort: the directory may not exist yet (nothing downloaded so
 * far), so any failure -- missing dir, a file vanishing mid-scan, anything
 * else -- returns undefined rather than throwing, and the field is simply
 * absent from that item's payload.
 */
function workDirBytesOf(dir: string): number | undefined {
  try {
    const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue; // directory entries themselves carry no content bytes
      total += statSync(join(entry.parentPath, entry.name)).size;
    }
    return total;
  } catch {
    return undefined;
  }
}

/** Cumulative CPU seconds for a live child, sampled via `ps`. Best-effort:
 *  absent (not thrown) when `ps` itself is unavailable or the pid is
 *  already gone by the time this request runs. */
function childCpuSecondsOf(pid: number): number | undefined {
  try {
    const result = spawnSync('ps', ['-o', 'cputime=', '-p', String(pid)], { encoding: 'utf8' });
    if (result.error || result.status !== 0) return undefined;
    return parseCpuTime(result.stdout);
  } catch {
    return undefined;
  }
}

/**
 * Parses ps(1) cumulative-CPU-time text to seconds, generically over field
 * count rather than one fixed pattern: an optional "D-" prefix contributes
 * days, then colon-separated fields are read from the RIGHT as
 * seconds(.fraction), minutes, hours.
 *
 * Why generic rather than the single literal "[[dd-]hh:]mm:ss" pattern:
 * verified directly on this host (darwin) that `ps -o cputime=` -- BSD's
 * "time" field, just aliased to the name "cputime" -- never rolls minutes
 * into hours and always carries a fractional-seconds component: a
 * freshly-busy shell read "0:02.18", and pid 1 (launchd, 6+ day uptime)
 * read "78:06.53" -- three-digit minutes, still no hour field, at 24+ hours
 * of accumulated CPU time. That is a DIFFERENT shape from the format the
 * task brief describes, which is actually Linux procps's documented
 * *etime* (elapsed real time) grammar, "[[DD-]hh:]mm:ss" -- three width
 * variants collapsing down to bare mm:ss. procps's actual *cputime* format
 * is "[DD-]HH:MM:SS": integer seconds, only two variants, and HH:MM:SS
 * never collapses even for a two-second-old process. Neither of those two
 * real formats is what darwin prints. Rather than special-case per
 * platform (and guess at Linux's exact bytes without a machine to check),
 * one field-count-driven rule accepts all of: darwin's "M+:SS[.ff]" (2
 * fields), procps's "HH:MM:SS" (3 fields) and "DD-HH:MM:SS" (3 fields +
 * day prefix), and the brief's own literal "mm:ss" (2 fields) -- see the
 * task report for the full parse table.
 */
function parseCpuTime(raw: string): number | undefined {
  const trimmed = raw.trim();
  const dayMatch = /^(\d+)-(.+)$/.exec(trimmed);
  const days = dayMatch ? Number(dayMatch[1]) : 0;
  const rest = (dayMatch ? dayMatch[2] : trimmed) ?? '';

  const fields = rest.split(':');
  if (fields.length < 2 || fields.length > 3) return undefined;
  if (!fields.every((f) => /^\d+(?:\.\d+)?$/.test(f))) return undefined;

  const nums = fields.map(Number);
  const seconds = nums[nums.length - 1] ?? 0;
  const minutes = nums[nums.length - 2] ?? 0;
  const hours = nums.length === 3 ? (nums[0] ?? 0) : 0;
  if (![days, hours, minutes, seconds].every(Number.isFinite)) return undefined;
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

/**
 * VIDEO_EXTRACT_STATUS_PORT. Mirrors the intFromEnv house style
 * (src/agent/slots.ts) -- trim, treat unset/blank/unparseable input as a
 * safe fallback rather than throwing or pinning nonsense -- but the
 * *meaning* of the values is deliberately inverted from this codebase's
 * other zero-as-sentinel env reader, VIDEO_EXTRACT_TASK_TTL_MS
 * (taskTtlMsFromEnv, same file): there, an explicit 0 (or any non-positive
 * value) means "no expiry" -- a PERMISSIVE sentinel, chosen because a TTL
 * has no other use for zero.
 *
 * Here, plain numeric 0 is NOT free to mean "disabled": Node's own
 * `server.listen(0, ...)` already defines port 0 as "ask the OS for an
 * ephemeral port", which is this endpoint's own default posture (spec §5).
 * So an unset/blank env var maps to that same 0, to get ephemeral-by-
 * default with no env var set at all. That leaves plain 0 unavailable as a
 * way to spell "disabled" -- disabling is instead spelled with the LITERAL
 * STRING '0', which collides with no real port number once trimmed.
 * Out-of-range integers (<=0 other than the literal '0', or >65535, the
 * top of the TCP port space) fall back to ephemeral rather than being
 * pinned as-is: `startStatusEndpoint` independently refuses to let a bad
 * port value crash the server either way (it catches the synchronous
 * ERR_SOCKET_BAD_PORT throw too -- see above), but rejecting nonsense here
 * keeps the common, env-var-driven path from ever needing that fallback.
 */
export function statusPortFromEnv(): number | null {
  const raw = process.env['VIDEO_EXTRACT_STATUS_PORT']?.trim();
  if (!raw) return 0;                                            // unset/blank -> ephemeral
  if (raw === '0') return null;                                  // explicit disable
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65_535) return 0;     // garbage/out-of-range -> ephemeral
  return n;                                                       // pin
}
