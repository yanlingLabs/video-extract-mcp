import { liveServers, type ServerEntry } from './discovery.js';
import type { StatusItem } from './registry.js';

/**
 * `video-extract status` (spec §6 / task-6-brief.md): discovers every live
 * server (Task 5's discovery file -- liveServers() has already liveness-
 * verified each pid and pruned dead entries), fetches each one's /status
 * payload (Task 3), and renders one merged view.
 *
 * Observables, never verdicts (spec §1/§10): every field this file renders
 * is exactly what the registry/endpoint measured -- raw stage names, raw
 * timestamps turned into elapsed durations, raw byte counts, raw CPU
 * seconds. Nothing here ever labels an item `stale`, `stuck` or `healthy`,
 * and nothing fabricates a percentage or an "N ahead" count the registry
 * does not track. The reader (agent or human) decides slow-vs-stuck by
 * polling twice and diffing cpu/bytes -- that judgment belongs to the
 * reader, not this render. tests/statusCli.test.ts's own grep guard
 * enforces this on the rendered TEXT the same way
 * tests/statusEndpoint.test.ts's guard enforces it on the JSON payload --
 * the endpoint's guard alone would not catch a CLI that re-introduced a
 * verdict word while rendering an otherwise-clean payload.
 */

type DecoratedItem = StatusItem & { workDirBytes?: number; childCpuSeconds?: number };

interface StatusPayload {
  server: {
    pid: number; version: string; startedAt: number; uptimeSeconds: number;
    concurrencyCap: number; running: number; queued: number;
  };
  items: DecoratedItem[];
  evicted: number;
}

const WATCH_INTERVAL_MS = 1000;
/** Short-timeout GET per spec §6: a discovery entry whose pid answers
 *  kill(pid,0) (liveServers() already checked that) but whose HTTP endpoint
 *  is unresponsive -- slow, crashed mid-request, or a registration/listener
 *  race -- must not hang the whole render. Bounded, never retried. */
const FETCH_TIMEOUT_MS = 2_000;

function humanizeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex++;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

function statusUrlFor(entry: ServerEntry, urls: string[]): string {
  const base = `http://127.0.0.1:${entry.port}/status`;
  if (urls.length === 0) return base;
  const qs = new URLSearchParams();
  for (const u of urls) qs.append('url', u);
  return `${base}?${qs.toString()}`;
}

/** Best-effort, matching the whole feature's degrade-never-throw posture
 *  (src/status/endpoint.ts, src/status/discovery.ts): a server that cannot
 *  be reached right now is simply absent from this render, not a crash. */
async function fetchPayload(entry: ServerEntry, urls: string[]): Promise<StatusPayload | null> {
  try {
    const res = await fetch(statusUrlFor(entry, urls), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as StatusPayload;
  } catch {
    return null;
  }
}

/** The chain is exactly the RAW stage strings the registry recorded (spec
 *  §3/§4: 'resolving' | 'downloading' | 'transcribing' | 'frames' for
 *  analyze items, 'downloading' only for a returnVideo:true resolve item),
 *  joined with the arrow the brief's render rules specify -- never a
 *  paraphrase invented for readability. */
function stageChain(item: DecoratedItem): string {
  return item.stageHistory.map((s) => s.stage).join(' → ');
}

/** Exactly one of the brief's two literal suffix shapes: `(<n>s in stage)`
 *  while running, `(done <n>m ago)` once outcome is set -- never both,
 *  never a third shape (e.g. a verdict label) added for an old one. */
function ageSuffix(item: DecoratedItem, now: number): string {
  if (item.outcome) {
    const minutes = Math.max(0, Math.floor((now - item.outcome.at) / 60_000));
    return `(done ${minutes}m ago)`;
  }
  const last = item.stageHistory[item.stageHistory.length - 1];
  const seconds = last ? Math.max(0, Math.floor((now - last.at) / 1_000)) : 0;
  return `(${seconds}s in stage)`;
}

function renderItem(item: DecoratedItem, now: number): string {
  // Registered but not yet reached any stage -- still queued behind the
  // concurrency pool, or the microtask gap before its own first onStage
  // (registerItems() in src/mcp.ts registers every item up front, before
  // either executor starts, so this window is real, not hypothetical).
  // The registry has no "N ahead" field (only the per-task MCP
  // statusMessage does, which this CLI never reads -- it only ever talks
  // to the /status endpoint), so 'queued' states the one fact the registry
  // actually knows rather than fabricating a count.
  if (item.stageHistory.length === 0 && !item.outcome) {
    return `${item.url}  queued`;
  }

  const segments = [item.url];
  const chain = stageChain(item);
  if (chain) segments.push(chain);
  segments.push(ageSuffix(item, now));
  let line = segments.join('  ');

  if (item.childPid !== undefined) {
    line += ` · ${item.childCommand ?? 'unknown'} pid ${item.childPid}`;
    if (item.childCpuSeconds !== undefined) line += ` · cpu ${item.childCpuSeconds.toFixed(1)}s`;
  }
  if (item.workDirBytes !== undefined) line += ` · workdir ${humanizeBytes(item.workDirBytes)}`;
  return line;
}

function renderFooter(server: StatusPayload['server']): string {
  const upMinutes = Math.max(0, Math.floor(server.uptimeSeconds / 60));
  return `server pid ${server.pid} · up ${upMinutes}m · cap ${server.concurrencyCap} `
    + `· running ${server.running} · queued ${server.queued}`;
}

async function renderOnce(urls: string[], json: boolean, out: (line: string) => void): Promise<void> {
  const payloads: StatusPayload[] = [];
  for (const entry of liveServers()) {
    const payload = await fetchPayload(entry, urls);
    if (payload) payloads.push(payload);
  }

  if (json) {
    // Raw, merged, unmodified per-server payloads -- scripting wants the
    // real JSON the endpoint produced, not a CLI-invented reshaping.
    // Empty array (not the human sentence below) when nothing is live, so
    // a script piping this through JSON.parse never has to special-case
    // prose.
    out(JSON.stringify(payloads));
    return;
  }

  if (payloads.length === 0) {
    out('no live video-extract servers');
    return;
  }

  const now = Date.now();
  for (const payload of payloads) {
    for (const item of payload.items) out(renderItem(item, now));
    out(renderFooter(payload.server));
  }
}

/** Resolves after `ms`, or immediately if `signal` is already (or becomes)
 *  aborted -- whichever comes first. Two independent teardown mechanisms,
 *  per the task's own constraint ("make sure the test suite never leaves a
 *  watch timer running (unref or explicit teardown)"): the pending timer is
 *  unref'd as a backstop (never holds the process open on its own), AND an
 *  abort clears it explicitly and resolves right away rather than waiting
 *  out the rest of the interval. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * `video-extract status [--watch] [--json] [url...]` (spec §6). `out` is
 * injected so tests capture rendered lines without stubbing console.
 *
 * `opts.signal` is a disclosed addition beyond the brief's own two-argument
 * sketch (`src/cli.ts`'s wiring only ever passes two): `--watch` re-renders
 * forever in real usage -- Ctrl-C ends it via Node's default un-handled-
 * SIGINT behavior, and deliberately no listener is installed here to
 * intercept that, so there is nothing to ever leak across tests or
 * accumulate across repeated builds. A test cannot deliver a real Ctrl-C to
 * itself deterministically, so it needs a way to stop the loop instead; an
 * injected AbortSignal is that seam. Every watch-mode test in
 * tests/statusCli.test.ts passes one; the only production call site
 * (src/cli.ts's main()) never does, and gets the real forever-until-killed
 * behavior the flag promises.
 */
export async function runStatusCli(
  argv: string[],
  out: (line: string) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<number> {
  const watch = argv.includes('--watch');
  const json = argv.includes('--json');
  const urls = argv.filter((a) => a !== '--watch' && a !== '--json');

  if (!watch) {
    await renderOnce(urls, json, out);
    return 0;
  }

  const signal = opts.signal ?? new AbortController().signal;
  while (!signal.aborted) {
    out('\x1Bc'); // ANSI full reset -- clears scrollback, not just the visible screen
    await renderOnce(urls, json, out);
    await abortableSleep(WATCH_INTERVAL_MS, signal);
  }
  return 0;
}
