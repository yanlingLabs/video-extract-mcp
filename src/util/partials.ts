import { readdirSync, statSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Partial-download hygiene.
 *
 * A download that dies mid-flight leaves bytes on disk, and only one of the
 * two failure shapes can clean up after itself:
 *
 *  - An in-process failure (HTTP error, stall, timeout, non-zero exit) --
 *    the resolver's own catch runs.
 *  - The process being killed (an agent killing a stuck child, a crash, a
 *    machine losing power) -- NO code of ours runs. Whatever is on disk
 *    stays, and for URL sources that disk is the caller's destinationPath.
 *
 * The second shape is why a partial must be written under a name that is
 * recognisably incomplete: a killed transfer must never leave something
 * that looks like a finished `source.mp4`.
 *
 * ## Two rules, each of which cost a real bug to learn
 *
 * **The pattern is anchored to `source.`, not to `.part`.** `.part` is a
 * shared ecosystem convention -- Firefox names paused downloads
 * `<file>.part`, and so does a user's own yt-dlp run. Matching a bare
 * `.part` suffix inside the caller's directory deletes THEIR files, while
 * simultaneously missing yt-dlp's real litter (fragments, resume data, and
 * the per-format and temp files a merge leaves). Everything this tool
 * downloads comes from the `source.%(ext)s` template, so anchoring there is
 * what makes "ours by construction" true rather than merely asserted.
 *
 * **Cleanup is age-gated, always, with no exceptions and no override.**
 * A directory sweep cannot tell an abandoned partial from a *different
 * call's live one* -- and neither can a before/after snapshot, because
 * yt-dlp picks its own filenames and two calls into one directory produce
 * the same names. An earlier draft tried to be cleverer and destroyed
 * 2.4 MB of a concurrent download. So: a failing call removes only a path
 * whose exact name it minted itself (`discardPartial`), and everything else
 * waits for the age gate. The cost is that a killed yt-dlp's bytes linger
 * until the next download into that directory finds them old enough; that
 * is the price of never touching live bytes, and it is the right trade.
 */

/**
 * Files this tool's own downloads leave behind, and nothing else:
 *  - `source.mp4.1234-1.part`      an in-flight download (ours or yt-dlp's)
 *  - `source.f137.mp4.part-Frag12` an in-flight fragment
 *  - `source.f137.mp4.ytdl`        yt-dlp resume state
 *  - `source.f137.mp4`             a per-format file a merge never consumed
 *  - `source.faud-English.mp4`     the same, with a non-numeric format id
 *  - `source.temp.mp4`             a half-written mux
 *
 * The last three carry ordinary media extensions, which is exactly why they
 * matter: a killed merge leaves a truncated `source.temp.mp4` -- the shape
 * this whole module exists to keep out of a caller's directory.
 *
 * Those are matched on `source.<anything>.<media extension>` rather than on
 * the format id's shape, because real format ids are not numeric
 * (`faud-English`, `251-drc`, `play_addr`) -- but widening the id charset
 * instead would swallow `source.fr.vtt`, a genuine subtitle output. The
 * media-extension allowlist is what keeps captions and manifests out of
 * range while still catching every format id yt-dlp can mint.
 */
const OURS = new RegExp(
  '^source\\.[^/]*\\.part$'
  + '|^source\\.[^/]*\\.part-Frag\\d+$'
  + '|^source\\.[^/]*\\.ytdl$'
  + '|^source\\.[^./]+\\.(?:mp4|m4v|mov|mkv|webm|ts|m4a|aac|opus|mp3|flac|wav)$',
);

/**
 * How old an abandoned partial must be before a sweep removes it.
 *
 * Deliberately far longer than any legitimate download: it is the only
 * thing standing between a sweep and a concurrent call's live bytes.
 * Deliberately NOT a parameter -- an earlier draft exposed an override, a
 * caller passed 0 for "clean up after myself", and it deleted a sibling's
 * in-flight download. There is no safe value below this.
 */
export const STALE_PARTIAL_AGE_MS = 6 * 60 * 60_000;

let counter = 0;

/**
 * A per-call in-flight name for a final output path.
 *
 * Unique per call (pid + counter) so two calls downloading into the same
 * directory never share a partial. Without that, the faster call promotes
 * the shared file and the slower one's failed promote would delete a file
 * the tool had already returned to its caller as a success.
 */
export function partialPathFor(finalPath: string): string {
  return `${finalPath}.${process.pid}-${++counter}.part`;
}

/** Atomically promote a completed download to its final name. */
export function promotePartial(partialPath: string, finalPath: string): void {
  renameSync(partialPath, finalPath);
}

/**
 * Removes one partial by exact path. Safe precisely because the caller
 * minted that name itself via `partialPathFor` -- no other call can hold
 * it. Best-effort: already gone is success.
 */
export function discardPartial(partialPath: string): void {
  try { rmSync(partialPath, { force: true }); } catch { /* nothing to do */ }
}

/**
 * Removes THIS tool's abandoned download artifacts from one directory,
 * returning how many went. Non-recursive, so per-item `video-N/`
 * subdirectories are never touched from the parent. Only entries older than
 * STALE_PARTIAL_AGE_MS are eligible.
 *
 * Best-effort throughout: a missing directory, an unreadable entry, a file
 * that vanishes mid-sweep, or a directory matching the pattern are all
 * normal, never a reason to fail a call. Returns 0 rather than throwing.
 */
export function sweepStalePartials(dir: string): number {
  let removed = 0;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return 0; }
  const cutoff = Date.now() - STALE_PARTIAL_AGE_MS;
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
