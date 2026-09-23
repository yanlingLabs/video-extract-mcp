import { mkdirSync, readdirSync, rmSync, renameSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { opendir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

/**
 * Scratch space for one analyze item, and the delivery of its results.
 *
 * The pipeline produces far more than it returns. A 40-frame request extracts
 * every scene-boundary candidate first and only then filters and selects --
 * one real run wrote 258 JPEGs to deliver 40 -- and 'key' mode additionally
 * writes a normalized re-encode alongside the original download. Pointed
 * straight at `destinationPath`, all of that became the caller's problem:
 * 390 MB and 258 images for a result that was 40 images and a transcript.
 *
 * So work happens in a private `.work-<pid>-<n>` directory and only the
 * deliverables are moved out.
 *
 * ## Why inside destinationPath rather than os.tmpdir()
 *
 * Two reasons, both load-bearing:
 *
 *  - **Same filesystem.** Delivery is then a `rename`, which is instant and
 *    costs no disk. From a temp directory on another volume it degrades to
 *    copying the whole video -- hundreds of megabytes, twice on disk at the
 *    moment of the copy, for every single call.
 *  - **The status channel keeps working.** `/status` reports progress as
 *    `workDirBytes`, sampled by walking `destinationPath`
 *    (src/status/endpoint.ts). That walk is recursive with an entry-count
 *    cap, not a depth limit, so bytes landing in `.work` are still counted
 *    and "is the download moving?" still answers itself. Moving the work to
 *    os.tmpdir() would silently flatline that number while the download ran.
 */

let counter = 0;

/** `.work-<pid>-<n>`: the pid makes abandonment detectable, `n` keeps two
 *  concurrent calls in one process from sharing a directory. */
const WORK_DIR_RE = /^\.work-(\d+)-\d+$/;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Removes `.work` directories left by runs that are no longer running,
 * returning how many went.
 *
 * This is the crash/kill/power-cut path, and it is why the directory name
 * carries a pid. Nothing else can collect these: the age-gated sweep in
 * src/util/partials.ts only ever looks at the directory a download lands in,
 * which is now the abandoned `.work` itself rather than a shared one -- so
 * without this, every killed run's scratch (a full video, hundreds of
 * frames) would sit in the caller's output directory forever.
 *
 * Keyed on pid liveness rather than an age gate, matching
 * src/status/discovery.ts's handling of its own per-pid files. That is the
 * right instrument HERE, unlike for partials: a `.work` name is minted by
 * exactly one call and shared with nobody, so "the process that owned this
 * is gone" is a complete answer and needs no waiting period. A live pid is
 * always left alone, which is what makes concurrent calls into one
 * destinationPath safe.
 */
export function sweepAbandonedWorkDirs(itemDir: string): number {
  let removed = 0;
  let entries: string[];
  try { entries = readdirSync(itemDir); } catch { return 0; }
  for (const name of entries) {
    const m = WORK_DIR_RE.exec(name);
    if (!m) continue;
    if (isAlive(Number(m[1]))) continue;   // another live call owns it
    try {
      const p = join(itemDir, name);
      if (statSync(p).isDirectory()) { rmSync(p, { recursive: true, force: true }); removed++; }
    } catch { /* vanished or unreadable -- nothing to do */ }
  }
  return removed;
}

/** Creates this call's private scratch directory inside `itemDir`. */
export function mintWorkDir(itemDir: string): string {
  const dir = join(itemDir, `.work-${process.pid}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Removes this call's own scratch directory.
 *
 * Eager and unconditional, on success and failure alike -- deliberately NOT
 * age-gated the way src/util/partials.ts is. That rule exists because yt-dlp
 * picks its own filenames and two calls into one directory produce the same
 * ones, so nothing can tell abandoned bytes from a sibling's live ones. A
 * `.work-<pid>-<n>` name is minted by this call and held by no other, which
 * is precisely the exception partials.ts already carves out for
 * `discardPartial`. Best-effort: a failed delete never fails a call.
 */
export function discardWorkDir(workDir: string): void {
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Moves one produced file out of the scratch directory into `itemDir`,
 * returning its new path. Rename first (same filesystem, instant), copy as
 * the fallback. A source that is already outside the scratch directory, or
 * has vanished, is returned untouched.
 */
export function deliverFile(itemDir: string, workDir: string, from: string): string {
  if (!from || !from.startsWith(workDir) || !existsSync(from)) return from;
  const to = join(itemDir, basename(from));
  if (to === from) return from;
  try { renameSync(from, to); } catch { copyFileSync(from, to); }
  return to;
}

/** What resolve_video's mkdtempSync(join(tmpdir(), 'norma-res-')) named its
 *  directories before 0.14.0. Exact: `norma-res-` plus mkdtemp's 6 characters. */
const LEGACY_RESOLVE_DIR_RE = /^norma-res-[A-Za-z0-9]{6}$/;
const LEGACY_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Removes the `norma-res-*` directories resolve_video left in os.tmpdir()
 * before 0.14.0 -- one per call, never cleaned up (523 of them, 32 MB, on the
 * machine that found it). Nothing creates them any more, so this is a
 * clean-up of history, run once at server start.
 *
 * Age-gated at 24 hours, the same reasoning as src/util/partials.ts: an older
 * server version may still be running and using one right now, and nothing
 * here can tell. A resolve cannot plausibly take a day (yt-dlp is given 15
 * minutes), and a directory's mtime moves whenever a file inside is created.
 * Async and abortable: a temp directory can hold hundreds of thousands of
 * entries, and server shutdown must never wait on this.
 */
export async function sweepLegacyResolveTempDirs(
  opts: { dir?: string; now?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const dir = opts.dir ?? tmpdir();
  const now = opts.now ?? Date.now();
  let removed = 0;
  try {
    for await (const entry of await opendir(dir)) {
      if (opts.signal?.aborted) break;
      if (!entry.isDirectory() || !LEGACY_RESOLVE_DIR_RE.test(entry.name)) continue;
      const p = join(dir, entry.name);
      try {
        if (now - (await stat(p)).mtimeMs < LEGACY_MIN_AGE_MS) continue;
        await rm(p, { recursive: true, force: true });
        removed++;
      } catch { /* vanished or unreadable -- nothing to do */ }
    }
  } catch { /* unreadable temp directory -- best-effort */ }
  return removed;
}
