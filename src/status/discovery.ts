import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
 * Final whole-branch review, Important finding 3: this used to be ONE
 * shared `servers.json`, read-modify-written by every registering server
 * (read the whole array, filter out this pid, append this entry, atomic
 * write-rename). That has an unavoidable race: when N servers start at
 * genuinely the same instant, each one's read sees the SAME prior state
 * (nobody else has committed yet), so each one's own write independently
 * omits every OTHER simultaneous starter -- only the LAST rename to land
 * wins, and every entry it clobbered is never retried (registerServer runs
 * exactly once, at startup). Measured live: 3 simultaneous starts
 * registered 1; 5 registered 4 -- every process genuinely alive, but a
 * loser was invisible to the CLI for its entire life. The original design
 * doc's "every reader re-verifies liveness anyway, so last-writer-wins is
 * fine" reasoning does not actually hold: re-verification can only PRUNE a
 * dead entry that was written, it cannot RESURRECT a live one that a
 * concurrent writer's read-modify-write silently dropped.
 *
 * Fixed by construction, not by retrying: each server owns ONE file, named
 * by its own pid (`<cacheRoot>/servers/<pid>.json`), and only that pid's
 * own process ever writes or removes it. Two servers starting at the exact
 * same instant write to two DIFFERENT paths -- there is no shared mutable
 * state for a read-modify-write to race over any more, at any N, no matter
 * how exactly simultaneous the starts are (a retry-and-reverify scheme on
 * the single-file design would only ever make the race less LIKELY, not
 * impossible, and would get harder to reason about as N grows). The
 * write-once-at-start / remove-once-at-exit / rewritten-by-readers-only-
 * to-prune contract is unchanged -- only the artifact shape is: one file
 * per live server instead of one shared array.
 *
 * `liveServers()` is the one function readers (a CLI, polling on an
 * interval) call repeatedly, so it still carries the feature's
 * write-frequency promise on its own: a poll that finds every entry alive
 * touches disk only to `readdir` and read each file -- no write, no
 * rename, no delete -- for as long as nothing has died. A dead pid's own
 * file is unlinked the instant a reader's liveness check catches it; that
 * unlink can never race another reader's unlink of the SAME file the way
 * the old design's shared-array rewrite could, because a second unlink of
 * an already-gone file is just ENOENT, silently absorbed the same
 * best-effort way every other failure in this module is.
 */
export interface ServerEntry { pid: number; port: number; startedAt: number; version: string }

const SERVERS_DIR_NAME = 'servers';

/**
 * `VIDEO_EXTRACT_CACHE_DIR` -- TEST-FACING. This env var exists so tests can
 * point the whole discovery directory at a throwaway `mkdtemp` directory and
 * never read or write the real machine's home directory; production code
 * never needs to set it. When set, it overrides the CACHE-DIR ROOT (the
 * `~/.cache/video-extract-mcp` part) that `servers/` sits under. Read fresh
 * on every call (never cached at module scope) so a test's `vi.stubEnv`
 * per-`it()` takes effect immediately, including across the many
 * `buildServer()` calls the rest of this codebase's test suite already
 * makes in-process.
 *
 * Mirrors the resolution shape of `VIDEO_EXTRACT_MODELS_DIR`
 * (src/util/models.ts) one level up: that env var points AT a directory
 * directly, this one points at the cache root a sibling directory lives
 * under. No literal home-directory path or OS username ever appears in this
 * source file -- `homedir()` is a runtime call, resolved fresh on whatever
 * machine this actually executes on.
 */
function cacheRootDir(): string {
  const explicit = process.env['VIDEO_EXTRACT_CACHE_DIR']?.trim();
  return explicit ? explicit : join(homedir(), '.cache', 'video-extract-mcp');
}

/** The directory `liveServers()` reads: one `<pid>.json` file per server
 *  that has ever registered and not yet been pruned or removed. Exported so
 *  tests can inspect/seed it directly without duplicating the cache-root
 *  resolution logic above. */
export function serversDir(): string {
  return join(cacheRootDir(), SERVERS_DIR_NAME);
}

/** The exact path a given pid's own entry lives at (or would, once
 *  registered). Exported for tests; no production call site needs this
 *  directly -- registerServer/unregisterServer compute it from the entry
 *  they were already given. */
export function serverFilePath(pid: number): string {
  return join(serversDir(), `${pid}.json`);
}

/** Structural validation for one parsed file's contents. Not gold-plating: a
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

/** Absent file, unreadable file, invalid JSON, or JSON that isn't a
 *  recognizable ServerEntry -- every one of those reads as `null`, never
 *  throws. A single corrupt/foreign file affects only ITS OWN pid's entry
 *  (unlike the old shared-array design, where one malformed element sat
 *  alongside every other server's own entry in the same parse); every real
 *  reader (this module's own `liveServers`, and Task 6's CLI on top of it)
 *  re-verifies liveness itself regardless of what this returns. */
function readEntry(path: string): ServerEntry | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isServerEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `writeFileSync` to a `<pid>.json.tmp` sibling, then `renameSync` over the
 *  real path -- never a direct write to the final path. `rename(2)` replaces
 *  its destination atomically on POSIX filesystems, so a concurrent reader
 *  (another process's `liveServers()`, or this same process's next poll)
 *  always observes either the complete prior file or the complete new one --
 *  never a partial write mid-`JSON.parse`. The tmp filename already embeds
 *  THIS entry's own pid (it is a sibling of `<pid>.json` itself), so it is
 *  unique across every OTHER process without needing an extra suffix -- and
 *  because it lives in the pid's own file, not a shared one, there is no
 *  read-modify-write here to race in the first place (see the module doc). */
function writeEntryAtomic(entry: ServerEntry): void {
  const dir = serversDir();
  mkdirSync(dir, { recursive: true });
  const path = serverFilePath(entry.pid);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry));
  renameSync(tmp, path);
}

/**
 * Registers (or, for a pid already registered, replaces) this server's own
 * entry -- a single-file write, never a read-modify-write over every other
 * server's entry, which is what removes the simultaneous-start race
 * entirely rather than merely narrowing it (see the module doc).
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
    writeEntryAtomic(entry);
  } catch {
    // Best-effort -- see the doc comment above.
  }
}

/** Best-effort removal (spec §7). Called from a synchronous `process.on('exit',
 *  ...)` handler (src/mcp.ts) -- Node forbids async work inside an `exit`
 *  listener entirely, which is exactly what this function's all-sync-fs-call
 *  shape provides. A crash mid-exit over a discovery-file write would be
 *  strictly worse than leaving a stale entry for the next reader to prune
 *  (every reader already treats every entry as a hint and re-verifies
 *  liveness -- a crash-left entry from an ungraceful exit, e.g. SIGKILL,
 *  which cannot be intercepted at all, is the same shape of staleness this
 *  function's own best-effort failures leave behind on a graceful one). An
 *  unregister for a pid that was never registered (or already removed) is
 *  just ENOENT, absorbed the same best-effort way as every other failure. */
export function unregisterServer(pid: number): void {
  try {
    unlinkSync(serverFilePath(pid));
  } catch {
    // Best-effort -- see the doc comment above.
  }
}

/** ESRCH ("no such process"): genuinely dead. Anything else -- EPERM (a
 *  process that exists but this one lacks permission to signal, e.g. owned
 *  by another user) or any other unexpected errno -- fails toward "alive".
 *  A live-but-unsignalable process silently vanishing from the CLI would be
 *  a worse failure than one extra poll showing a possibly-stale entry;
 *  §7's own framing ("every reader treats each entry as a hint") already
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
 * Lists every registered entry, liveness-checks each one, and returns only
 * the live ones. Steady-state read-only (the §7 write-frequency promise
 * this module exists to keep): a poll that finds every registered pid still
 * alive touches disk only to `readdir` the directory and `readFileSync`
 * each entry -- no write, no rename, no delete -- no matter how many times
 * a CLI's `--watch` loop calls this in a row. A dead pid's own file is
 * unlinked the moment THIS call's liveness check catches it; that removal
 * can never race a concurrent reader's own unlink of the same file (a
 * second unlink of an already-gone file is just ENOENT, best-effort
 * absorbed), and it can never affect any OTHER pid's file, because every
 * entry lives in its own file (see the module doc for why that is what
 * closes the simultaneous-registration race too). An absent `servers/`
 * directory (nothing has ever registered) reads as `[]`, never throws; a
 * stray non-`.json` file (e.g. a `<pid>.json.tmp` left behind by a process
 * that crashed mid-write, between `writeFileSync` and `renameSync`) is
 * skipped, not parsed -- the same "hint, not a contract" tolerance the old
 * single-file design already applied to malformed array elements.
 */
export function liveServers(): ServerEntry[] {
  let names: string[];
  try {
    names = readdirSync(serversDir());
  } catch {
    return [];
  }
  const live: ServerEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // skip stray .tmp leftovers, never parse them
    const path = join(serversDir(), name);
    const entry = readEntry(path);
    if (!entry) continue; // corrupt or foreign file -- a hint, not a contract
    if (isAlive(entry.pid)) {
      live.push(entry);
    } else {
      try {
        unlinkSync(path);
      } catch {
        // Best-effort persistence of the prune -- see registerServer's doc
        // comment for the same reasoning. The in-memory result returned
        // below is correct regardless of whether the unlink succeeded; a
        // failed unlink just means the next reader re-derives the same
        // prune.
      }
    }
  }
  return live;
}
