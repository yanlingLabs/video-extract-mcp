import { readdirSync, statSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Partial-download hygiene.
 *
 * A download that dies mid-flight leaves bytes on disk. Two distinct
 * failure shapes produce them, and only one of them can clean up after
 * itself:
 *
 *  - An in-process failure (HTTP error, stall, timeout, non-zero exit) --
 *    the resolver's own catch runs, so it can delete what it wrote.
 *  - The process being killed (an agent killing a stuck child per the
 *    documented stop-a-job workflow, a crash, a machine losing power) --
 *    NO code of ours runs. Whatever is on disk stays there forever, and
 *    for URL sources that disk is the caller's own destinationPath.
 *
 * The second shape is why every partial must be written under a name that
 * is *recognisably* incomplete. yt-dlp already does this natively
 * (`source.<ext>.part`); `partialPathFor`/`promotePartial` give the direct
 * and WeChat resolvers the same property, so a killed download can never
 * leave something that looks like a finished `source.mp4`.
 *
 * This does NOT relax the rule that the tool never deletes a caller's
 * artifacts. A `.part` file is not an artifact -- by construction it is an
 * unfinished intermediate of ours that happens to live in the caller's
 * directory because, for URL sources, the working directory IS
 * destinationPath. Manifests, transcripts, frames and completed media are
 * never touched by anything here.
 */

/** Suffix marking a download still in flight. Matches yt-dlp's own convention. */
export const PARTIAL_SUFFIX = '.part';

/**
 * How old a `.part` file must be before a sweep will remove it. A sweep
 * runs at the start of a call, and a *concurrent* call may legitimately be
 * mid-download in the same directory right now -- the age gate is what
 * keeps this from deleting live bytes out from under it. Comfortably
 * longer than the media download timeout, so anything older cannot belong
 * to a run that is still making progress.
 */
export const STALE_PARTIAL_AGE_MS = 6 * 60 * 60_000;

/** The in-flight name for a final output path. */
export function partialPathFor(finalPath: string): string {
  return `${finalPath}${PARTIAL_SUFFIX}`;
}

/** Atomically promote a completed download to its final name. */
export function promotePartial(finalPath: string): void {
  renameSync(partialPathFor(finalPath), finalPath);
}

/**
 * Removes abandoned `.part` files from one directory, returning how many
 * went. Only files older than `maxAgeMs` are eligible, so a live download
 * in the same directory is never disturbed.
 *
 * Best-effort throughout: a missing directory, an unreadable entry or a
 * file that vanishes between the scan and the unlink are all normal (a
 * concurrent sweep, a caller tidying up), never a reason to fail a call.
 * Returns 0 rather than throwing.
 */
export function sweepStalePartials(dir: string, maxAgeMs = STALE_PARTIAL_AGE_MS): number {
  let removed = 0;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return 0; }
  // maxAgeMs <= 0 means "age is irrelevant, take them all" -- expressed as
  // intent rather than arithmetic because it cannot be expressed as
  // arithmetic: mtimeMs carries sub-millisecond precision while Date.now()
  // truncates to whole milliseconds, so a file written microseconds ago can
  // compare as NEWER than a cutoff of `Date.now() - 0` and survive a sweep
  // that explicitly asked for everything.
  const sweepAll = maxAgeMs <= 0;
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    if (!name.endsWith(PARTIAL_SUFFIX)) continue;
    const p = join(dir, name);
    try {
      if (!sweepAll && statSync(p).mtimeMs > cutoff) continue;
      rmSync(p, { force: true });
      removed++;
    } catch { /* vanished or unreadable -- nothing to do */ }
  }
  return removed;
}
