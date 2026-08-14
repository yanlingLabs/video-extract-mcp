import { readdirSync, statSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Partial-download hygiene.
 *
 * A download that dies mid-flight leaves bytes on disk, and only one of the
 * two failure shapes can clean up after itself:
 *
 *  - An in-process failure (HTTP error, stall, timeout, non-zero exit) --
 *    the resolver's own catch runs, so it deletes exactly what it wrote.
 *  - The process being killed (an agent killing a stuck child, a crash, a
 *    machine losing power) -- NO code of ours runs. Whatever is on disk
 *    stays, and for URL sources that disk is the caller's destinationPath.
 *
 * The second shape is why a partial must be written under a name that is
 * recognisably incomplete: a killed transfer must never leave something
 * that looks like a finished `source.mp4`.
 *
 * ## Why the pattern is anchored to `source.`, not to `.part`
 *
 * `.part` is a shared ecosystem convention, not this tool's namespace --
 * Firefox names paused downloads `<file>.part`, and so does a user's own
 * yt-dlp run. Matching a bare `.part` suffix inside the caller's own
 * directory would delete their files. Everything this tool downloads is
 * named from the `source.%(ext)s` template, so anchoring on that prefix is
 * what makes "ours by construction" actually true rather than merely
 * asserted. The pattern also covers yt-dlp's fragment and resume litter
 * (`…-Frag12`, `….ytdl`), which a bare `.part` test misses entirely.
 */

/** Files this tool's own downloads leave behind, and nothing else. */
const OURS = /^source\.[^/]*\.part$|^source\.[^/]*\.part-Frag\d+$|^source\.[^/]*\.ytdl$/;

/**
 * How old an abandoned partial must be before a sweep will remove it.
 *
 * A sweep runs when a download enters a directory, and a *different* call
 * may be mid-download in that same directory right now. The age gate is the
 * only thing standing between this sweep and that call's live bytes, so it
 * is deliberately far longer than any legitimate download: anything older
 * cannot belong to a run still making progress. There is deliberately NO
 * "sweep everything" mode -- an age-blind directory sweep cannot distinguish
 * an abandoned partial from a sibling's live one.
 */
export const STALE_PARTIAL_AGE_MS = 6 * 60 * 60_000;

let counter = 0;

/**
 * A per-call in-flight name for a final output path.
 *
 * Unique per call (pid + counter), so two calls downloading into the same
 * directory never share a partial. Without that, the faster call promotes
 * the shared file and the slower one's promote fails -- and its failure
 * path would then delete a file the tool had already returned as a success.
 */
export function partialPathFor(finalPath: string): string {
  return `${finalPath}.${process.pid}-${++counter}.part`;
}

/** Atomically promote a completed download to its final name. */
export function promotePartial(partialPath: string, finalPath: string): void {
  renameSync(partialPath, finalPath);
}

/** Removes one specific partial. Best-effort: already gone is success. */
export function discardPartial(partialPath: string): void {
  try { rmSync(partialPath, { force: true }); } catch { /* nothing to do */ }
}

/**
 * Removes THIS tool's abandoned partials from one directory, returning how
 * many went. Non-recursive, so per-item `video-N/` subdirectories are never
 * touched from the parent. Only files older than `maxAgeMs` are eligible.
 *
 * Best-effort throughout: a missing directory, an unreadable entry, a file
 * that vanishes mid-sweep, or a directory that happens to match the pattern
 * are all normal, never a reason to fail a call. Returns 0 rather than
 * throwing.
 */
export function sweepStalePartials(dir: string, maxAgeMs = STALE_PARTIAL_AGE_MS): number {
  let removed = 0;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return 0; }
  const cutoff = Date.now() - Math.max(maxAgeMs, 0);
  for (const name of entries) {
    if (!OURS.test(name)) continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (!st.isFile() || st.mtimeMs > cutoff) continue;
      rmSync(p, { force: true });
      removed++;
    } catch { /* vanished, unreadable, or a directory -- leave it */ }
  }
  return removed;
}

/**
 * Snapshots this tool's partial files in a directory, returning a function
 * that removes only the ones that appeared afterwards.
 *
 * This is how a failing download abandons its own bytes immediately without
 * an age-blind sweep: yt-dlp picks its own partial filenames (extension
 * depends on the format it chose), so the exact path is not knowable in
 * advance -- but the difference between before and after is.
 */
export function trackNewPartials(dir: string): () => number {
  const before = new Set<string>();
  try { for (const n of readdirSync(dir)) if (OURS.test(n)) before.add(n); } catch { /* new dir */ }
  return () => {
    let removed = 0;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return 0; }
    for (const name of entries) {
      if (!OURS.test(name) || before.has(name)) continue;
      try {
        if (!statSync(join(dir, name)).isFile()) continue;
        rmSync(join(dir, name), { force: true });
        removed++;
      } catch { /* best-effort */ }
    }
    return removed;
  };
}
