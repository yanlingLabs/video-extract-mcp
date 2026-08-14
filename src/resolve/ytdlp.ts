import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VideoResolver, ResolveOptions, ResolveResult, ResolveFailure, CaptionTrack, VideoMetadata } from '../types.js';
import { run } from '../util/run.js';
import { sweepStalePartials } from '../util/partials.js';
import { probe } from '../media/ffmpeg.js';
import { baseLang } from '../transcript/routing.js';
import { statusCallbacks } from '../status/context.js';

export function classifyYtDlpError(stderr: string): ResolveFailure {
  const s = stderr.toLowerCase();
  if (/drm|widevine|protected by drm/.test(s)) {
    return { status: 'unsupported', reason: 'drm_protected', message: 'DRM-protected media', resolvedBy: 'ytdlp' };
  }
  if (/sign in|log in|login required|private video|members-only|age.?restricted|cookies/.test(s)) {
    return { status: 'auth_required', message: 'Authentication required', resolvedBy: 'ytdlp' };
  }
  if (/video unavailable|not available|has been removed|does not exist|404/.test(s)) {
    return { status: 'not_found', message: 'Media not found', resolvedBy: 'ytdlp' };
  }
  if (/unsupported url|no video formats|no suitable extractor/.test(s)) {
    return { status: 'unsupported', reason: 'extractor_unsupported', message: 'No extractor for this URL', resolvedBy: 'ytdlp' };
  }
  // The platform served metadata but refused the media transfer. Deliberately
  // its own status rather than extractor_failed, because the right response is
  // the opposite one: extractor_failed reads terminal ("this video cannot be
  // had"), while this is nearly always temporary and clears on its own.
  //
  // Observed for real: six calls in ~20 seconds against one video, and
  // YouTube began refusing media URLs while extraction kept working. Verified
  // it was throttling rather than anything durable -- freshly-obtained URLs
  // for the very formats that had just 403'd served 206 immediately after, so
  // this is NOT format-specific (an earlier note in docs/follow-ups.md
  // guessed AV1 was the culprit; that guess is now corrected there).
  //
  // Ordered AFTER the auth check on purpose: "Sign in to confirm you're not a
  // bot" is bot-detection too, but cookies genuinely resolve it, so it stays
  // auth_required where the message can say so. A bare 403 has no such remedy.
  //
  // Matched against the WHOLE stderr, not the tail this function returns as
  // its message: with --download-sections the fetch is ffmpeg's, so yt-dlp's
  // own summary line is "ffmpeg exited with code 8" and the informative
  // "Server returned 403 Forbidden" sits further up, outside the last 300
  // characters. Keying on the tail alone would classify the ranged case as a
  // generic failure while the plain case classified correctly.
  if (/http error 403|403: forbidden|403 forbidden|http error 429|429: too many requests|too many requests|rate.?limit/.test(s)) {
    return {
      status: 'rate_limited',
      message: 'The platform served metadata but refused to hand over the media '
        + '(HTTP 403/429). This is usually temporary rate limiting rather than a '
        + 'permanent failure: the same request often succeeds a few minutes later. '
        + 'Retry after a pause, space out repeated requests for the same video, or '
        + 'reuse an already-downloaded file instead of fetching it again.',
      resolvedBy: 'ytdlp',
    };
  }
  // A raw "ffmpeg exited with code N" tells a caller nothing it can act on.
  // Deliberately NOT reported as rate_limited: without a 403/429 anywhere in
  // stderr there is no evidence it was throttling, and claiming otherwise
  // would be a fabricated diagnosis. The message says what is known and what
  // is merely common, and keeps the raw text for a human.
  const ff = /ffmpeg exited with code (\d+)/.exec(s);
  if (ff) {
    return {
      status: 'extractor_failed',
      message: `ffmpeg could not fetch or mux the media (exit ${ff[1]}). On a ranged `
        + 'request ffmpeg performs the download itself, so this most often means the '
        + 'platform refused that fetch -- retrying, or asking for the whole video '
        + `instead of a range, is usually what clears it. Raw: ${stderr.slice(-200).trim()}`,
      resolvedBy: 'ytdlp',
    };
  }
  return { status: 'extractor_failed', message: stderr.slice(-300).trim() || 'yt-dlp failed', resolvedBy: 'ytdlp' };
}

// ---------------------------------------------------------------------------
// Caption acquisition.
//
// Everything below is grounded in the VERIFIED behaviour of the installed
// yt-dlp (2026.7.4; checked in its own source, not assumed):
//  - Subtitle files are written as `<base>.<lang>.<ext>` (utils.subtitles_filename)
//    -- there is NO `.auto.` filename infix, ever, so filenames alone cannot
//    distinguish manual from automatic captions.
//  - With both --write-subs and --write-auto-subs, process_subtitles MERGES
//    the two pools per-language (manual wins a shared language) before
//    selection, so `requested_subtitles` mixes the two kinds.
//  - `--sub-langs` patterns are regexes over the merged pool; the special
//    `all` expands to EVERY available language -- on YouTube the automatic
//    pool includes ~150+ machine-translated tracks, so
//    `--write-auto-subs --sub-langs all` downloads every one of them.
//  - `--print-json` emits the sanitized info dict (nothing removed --
//    sanitize_info with remove_private_keys=False) BEFORE _write_subtitles
//    runs, so the printed `requested_subtitles` has `ext`/`url` but no
//    `filepath`; the on-disk name must be reconstructed as `source.<lang>.<ext>`.
//  - When no format matches --sub-format, yt-dlp falls back to the LAST
//    available format with a warning, so `requested_subtitles[lang].ext` can
//    be something parseVtt cannot read (e.g. json3) and must be checked.
//
// Strategy: the main invocation downloads MANUAL subs only, in all languages
// (`--write-subs --sub-langs all,-live_chat` -- bounded by human effort, and
// it keeps `requested_subtitles` provably manual-only). Automatic captions
// are never bulk-downloaded; instead, when no manual track exists, ONE auto
// track is chosen deliberately from the `automatic_captions` metadata and
// fetched directly (bounded), so `captions.auto` is honest and accurate mode
// keeps its spec §9 accuracy bias (auto is only ever *used* in fast mode).
// ---------------------------------------------------------------------------

interface SubtitleFormat { ext?: string; url?: string; data?: string; name?: string }

/** The slice of yt-dlp's --print-json info dict this resolver reads. */
export interface YtDlpMeta {
  title?: string; extractor?: string; language?: string | null; duration?: number;
  subtitles?: Record<string, SubtitleFormat[]>;
  automatic_captions?: Record<string, SubtitleFormat[]>;
  requested_subtitles?: Record<string, { ext?: string }> | null;
  http_headers?: Record<string, string>;
  chapters?: Array<{ start_time?: number; end_time?: number; title?: string }>;
  description?: string | null;
  uploader?: string | null;
  channel?: string | null;
  upload_date?: string | null;
  view_count?: number | null;
  comment_count?: number | null;
  comments?: unknown[];
}

const PARSEABLE_SUB_EXTS = new Set(['vtt', 'srt']);
const CAPTION_FETCH_TIMEOUT_MS = 30_000;

/**
 * Orders caption languages by deliberate preference (the whole point: never
 * let filesystem/metadata enumeration order decide the transcript language):
 *   1. the caller's preferredLanguage,
 *   2. the platform's own language hint for the video,
 *   3. English,
 *   4. whatever exists (stable input order).
 * Within a tier, a `-orig` variant wins: platforms use it to mark the
 * as-spoken (untranslated) automatic track, which is strictly more faithful
 * than a machine translation of it. Manual tracks never carry `-orig`, so
 * the rule is inert for them.
 */
export function orderByLanguagePreference(
  langs: string[], preferredLanguage?: string | null, languageHint?: string | null,
): string[] {
  const pref = baseLang(preferredLanguage);
  const hint = baseLang(languageHint);
  const tier = (lang: string): number => {
    const b = baseLang(lang);
    if (pref && b === pref) return 0;
    if (hint && b === hint) return 1;
    if (b === 'en') return 2;
    return 3;
  };
  return langs
    .map((lang, i) => ({ lang, i, tier: tier(lang), orig: /-orig$/i.test(lang) ? 0 : 1 }))
    .sort((a, b) => a.tier - b.tier || a.orig - b.orig || a.i - b.i)
    .map((x) => x.lang);
}

/** Spec §9. Chapters compose with range extraction: an agent reads them,
 *  then analyzes only the section that matters. */
export function toVideoMetadata(meta: YtDlpMeta): VideoMetadata {
  const raw = Array.isArray(meta.chapters) ? meta.chapters : [];
  const result: VideoMetadata = {
    title: meta.title ?? '',
    creator: meta.uploader ?? meta.channel ?? null,
    // null, not 0: a duration-less source (live stream, premiere, some
    // non-YouTube extractors) must stay distinguishable from a genuine
    // zero-length measurement (Fix B, task-8) -- resolveTool.ts's
    // durationKnown guard depends on this.
    duration: meta.duration ?? null,
    chapters: raw.map((c) => ({
      start: c.start_time ?? 0,
      end: c.end_time ?? 0,
      title: c.title ?? '',
    })),
    description: meta.description ?? null,
    uploadDate: meta.upload_date ?? null,
    viewCount: meta.view_count ?? null,
    commentCount: meta.comment_count ?? null,
  };
  if (meta.comments !== undefined) result.comments = meta.comments;
  return result;
}

/**
 * Picks the manual caption file from what the main invocation downloaded.
 * `requested_subtitles` is manual-only by construction (the invocation never
 * passes --write-auto-subs), so anything found here is genuinely manual.
 */
export function pickManualCaption(
  workDir: string, meta: YtDlpMeta, preferredLanguage?: string,
): CaptionTrack | null {
  const requested = meta.requested_subtitles ?? {};
  const onDisk = new Map<string, string>();
  for (const [lang, info] of Object.entries(requested)) {
    const ext = info?.ext ?? 'vtt';
    if (!PARSEABLE_SUB_EXTS.has(ext)) continue; // json3/ttml/... -- nothing downstream can read it
    const p = join(workDir, `source.${lang}.${ext}`);
    if (existsSync(p)) onDisk.set(lang, p);
  }
  const best = orderByLanguagePreference([...onDisk.keys()], preferredLanguage, meta.language)[0];
  return best !== undefined ? { path: onDisk.get(best)!, language: baseLang(best) } : null;
}

/** Chooses which automatic track (language + format) is worth fetching. */
export function pickAutoTrack(
  meta: YtDlpMeta, preferredLanguage?: string,
): { lang: string; format: SubtitleFormat } | null {
  const auto = meta.automatic_captions ?? {};
  const langs = Object.keys(auto).filter((l) => l !== 'live_chat');
  for (const lang of orderByLanguagePreference(langs, preferredLanguage, meta.language)) {
    const formats = auto[lang] ?? [];
    const format = formats.find((f) => f.ext === 'vtt' && (f.url || f.data))
      ?? formats.find((f) => f.ext === 'srt' && (f.url || f.data));
    if (format) return { lang, format };
  }
  return null;
}

/**
 * Materializes the chosen automatic track: inline `data` is written as-is;
 * otherwise its URL is fetched with the extractor's own http_headers and a
 * bounded timeout. Best-effort -- any failure degrades to "no auto captions"
 * (ASR still runs), never to a resolver failure.
 */
async function downloadAutoTrack(
  track: { lang: string; format: SubtitleFormat }, headers: Record<string, string> | undefined, workDir: string,
): Promise<CaptionTrack | null> {
  const out = join(workDir, `auto.${track.lang}.${track.format.ext ?? 'vtt'}`);
  try {
    let body = track.format.data;
    if (body === undefined && track.format.url) {
      const res = await fetch(track.format.url, {
        headers, signal: AbortSignal.timeout(CAPTION_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      body = await res.text();
    }
    if (body === undefined) return null;
    writeFileSync(out, body);
    return { path: out, language: baseLang(track.lang) };
  } catch {
    return null;
  }
}

export class YtDlpResolver implements VideoResolver {
  readonly name = 'ytdlp';
  canResolve(url: string): boolean { return /^https?:\/\//i.test(url); }

  async resolve(url: string, opts: ResolveOptions): Promise<ResolveResult> {
    // Spec §2.1: metadata-only is the default. resolveVideoTool always
    // sends an explicit boolean; analyze.ts never sets this field at all
    // (it always wants the media), so the default must be "download" --
    // only an explicit `false` skips the transfer.
    const wantsDownload = opts.returnVideo !== false;

    const out = join(opts.workDir, 'source.%(ext)s');
    const args = [
      '--no-playlist', '--no-warnings',
      '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
      '--merge-output-format', 'mp4',
      // Manual subs only -- deliberately NO --write-auto-subs (see the
      // caption-acquisition block comment above for the verified reasons).
      '--write-subs', '--sub-format', 'vtt', '--sub-langs', 'all,-live_chat',
      '--print-json', '--no-simulate',
      '-o', out,
    ];

    if (!wantsDownload) {
      // Verified directly against the installed yt-dlp's own source
      // (YoutubeDL.py, process_info): `simulate` and `skip_download` are
      // independent params. `simulate` (what --print-json implies unless
      // --no-simulate is passed, hence that flag staying unconditional
      // above) short-circuits BEFORE ANY file is written -- subtitles,
      // thumbnails, infojson, the video itself, all of it:
      //   if self.params.get('simulate'): ...; return
      //   ... (subtitle/thumbnail/infojson writes happen here) ...
      //   if self.params.get('skip_download'): <file-move bookkeeping, no fetch>
      //   else: # Download
      // `skip_download` alone only skips the LAST branch (the actual
      // video/audio byte transfer); `_write_subtitles` and the JSON print
      // both still run normally before it. So --skip-download here is what
      // keeps captions genuinely real while skipping the one genuinely
      // expensive step.
      args.push('--skip-download');
    }

    // Range download is an OPTIMIZATION, never a guarantee (spec §18), and
    // only meaningful when a download is actually happening.
    const wantsRange = wantsDownload && opts.start !== undefined && opts.end !== undefined;
    if (wantsRange) {
      args.push('--download-sections', `*${opts.start}-${opts.end}`, '--force-keyframes-at-cuts');
    }

    // Comments can be very slow on popular videos (spec §2.1).
    if (opts.comments) args.push('--write-comments');

    // §4: fires immediately before the one call that actually moves media
    // bytes -- gated on wantsDownload because --skip-download still reaches
    // this SAME run() call on the metadata-only path (only an added flag),
    // so placement alone cannot gate it the way it can in direct.ts/wechat.ts.
    if (wantsDownload) statusCallbacks()?.onStage?.('downloading');
    // Clear abandoned partials from a previous run that was killed or
    // crashed in this same directory before starting a new one. yt-dlp
    // writes `source.<ext>.part` while downloading and promotes it itself
    // on success, so anything older than the age gate is orphaned bytes
    // nothing will ever finish (src/util/partials.ts).
    if (wantsDownload) sweepStalePartials(opts.workDir);
    const r = await run('yt-dlp', [...args, url], { timeoutMs: 15 * 60_000 });
    if (r.code !== 0) {
      // Deliberately no targeted cleanup here. yt-dlp picks its own
      // filenames, so two calls into one directory produce the SAME names --
      // neither an exact path nor a before/after snapshot can tell our
      // abandoned bytes from a concurrent call's live ones, and an earlier
      // draft that tried destroyed 2.4MB of a running download. Whatever
      // this failure left is collected by the age-gated sweep above on a
      // later call into this directory (src/util/partials.ts).
      return classifyYtDlpError(r.stderr);
    }

    let meta: YtDlpMeta = {};
    const lastJson = r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    if (lastJson) { try { meta = JSON.parse(lastJson) as YtDlpMeta; } catch { /* metadata is optional */ } }

    const manual = pickManualCaption(opts.workDir, meta, opts.preferredLanguage);
    let auto: CaptionTrack | null = null;
    if (!manual) {
      // chooseCaptionTier never consults auto when a manual track exists, so
      // the fetch is only worth its network cost in the manual-less case.
      const track = pickAutoTrack(meta, opts.preferredLanguage);
      if (track) auto = await downloadAutoTrack(track, meta.http_headers, opts.workDir);
    }

    if (!wantsDownload) {
      // No file was ever fetched, so there is nothing to probe() --
      // duration comes from the extractor's own metadata instead. Verified
      // against the installed yt-dlp's youtube extractor
      // (extractor/youtube/_video.py, _real_extract): duration is scraped
      // from video_details/microformats DURING EXTRACTION, wholly
      // independent of the download step, so it is genuine here, not
      // fabricated. filePath is a placeholder: resolveVideoTool never
      // dereferences it unless returnVideo is true.
      return {
        status: 'ok', filePath: '', platform: meta.extractor ?? 'unknown',
        title: meta.title ?? 'video', duration: meta.duration ?? 0, resolvedBy: 'ytdlp',
        captions: { manual, auto },
        languageHint: meta.language ?? null,
        rangeApplied: false,
        metadata: toVideoMetadata(meta),
      };
    }

    const produced = readdirSync(opts.workDir).find((f) => /^source\.(mp4|mkv|webm|m4v)$/.test(f));
    if (!produced) {
      return { status: 'extractor_failed', message: 'yt-dlp produced no media file', resolvedBy: 'ytdlp' };
    }
    const filePath = join(opts.workDir, produced);
    const p = await probe(filePath);

    // VERIFY the range actually applied; caller falls back to ffmpeg trim if not.
    let rangeApplied = false;
    if (wantsRange) {
      const expected = opts.end! - opts.start!;
      rangeApplied = Math.abs(p.duration - expected) <= Math.max(1.5, expected * 0.15);
    }

    return {
      status: 'ok', filePath, platform: meta.extractor ?? 'unknown',
      title: meta.title ?? 'video', duration: p.duration, resolvedBy: 'ytdlp',
      captions: { manual, auto },
      languageHint: meta.language ?? null,
      rangeApplied,
      metadata: toVideoMetadata(meta),
      clipStart: wantsRange && rangeApplied ? opts.start : undefined,
      clipEnd: wantsRange && rangeApplied ? opts.end : undefined,
    };
  }
}
