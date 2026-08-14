import { unlink } from 'node:fs/promises';
import { partialPathFor, promotePartial, discardPartial, sweepStalePartials } from '../util/partials.js';
import { join } from 'node:path';
import type { VideoResolver, ResolveOptions, ResolveResult } from '../types.js';
import { probe } from '../media/ffmpeg.js';
import { run } from '../util/run.js';
import { fetchToFile, MEDIA_DOWNLOAD_TIMEOUT_MS } from '../util/download.js';
import { statusCallbacks } from '../status/context.js';

const MEDIA_EXT = /\.(mp4|m4v|mov|mkv|webm|m3u8|mpd|ts)(\?|#|$)/i;

export class DirectMediaResolver implements VideoResolver {
  readonly name = 'direct';
  canResolve(url: string): boolean { return MEDIA_EXT.test(url); }

  async resolve(url: string, opts: ResolveOptions): Promise<ResolveResult> {
    if (opts.returnVideo === false) {
      // No metadata layer exists for a direct media URL (unlike yt-dlp,
      // there is no separate extraction/info step): the URL IS the media,
      // so the only way to learn anything -- even whether it is reachable
      // -- is to fetch it. Do not download just to populate fields; return
      // only what the URL string itself yields. duration:0/filePath:'' are
      // ResolvedMedia's required-by-type placeholders, not measurements --
      // resolveVideoTool.ts never dereferences filePath, and omits
      // duration from the agent-facing reply, when no transfer happened.
      return {
        status: 'ok', filePath: '', platform: 'direct',
        title: url.split('/').pop() ?? 'video', duration: 0,
        resolvedBy: 'direct', captions: { manual: null, auto: null },
        languageHint: null, rangeApplied: false,
      };
    }
    const out = join(opts.workDir, 'source.mp4');
    // Written under `<out>.part` and promoted only once the bytes are all
    // there, so a killed process can never leave something that LOOKS like
    // a finished source.mp4 (src/util/partials.ts). The in-process failure
    // paths below still unlink explicitly -- this covers the shape where
    // none of our code gets to run at all.
    const partial = partialPathFor(out);
    let promoted = false;
    sweepStalePartials(opts.workDir);
    try {
      // §4: gated structurally, not by an explicit condition here -- the
      // opts.returnVideo === false branch above already returned before
      // this point, so reaching this line at all means a real transfer is
      // about to happen. One emit covers both sub-branches below (ffmpeg
      // mux and fetchToFile), since both genuinely move media bytes.
      statusCallbacks()?.onStage?.('downloading');
      // HLS/DASH manifests must be muxed by ffmpeg, not byte-copied. Bounded
      // like every other subprocess: a stalled origin used to hang this mux
      // (and analyze_video with it) forever.
      if (/\.(m3u8|mpd)(\?|#|$)/i.test(url)) {
        const r = await run('ffmpeg', ['-y', '-i', url, '-f', 'mp4', '-c', 'copy', partial], { timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS });
        if (r.code !== 0) {
          // A failed mux can leave a partial file behind -- this return path
          // bypasses the catch below, so it must clean up itself.
          discardPartial(partial);
          return { status: 'extractor_failed', message: `ffmpeg could not fetch stream: ${r.stderr.slice(-300)}` };
        }
      } else {
        const dl = await fetchToFile(url, partial); // bounded: stalls abort into the catch below
        if (!dl.ok) {
          // Every non-ok return bypasses the catch below, so each must
          // clean up the partial itself.
          discardPartial(partial);
          if (dl.status === 401 || dl.status === 403) {
            return { status: 'auth_required', message: `HTTP ${dl.status} fetching media` };
          }
          if (dl.status === 404) return { status: 'not_found', message: 'HTTP 404' };
          return { status: 'extractor_failed', message: `HTTP ${dl.status}` };
        }
      }
      promotePartial(partial, out);
      promoted = true;
      const p = await probe(out);
      return {
        status: 'ok', filePath: out, platform: 'direct',
        title: url.split('/').pop() ?? 'video', duration: p.duration,
        resolvedBy: 'direct', captions: { manual: null, auto: null },
        languageHint: null, rangeApplied: false,
      };
    } catch (e) {
      // Only ever our own partial. `out` is deleted ONLY if this call is the
      // one that promoted it -- a concurrent call may have written that file
      // and already returned it to its caller as a success, and a
      // pre-existing source.mp4 from an earlier run is the caller's too.
      discardPartial(partial);
      if (promoted) await unlink(out).catch(() => {});
      return { status: 'extractor_failed', message: (e as Error).message };
    }
  }
}
