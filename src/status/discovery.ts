import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Spec §7: cross-session discovery. Each MCP client spawns its own server
 * process, so without this a CLI (Task 6) can only ever see the one server
 * it happens to be talking to. This is the SINGLE exception to the whole
 * status feature's one hard rule -- "no per-stage file writes" -- and it
 * earns that exception narrowly: written once at server start
 * (`registerServer`) and once at exit (`unregisterServer`), never on a
 * stage transition. Everything else about status stays in memory
 * (src/status/registry.ts).
 *
 * `liveServers()` is the one function readers (a CLI, polling on an
 * interval) call repeatedly, so it carries the feature's write-frequency
 * promise on its own: it rewrites the file ONLY when a liveness check
 * actually found something dead to prune. A poll that finds every entry
 * alive is a pure read -- no temp file, no rename, no mtime change. Getting
 * that wrong turns every CLI poll into a disk write.
 */
export interface ServerEntry { pid: number; port: number; startedAt: number; version: string }

const FILE_NAME = 'servers.json';

/**
 * `VIDEO_EXTRACT_CACHE_DIR` -- TEST-FACING. This env var exists so tests can
 * point the whole discovery file at a throwaway `mkdtemp` directory and
 * never read or write the real machine's home directory; production code
 * never needs to set it. When set, it overrides the CACHE-DIR ROOT (the
 * `~/.cache/video-extract-mcp` part), not the filename -- the discovery
 * file always lives at `<root>/servers.json`. Read fresh on every call
 * (never cached at module scope) so a test's `vi.stubEnv` per-`it()` takes
 * effect immediately, including across the many `buildServer()` calls the
 * rest of this codebase's test suite already makes in-process.
 *
 * Mirrors the resolution shape of `VIDEO_EXTRACT_MODELS_DIR`
 * (src/util/models.ts) one level up: that env var points AT a directory
 * directly, this one points at the cache root a sibling file lives under.
 * No literal home-directory path or OS username ever appears in this
 * source file -- `homedir()` is a runtime call, resolved fresh on whatever
 * machine this actually executes on.
 */
export function discoveryPath(): string {
  const explicit = process.env['VIDEO_EXTRACT_CACHE_DIR']?.trim();
  const dir = explicit ? explicit : join(homedir(), '.cache', 'video-extract-mcp');
  return join(dir, FILE_NAME);
}

/** Structural validation for one parsed array element. Not gold-plating: a
 *  file written by a future version of this tool (extra fields), hand-edited,
 *  or truncated mid-object by something other than this module's own
 *  write-rename could otherwise hand `isAlive` a non-numeric `pid`, and
 *  `process.kill` throws `ERR_INVALID_ARG_TYPE` for that -- a code that is
 *  neither `ESRCH` nor `EPERM`, which `isAlive`'s own fail-toward-alive
 *  default would then keep forever. Filtering unrecognizable shapes out
 *  HERE, before liveness ever sees them, is what keeps a garbage entry from
 *  becoming immortal. This is a read-time filter only -- it never forces a
 *  write; see `liveServers` for why that distinction matters. */
function isServerEntry(v: unknown): v is ServerEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return Number.isInteger(o['pid']) && (o['pid'] as number) > 0
    && Number.isInteger(o['port']) && (o['port'] as number) >= 0
    && typeof o['startedAt'] === 'number' && Number.isFinite(o['startedAt'])
    && typeof o['version'] === 'string';
}

/** Absent file, unreadable file, invalid JSON, JSON that isn't an array, or
 *  an array with unrecognizable elements -- every one of those reads as
 *  `[]` (or as "just the recognizable elements"), never throws. The file is
 *  a hint, not a contract; every real reader (this module's own
 *  `liveServers`, and Task 6's CLI on top of it) re-verifies liveness
 *  itself regardless of what this returns. */
function readEntries(): ServerEntry[] {
  try {
    const raw = readFileSync(discoveryPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isServerEntry) : [];
  } catch {
    return [];
  }
}

/** `writeFileSync` to a `servers.json.tmp.<pid>` sibling, then `renameSync`
 *  over the real path -- never a direct write to `discoveryPath()`.
 *  `rename(2)` replaces its destination atomically on POSIX filesystems, so
 *  a concurrent reader (another process's `liveServers()`, or this same
 *  process's next poll) always observes either the complete prior file or
 *  the complete new one -- never a partial write mid-`JSON.parse`. The tmp
 *  filename is suffixed with THIS process's pid so two servers registering
 *  at the same instant never collide on the same tmp path (each still reads
 *  the other's already-committed entry through the normal read-modify-write
 *  below; only the LAST rename to land wins the read-modify-write race,
 *  which is fine -- see the module doc's "hint, not a contract"). */
function writeEntriesAtomic(entries: ServerEntry[]): void {
  const path = discoveryPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${FILE_NAME}.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(entries));
  renameSync(tmp, path);
}

/**
 * Registers (or, for a pid already present, replaces) this server's entry.
 * Read-modify-write, so two servers registering back to back both survive
 * (each read sees whatever the previous one already committed) -- true
 * same-instant concurrency is resolved by "last rename wins," acceptable
 * because every reader re-verifies liveness anyway (module doc).
 *
 * Best-effort by design, not merely by omission: `buildServer()`
 * (src/mcp.ts) calls this from a fire-and-forget `.then()` on the status
 * endpoint's own URL promise, with no `.catch()` at that call site -- a
 * throw here would become an unhandled rejection and, under this project's
 * pinned Node engines range, crash the entire server process over a
 * best-effort side-channel write. That would violate the one guarantee the
 * whole status feature exists to uphold: observability must never break
 * real work (the same rule `src/status/context.ts`'s `safe()` and the
 * endpoint's degrade-to-null-never-throw posture already enforce
 * elsewhere). A disk full, a read-only `$HOME`, a sandboxed test runner
 * that cannot write outside its workspace -- none of those are reasons to
 * take down a video-extraction server that was otherwise working fine.
 */
export function registerServer(entry: ServerEntry): void {
  try {
    const others = readEntries().filter((e) => e.pid !== entry.pid);
    writeEntriesAtomic([...others, entry]);
  } catch {
    // Best-effort -- see the doc comment above.
  }
}

/** Best-effort removal (spec §7). Called from a synchronous `process.on('exit',
 *  ...)` handler (src/mcp.ts) -- Node forbids async work inside an `exit`
 *  listener entirely, which is exactly what this function's all-sync-fs-calls
 *  shape provides. A crash mid-exit over a discovery-file write would be
 *  strictly worse than leaving a stale entry for the next reader to prune
 *  (every reader already treats every entry as a hint and re-verifies
 *  liveness -- a crash-left entry from an ungraceful exit, e.g. SIGKILL,
 *  which cannot be intercepted at all, is the same shape of staleness this
 *  function's own best-effort failures leave behind on a graceful one). */
export function unregisterServer(pid: number): void {
  try {
    writeEntriesAtomic(readEntries().filter((e) => e.pid !== pid));
  } catch {
    // Best-effort -- see the doc comment above.
  }
}

/** ESRCH ("no such process"): genuinely dead. Anything else -- EPERM (a
 *  process that exists but this one lacks permission to signal, e.g. owned
 *  by another user) or any other unexpected errno -- fails toward "alive".
 *  A live-but-unsignalable process silently vanishing from the CLI would be
 *  a worse failure than one extra poll showing a possibly-stale entry;
 *  §7's own framing ("every reader treats the file as a hint") already
 *  accepts that staleness is possible and cheap to tolerate. `process.kill`
 *  is called as a live property access on every invocation (never cached
 *  into a local binding at module scope), which is what lets a test spy on
 *  it via `vi.spyOn(process, 'kill')`. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Reads the discovery file, liveness-checks every entry, and returns only
 * the live ones. Steady-state read-only (the §7 write-frequency promise
 * this module exists to keep): the file is rewritten if, and only if, this
 * call's own liveness loop found at least one dead entry to drop. A file
 * with zero entries, or with every entry still alive, produces zero writes
 * -- no temp file, no rename, no mtime change -- no matter how many times a
 * CLI's `--watch` loop calls this in a row. (Entries dropped by
 * `readEntries`'s own structural validation do NOT set that flag on their
 * own: that filtering already makes them invisible to every caller without
 * needing a write to enforce it, and conflating "unrecognizable" with
 * "confirmed dead" here would mean a single malformed entry forces a
 * rewrite on every future poll for as long as it keeps reappearing --
 * exactly the steady-state promise this function exists to keep.)
 */
export function liveServers(): ServerEntry[] {
  const entries = readEntries();
  const live: ServerEntry[] = [];
  let prunedAny = false;
  for (const entry of entries) {
    if (isAlive(entry.pid)) live.push(entry);
    else prunedAny = true;
  }
  if (prunedAny) {
    try {
      writeEntriesAtomic(live);
    } catch {
      // Best-effort persistence of the prune -- see registerServer's doc
      // comment for the same reasoning. The in-memory result returned below
      // is correct regardless of whether persisting it succeeded; a failed
      // rewrite just means the next reader re-derives the same prune.
    }
  }
  return live;
}
