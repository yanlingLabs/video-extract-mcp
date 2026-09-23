import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  VideoResolver, ResolveOptions, ResolveResult, ResolveFailure, CaptionTrack, Captions, VideoMetadata, CookieUse,
} from '../types.js';
import { run } from '../util/run.js';
import { sweepStalePartials } from '../util/partials.js';
import {
  cookieSourceFromEnv, prepareCookies,
  CookieConfigError, type PreparedCookies, type CookieSource,
} from '../util/cookies.js';
import { browserForCall, browserLabel, userCookiesHint } from '../util/browsers.js';
import { siteHost } from '../util/signInPage.js';
import { rangePastEnd } from '../util/range.js';
import { waitForSiteSignIn, MAX_RETRIES, DECLINED_MESSAGE, type SiteSignInDeps } from './siteSignIn.js';
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
  // Debug lines are dropped before the tail is taken: --verbose (added for
  // ranged downloads above) otherwise fills the last 300 characters with a
  // Python traceback and buries whatever actually went wrong.
  const meaningful = stderr.split('\n')
    .filter((l) => !/^\s*\[debug\]/.test(l) && !/^\s+File "/.test(l) && !/^\s+self\./.test(l))
    .join('\n');
  return {
    status: 'extractor_failed',
    message: meaningful.slice(-300).trim() || stderr.slice(-300).trim() || 'yt-dlp failed',
    resolvedBy: 'ytdlp',
  };
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
// fetched directly, so `captions.auto` is honest about what it is. Whichever
// track exists is then used ahead of local speech recognition
// (chooseCaptionTier, src/transcript/captions.ts).
//
// A caption track the platform offers must never be lost quietly:
//  - The auto track is fetched the moment `--print-json` prints the info
//    dict, which is BEFORE the media download starts (measured: 1.3s into a
//    run whose download then took 92s). Fetching after the download instead
//    lost a real Portuguese track to throttling on a run whose metadata-only
//    twin fetched the same track in 194ms.
//  - Throttling, server errors and timeouts are retried with backoff, and a
//    body that is not a caption file counts as a failure, not a track.
//  - yt-dlp aborts the WHOLE run when a manual subtitle download fails
//    (YoutubeDL._write_subtitles raises DownloadError). That run is repeated
//    without subtitles and the manual track fetched directly, so a throttled
//    caption can no longer fail an analysis that speech recognition can
//    still complete.
//  - Whatever still fails is recorded in `captions.retrievalErrors`, which is
//    what lets analyze.ts say "captions failed" rather than "no captions".
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

export interface TrackChoice { lang: string; format: SubtitleFormat }

function pickTrack(
  pool: Record<string, SubtitleFormat[]> | undefined, meta: YtDlpMeta, preferredLanguage?: string,
): TrackChoice | null {
  const tracks = pool ?? {};
  const langs = Object.keys(tracks).filter((l) => l !== 'live_chat');
  for (const lang of orderByLanguagePreference(langs, preferredLanguage, meta.language)) {
    const formats = tracks[lang] ?? [];
    const format = formats.find((f) => f.ext === 'vtt' && (f.url || f.data))
      ?? formats.find((f) => f.ext === 'srt' && (f.url || f.data));
    if (format) return { lang, format };
  }
  return null;
}

/** Chooses which automatic track (language + format) is worth fetching. */
export function pickAutoTrack(meta: YtDlpMeta, preferredLanguage?: string): TrackChoice | null {
  return pickTrack(meta.automatic_captions, meta, preferredLanguage);
}

/** The manual track to fetch directly when yt-dlp itself failed to write it. */
export function pickManualTrack(meta: YtDlpMeta, preferredLanguage?: string): TrackChoice | null {
  return pickTrack(meta.subtitles, meta, preferredLanguage);
}

export type CaptionFetch = { track: CaptionTrack } | { error: string };

const CAPTION_RETRY_DELAYS_MS = [2_000, 5_000];
const MAX_RETRY_AFTER_MS = 15_000;

/** Every cue in both VTT and SRT carries a `-->` timing line; an HTML error
 *  page, a consent wall or an empty body does not. */
const looksLikeCaptions = (body: string): boolean => body.includes('-->');

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/**
 * Materializes one chosen track: inline `data` is written as-is; otherwise
 * its URL is fetched with the extractor's own http_headers. Throttling (429),
 * server errors and network failures/timeouts are retried with backoff --
 * honouring a short Retry-After -- because they are exactly the transient
 * failures that used to cost a video its captions. Never throws: a failure
 * comes back as a human-readable `error` naming the track and the cause, so
 * the caller can report it instead of mistaking it for "no captions".
 */
export async function fetchCaptionTrack(
  choice: TrackChoice, headers: Record<string, string> | undefined, workDir: string,
  kind: 'manual' | 'automatic', signal?: AbortSignal,
): Promise<CaptionFetch> {
  const what = `${kind} captions (${choice.lang})`;
  const out = join(workDir, `${kind === 'manual' ? 'manual' : 'auto'}.${choice.lang}.${choice.format.ext ?? 'vtt'}`);
  const save = (body: string): CaptionFetch => {
    if (!looksLikeCaptions(body)) return { error: `${what} could not be retrieved: the response was not a caption file` };
    try {
      writeFileSync(out, body);
    } catch (e) {
      return { error: `${what} could not be saved: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { track: { path: out, language: baseLang(choice.lang) } };
  };
  if (choice.format.data !== undefined) return save(choice.format.data);
  const url = choice.format.url;
  if (!url) return { error: `${what} could not be retrieved: the platform gave no address for it` };

  const attempts = CAPTION_RETRY_DELAYS_MS.length + 1;
  let last = '';
  let made = 0;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return { error: `${what} could not be retrieved: cancelled` };
    made++;
    let wait = CAPTION_RETRY_DELAYS_MS[i] ?? 0;
    try {
      const timeout = AbortSignal.timeout(CAPTION_FETCH_TIMEOUT_MS);
      const res = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (res.ok) return save(await res.text());
      last = `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break; // a 403/404 will not change on retry
      const retryAfter = res.headers.has('retry-after') ? Number(res.headers.get('retry-after')) : NaN;
      if (Number.isFinite(retryAfter) && retryAfter >= 0) wait = Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
    } catch (e) {
      last = e instanceof Error && e.name === 'TimeoutError'
        ? `timed out after ${CAPTION_FETCH_TIMEOUT_MS / 1000}s`
        : e instanceof Error ? e.message : String(e);
    }
    if (i < attempts - 1) await delay(wait, signal);
  }
  return { error: `${what} could not be retrieved: ${last}${made > 1 ? ` (${made} attempts)` : ''}` };
}

/**
 * Watches yt-dlp's stdout for the info dict and starts the automatic-caption
 * fetch the moment it appears -- before the media download begins -- unless
 * a parseable manual track was requested, in which case auto is not needed.
 * `result` is null when nothing was started (no JSON seen, or manual wins),
 * and the caller falls back to fetching after the run.
 */
function captionPrefetcher(workDir: string, preferredLanguage?: string) {
  const controller = new AbortController();
  let buf = '';
  let seen = false;
  let result: Promise<CaptionFetch> | null = null;
  return {
    onStdout(chunk: string): void {
      if (seen) return;
      buf += chunk;
      let nl: number;
      while (!seen && (nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        seen = true;
        buf = '';
        let meta: YtDlpMeta;
        try { meta = JSON.parse(line) as YtDlpMeta; } catch { return; }
        const manualRequested = Object.values(meta.requested_subtitles ?? {})
          .some((info) => PARSEABLE_SUB_EXTS.has(info?.ext ?? 'vtt'));
        if (manualRequested) return;
        const choice = pickAutoTrack(meta, preferredLanguage);
        if (choice) result = fetchCaptionTrack(choice, meta.http_headers, workDir, 'automatic', controller.signal);
      }
    },
    get result(): Promise<CaptionFetch> | null { return result; },
    cancel(): void { controller.abort(); },
  };
}

/** yt-dlp's own wording when a subtitle download aborts the run. */
const SUBTITLE_FAILURE_RE = /unable to download video subtitles for '([^']+)': ([^\n]*)/i;
const MANUAL_SUB_ARGS = ['--write-subs', '--sub-format', 'vtt', '--sub-langs', 'all,-live_chat'];

/**
 * Everything yt-dlp said about a run, minus the info-dict JSON. With
 * --print-json, yt-dlp routes a ranged download's ffmpeg errors -- the
 * "Server returned 403 Forbidden" that makes it classifiable -- to STDOUT
 * (measured: present on stderr without --print-json, absent with it), so
 * classifying stderr alone saw only "ffmpeg exited with code 8". The JSON
 * lines are left out: a video's own title or description saying "sign in"
 * must never read as an error.
 */
function diagnostics(r: { stdout: string; stderr: string }): string {
  return `${r.stderr}\n${r.stdout.split('\n').filter((l) => !l.trimStart().startsWith('{')).join('\n')}`;
}

/** The info dict yt-dlp prints before a download starts, if any. */
function printedMeta(stdout: string): YtDlpMeta | null {
  const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) return null;
  try { return JSON.parse(line) as YtDlpMeta; } catch { return null; }
}

const RANGE_ARGS = new Set(['--download-sections', '--force-keyframes-at-cuts', '--verbose']);

/** The same invocation fetching the whole video: the range and its --verbose go. */
function withoutRange(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!RANGE_ARGS.has(args[i]!)) { out.push(args[i]!); continue; }
    if (args[i] === '--download-sections') i++; // and its value
  }
  return out;
}

function withoutManualSubs(args: string[]): string[] {
  const i = args.indexOf(MANUAL_SUB_ARGS[0]!);
  return i < 0 ? args : [...args.slice(0, i), ...args.slice(i + MANUAL_SUB_ARGS.length)];
}

export class YtDlpResolver implements VideoResolver {
  readonly name = 'ytdlp';

  /** `signIn` is injectable so tests can drive the sign-in wait without a browser. */
  constructor(private readonly signIn?: SiteSignInDeps) {}
  canResolve(url: string): boolean { return /^https?:\/\//i.test(url); }

  async resolve(url: string, opts: ResolveOptions): Promise<ResolveResult> {
    // Every result says what the last yt-dlp run sent, success or failure.
    const used: { cookies: CookieUse } = { cookies: 'none' };
    const r = await this.resolveTracked(url, opts, used);
    return { ...r, cookies: used.cookies };
  }

  private async resolveTracked(url: string, opts: ResolveOptions, used: { cookies: CookieUse }): Promise<ResolveResult> {
    // Spec §2.1: metadata-only is the default. resolveVideoTool always
    // sends an explicit boolean; analyze.ts never sets this field at all
    // (it always wants the media), so the default must be "download" --
    // only an explicit `false` skips the transfer.
    const wantsDownload = opts.returnVideo !== false;

    const out = join(opts.workDir, 'source.%(ext)s');
    let args = [
      '--no-playlist', '--no-warnings',
      '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
      '--merge-output-format', 'mp4',
      // Manual subs only -- deliberately NO --write-auto-subs (see the
      // caption-acquisition block comment above for the verified reasons).
      ...MANUAL_SUB_ARGS,
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
      // --verbose ONLY on this path, and only to make failures classifiable.
      //
      // A ranged download is fetched by ffmpeg rather than by yt-dlp, and
      // yt-dlp does not forward ffmpeg's stderr unless verbose. So the same
      // refusal that a full download reports as "HTTP Error 403: Forbidden"
      // arrives here as nothing but "ffmpeg exited with code 8" -- reproduced
      // directly: at verbose level the very same failure shows
      // "Server returned 403 Forbidden (access denied)" underneath it.
      //
      // That mattered twice over. The message was unactionable, AND the
      // condition never reached classifyYtDlpError's rate-limit branch, so a
      // ranged request could not be classified as temporary and never
      // triggered the cookie retry that a whole-video request would have got.
      // Identical circumstances, two different answers, purely because of
      // which process did the fetching.
      args.push('--verbose');
    }

    // Comments can be very slow on popular videos (spec §2.1).
    if (opts.comments) args.push('--write-comments');

    // Whose cookies. userCookies means the user approved their own browser
    // for this call, which outranks the standing configuration; otherwise
    // it is the operator's environment. The caller can still never name a
    // file or a browser -- only say yes to the user's own default one
    // (src/util/cookies.ts, src/util/browsers.ts). A misconfigured credential
    // throws rather than silently fetching anonymously; classify it as its
    // own failure so the message survives.
    const userBrowser = opts.userCookies ? await browserForCall() : null;
    let cookies: PreparedCookies;
    let cookieSource: CookieSource;
    try {
      cookieSource = userBrowser ? { kind: 'browser', spec: userBrowser.name } : cookieSourceFromEnv();
      cookies = prepareCookies(cookieSource);
    } catch (e) {
      if (e instanceof CookieConfigError) {
        return { status: 'extractor_failed', message: e.message, resolvedBy: 'ytdlp' };
      }
      throw e;
    }
    args.push(...cookies.args);

    // Every run gets its own prefetcher; only the last run's is used, and
    // all of them are cancelled on the way out (the finally below) so a
    // fetch from a run that failed never writes into a directory the caller
    // has already moved on from.
    const prefetchers: Array<ReturnType<typeof captionPrefetcher>> = [];
    const baseUse: CookieUse = cookieSource.kind === 'file' ? 'cookies_file'
      : cookieSource.kind === 'browser' ? `browser:${cookieSource.spec.split(/[+:]/)[0]!.toLowerCase()}`
        : 'none';
    const runYtDlp = (extra: string[]) => {
      const borrowed = extra.indexOf('--cookies-from-browser');
      used.cookies = borrowed >= 0 ? `browser:${extra[borrowed + 1]!}` : baseUse;
      const pre = captionPrefetcher(opts.workDir, opts.preferredLanguage);
      prefetchers.push(pre);
      return run('yt-dlp', [...args, ...extra, url], { timeoutMs: 15 * 60_000, onStdout: (d) => pre.onStdout(d) });
    };

    // try/finally, not a trailing call: every branch below returns, and a
    // temporary copy of a credential must not outlive the call that made it.
    try {

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
      let r = await runYtDlp([]);
      // yt-dlp aborts the whole run when a manual subtitle fails to download
      // (see the caption-acquisition comment above). The media is still
      // wanted and speech recognition can still transcribe it, so run again
      // without subtitles and fetch that track directly further down.
      let subtitleFailure: string | null = null;
      const subFail = r.code !== 0 ? SUBTITLE_FAILURE_RE.exec(r.stderr) : null;
      if (subFail) {
        subtitleFailure = subFail[2]!.trim();
        args = withoutManualSubs(args);
        r = await runYtDlp([]);
      }
      // A range is an optimization, never a guarantee (spec §18): when the
      // ranged fetch itself is refused -- YouTube answered ffmpeg's direct
      // fetch with 403 in the first live matrix run, right after a whole
      // download of the same video succeeded -- fetch the whole video once
      // instead. rangeApplied then comes out false, and the callers' own
      // local trim (analyze.ts, resolveTool.ts) cuts the section.
      if (r.code !== 0 && wantsRange) {
        const ranged = classifyYtDlpError(diagnostics(r));
        if (ranged.status === 'rate_limited' || ranged.status === 'extractor_failed') {
          // The info dict is printed before the download, so the duration is
          // known even though the fetch failed: a range that starts past the
          // end is the caller's mistake, not the platform's refusal.
          const past = rangePastEnd(opts.start, printedMeta(r.stdout)?.duration);
          if (past) return { status: 'extractor_failed', message: past, resolvedBy: 'ytdlp' };
          args = withoutRange(args);
          r = await runYtDlp([]);
        }
      }
      if (r.code !== 0) {
        // A refusal is the one failure cookies can plausibly fix, so it is
        // the only one worth spending them on. Everything else (DRM, removed
        // video, no extractor) is unaffected by who is asking.
        // Deliberately no targeted cleanup on any failure path below. yt-dlp
        // picks its own filenames, so two calls into one directory produce the
        // SAME names -- neither an exact path nor a before/after snapshot can
        // tell our abandoned bytes from a concurrent call's live ones, and an
        // earlier draft that tried destroyed 2.4MB of a running download.
        // Whatever a failure leaves is collected by the age-gated sweep above
        // on a later call into this directory (src/util/partials.ts).
        const first = classifyYtDlpError(diagnostics(r));
        const fixable = first.status === 'rate_limited' || first.status === 'auth_required';
        // Only 'auto' retries: an eagerly-configured source already sent its
        // cookies on the attempt that just failed, so retrying with the same
        // credentials would repeat the same refusal, and an unconfigured
        // server must not reach for credentials nobody offered. The browser
        // is the user's default, the same one userCookies reads: 'auto' used
        // to prefer Firefox, then Chrome, and on a Safari user's machine that
        // borrowed Chrome's cookies and told them to sign in to Chrome.
        const browser = fixable && cookieSource.kind === 'auto' ? ((await browserForCall())?.name ?? null) : null;
        if (browser) {
          // ONE retry, never a loop: if borrowed cookies do not clear it, the
          // refusal is about rate rather than identity and hammering it is
          // exactly what provoked the limiter in the first place.
          r = await runYtDlp(['--cookies-from-browser', browser]);
        }
        if (r.code !== 0) {
          const failure = browser ? classifyYtDlpError(diagnostics(r)) : first;
          const still = failure.status === 'rate_limited' || failure.status === 'auth_required';
          if (!still) return failure;
          // In the MESSAGE, not a separate field: the analyze path carries
          // only a reason string into its manifest.
          if (used.cookies === 'none') {
            // Cookies would plausibly have helped and none were sent. Say how
            // to send them -- a question for the user, never an action: the
            // server does not reach for a credential nobody offered.
            const hint = opts.userCookies
              ? 'userCookies was set, but no browser this server can read cookies from was found. '
                + 'VIDEO_EXTRACT_COOKIES_FILE can point at an exported cookie jar instead.'
              : userCookiesHint(await browserForCall());
            return { ...failure, message: `${failure.message} ${hint}` };
          }
          if (failure.status !== 'auth_required' || !used.cookies.startsWith('browser:')) return failure;
          const label = browserLabel(used.cookies.slice('browser:'.length));
          const host = siteHost(url);
          if (!userBrowser) {
            // The browser came from the standing configuration: nobody said
            // yes to a sign-in page for this call.
            return {
              ...failure,
              message: `${failure.message} This was refused even with ${label}'s cookies, so the user is `
                + `probably not signed in to ${host} there. Ask them to sign in to it in ${label}, then retry.`,
            };
          }
          // The user allowed their browser for this call and is still refused:
          // show them a page saying where to sign in, and retry once they have
          // (src/resolve/siteSignIn.ts).
          const waited = await waitForSiteSignIn({
            videoUrl: url,
            browser: userBrowser,
            retry: () => {
              // The retry is the run that moves the bytes, if any.
              if (wantsDownload) statusCallbacks()?.onStage?.('downloading');
              return runYtDlp([]);
            },
            verdict: (x) => (x.code === 0 ? 'ok'
              : classifyYtDlpError(diagnostics(x)).status === 'auth_required' ? 'refused' : 'other'),
            requester: opts.requestedBy,
            deps: this.signIn,
          });
          if (waited.outcome === 'signed_in' && waited.last) {
            r = waited.last;
          } else if (waited.outcome === 'other' && waited.last) {
            return classifyYtDlpError(diagnostics(waited.last));
          } else if (waited.outcome === 'declined') {
            return { ...failure, message: `${failure.message} ${DECLINED_MESSAGE}` };
          } else {
            const why = waited.outcome === 'not_opened'
              ? `This was refused even with ${label}'s cookies, and no sign-in page could be opened in ${label}.`
              : waited.outcome === 'gave_up'
                ? `A page in ${label} asked the user to sign in to ${host}, and it was still refused after `
                  + `${MAX_RETRIES} tries once they had, so this account probably cannot access the video `
                  + '(private, members-only, or region-locked).'
                : waited.retries === 0
                  ? `A page in ${label} asked the user to sign in to ${host}, but no sign-in was noticed `
                    + 'before the wait ended.'
                  : `A page in ${label} asked the user to sign in to ${host}, but it was still refused when `
                    + 'the wait ended.';
            return {
              ...failure,
              message: `${failure.message} ${why} Ask the user to check they are signed in to ${host} in `
                + `${label}, then retry with userCookies: true.`,
            };
          }
        }
      }
      let meta: YtDlpMeta = {};
      const lastJson = r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
      if (lastJson) { try { meta = JSON.parse(lastJson) as YtDlpMeta; } catch { /* metadata is optional */ } }

      const retrievalErrors: string[] = [];
      let manual = pickManualCaption(opts.workDir, meta, opts.preferredLanguage);
      if (!manual && subtitleFailure !== null) {
        const choice = pickManualTrack(meta, opts.preferredLanguage);
        const got: CaptionFetch = choice
          ? await fetchCaptionTrack(choice, meta.http_headers, opts.workDir, 'manual')
          : { error: `manual captions could not be retrieved: ${subtitleFailure}` };
        if ('track' in got) manual = got.track;
        else retrievalErrors.push(got.error);
      }
      let auto: CaptionTrack | null = null;
      if (!manual) {
        // chooseCaptionTier never consults auto when a manual track exists, so
        // the fetch is only worth its network cost in the manual-less case.
        // Normally already under way since the info dict was printed; started
        // here only when the prefetcher saw no JSON or expected a manual track.
        const choice = pickAutoTrack(meta, opts.preferredLanguage);
        const early = prefetchers[prefetchers.length - 1]?.result ?? null;
        const got = early ?? (choice ? fetchCaptionTrack(choice, meta.http_headers, opts.workDir, 'automatic') : null);
        const fetched = got ? await got : null;
        if (fetched && 'track' in fetched) auto = fetched.track;
        else if (fetched) retrievalErrors.push(fetched.error);
      }
      const captions: Captions = { manual, auto, ...(retrievalErrors.length > 0 ? { retrievalErrors } : {}) };

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
          captions,
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
        captions,
        languageHint: meta.language ?? null,
        rangeApplied,
        metadata: toVideoMetadata(meta),
        clipStart: wantsRange && rangeApplied ? opts.start : undefined,
        clipEnd: wantsRange && rangeApplied ? opts.end : undefined,
      };
    } finally {
      for (const pre of prefetchers) pre.cancel();
      cookies.dispose();
    }
  }
}
