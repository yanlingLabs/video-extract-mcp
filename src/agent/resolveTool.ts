import { mkdirSync, mkdtempSync, renameSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve as resolvePath } from 'node:path';
import type { Chapter } from '../types.js';
import { resolve } from '../resolve/index.js';
import { trim } from '../media/ffmpeg.js';
import { descriptionPreview, mediaFileName, writeMetadata } from './artifacts.js';
import { itemDir } from './analyzeTool.js';
import { runWithStatus } from '../status/context.js';

/**
 * True when `filePath` is located inside `dir`. Fix 1 (data loss): renaming
 * is only safe when the source is a working-directory temp resolveOneVideo
 * itself created or a resolver wrote into the workDir it was given (direct.ts,
 * ytdlp.ts, wechat.ts, and this module's own local-trim output all do). The
 * bare-local-path branch (src/resolve/index.ts:29-37) instead returns the
 * CALLER's own path verbatim -- never inside workDir -- so a rename there
 * would move (destroy) the caller's file rather than copy it. Gating on path
 * location, not on which resolver or branch produced the result, is the
 * actual invariant: a future resolver returning a caller-owned path from some
 * other branch stays safe here without needing its own special case.
 */
function isInside(filePath: string, dir: string): boolean {
  const rel = relative(resolvePath(dir), resolvePath(filePath));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export interface ResolveItemResult {
  status: string;
  reason?: string;
  platform?: string;
  title?: string;
  creator?: string | null;
  duration?: number;
  chapters?: Chapter[];
  descriptionPreview?: string | null;
  commentCount?: number | null;
  metadataPath: string;
  /** Present only on a failure cookies would plausibly fix, with none configured.
   *  Run it only with the user's approval: it grants access to their browser session. */
  suggestedCommand?: string;
  videoPath?: string;
  clipStart?: number;
  clipEnd?: number;
  nextSteps?: string;
  note?: string;
}

export interface ResolveVideoItem {
  url: string;
  returnVideo?: boolean;
  start?: number;
  end?: number;
  comments?: boolean;
}

async function resolveOneVideoAttempt(item: ResolveVideoItem, destinationPath: string): Promise<ResolveItemResult> {
  const returnVideo = item.returnVideo ?? false;
  mkdirSync(destinationPath, { recursive: true });

  const workDir = mkdtempSync(join(tmpdir(), 'norma-res-'));
  const r = await resolve(item.url, {
    workDir,
    returnVideo,
    comments: item.comments ?? false,
    start: returnVideo ? item.start : undefined,
    end: returnVideo ? item.end : undefined,
  });

  if (r.status !== 'ok') {
    // Failure still writes what little we know, so the shape is stable.
    // `url` is included because ResolveFailure itself carries none, and
    // without it a failure record on disk cannot be correlated back to
    // what was being resolved.
    const metadataPath = writeMetadata(destinationPath, { url: item.url, ...r });
    // Prefer the categorical reason (e.g. 'drm_protected') when the resolver
    // supplied one, falling back to the human-readable message otherwise --
    // the same fold analyze.ts:86 already uses for the same ResolveFailure
    // shape (`typeof res.reason === 'string' ? res.reason : res.message`).
    // The brief's reference always used r.message, silently discarding a
    // populated r.reason.
    const reason = typeof r.reason === 'string' ? r.reason : r.message;
    return {
      status: r.status, reason, metadataPath,
      ...(r.suggestedCommand ? { suggestedCommand: r.suggestedCommand } : {}),
    };
  }

  // Range extraction is genuine for yt-dlp sources but is a documented
  // full-download-then-trim for direct URLs and WeChat (design §5) -- those
  // resolvers never read opts.start/opts.end at all (src/resolve/direct.ts,
  // src/resolve/wechat.ts) and always leave rangeApplied false. Without this
  // step, a range request against one of those sources would silently
  // return the FULL video under a full-fetch filename, with no clip fields
  // and no offset note -- an honest-looking but incomplete reply. Mirrors
  // analyze.ts:100-122: trim locally when the resolver could not, and treat
  // the result as a genuine clip. Deliberately NOT wrapped in a local
  // try/catch, matching analyze.ts's own shape -- a trim failure (corrupt
  // source, ffmpeg unavailable) propagates to resolveVideoTool's outer
  // boundary below and becomes an honest failure result, rather than
  // silently falling back to returning the wrong (untrimmed) video under a
  // clip-shaped name.
  let sourcePath = r.filePath;
  let appliedStart = r.clipStart;
  let appliedEnd = r.clipEnd;
  if (returnVideo && item.start !== undefined && item.end !== undefined && !r.rangeApplied) {
    sourcePath = await trim(r.filePath, item.start, item.end, join(workDir, 'clip.mp4'));
    appliedStart = item.start;
    appliedEnd = item.end;
  }

  // Spec §5.1: the saved metadata must record the applied range, whether the
  // resolver applied it or the local trim above just did.
  const metadataPath = writeMetadata(destinationPath, {
    url: item.url, platform: r.platform, resolvedBy: r.resolvedBy,
    clipStart: appliedStart, clipEnd: appliedEnd,
    captions: r.captions, languageHint: r.languageHint,
    ...(r.metadata ?? {}),
  });

  let videoPath: string | undefined;
  if (returnVideo && existsSync(sourcePath)) {
    // Range is part of artifact identity (spec §7): a clip and a full fetch
    // coexist; re-fetching the SAME range overwrites in place.
    videoPath = join(destinationPath, mediaFileName(appliedStart, appliedEnd));
    // Fix 1: only rename a working-directory temp we own -- otherwise
    // (the bare-local-path branch's caller-owned file) copy, so the source
    // survives. Renaming a caller-owned file previously "worked" (no
    // exception -- workDir and destinationPath are typically on the same
    // filesystem, so renameSync just silently succeeds) while actually
    // moving the caller's video out of its own directory.
    if (isInside(sourcePath, workDir)) {
      try { renameSync(sourcePath, videoPath); }
      catch { copyFileSync(sourcePath, videoPath); }
    } else {
      copyFileSync(sourcePath, videoPath);
    }
  }

  const clipped = appliedStart !== undefined && appliedEnd !== undefined;
  // Fix 5: when a clip was actually produced, its duration is the applied
  // range's own length -- NOT the original video's duration, which the
  // `?? r.duration` fallback below would otherwise report unchanged. Without
  // this, `resolve_video {returnVideo: true, start: 1, end: 4}` on a 6s
  // source reported duration: 6 beside clipStart: 1, clipEnd: 4, while the
  // saved file itself is 3 seconds long -- self-contradictory, and
  // contradicting the reply's own "starts at 0" note below.
  const clipDuration = clipped ? appliedEnd! - appliedStart! : undefined;
  // direct/wechat have no metadata layer (neither resolver ever populates
  // r.metadata) -- when no transfer happened (returnVideo false), their
  // top-level r.duration is an unavoidable required-by-type placeholder
  // (0), not a measurement, and must not reach the agent looking like one
  // (design: "absent, not zero or empty-string"). yt-dlp's
  // r.metadata.duration is genuine even without downloading (verified
  // against the installed yt-dlp's own extractor source: duration is
  // scraped during extraction, independent of the download step), so it
  // is trusted whenever present AND a real number; r.duration itself is
  // only trusted when a real file was actually fetched and probed
  // (returnVideo true).
  //
  // `typeof ... === 'number'`, NOT `!== undefined` (Fix B, task-8):
  // toVideoMetadata now reports a genuinely duration-less yt-dlp source
  // (live stream, premiere, some non-YouTube extractors) as
  // metadata.duration: null, not 0 -- but `null !== undefined` is TRUE, so
  // the old guard treated a known-absent duration as known, and the spread
  // below would have coalesced that null right back into r.duration's own
  // placeholder, laundering "unknown" into a fake zero under a new type.
  //
  // Fix 7 (local half): resolve()'s bare-local-path branch
  // (src/resolve/index.ts:29-37) probes the file UNCONDITIONALLY, even on a
  // metadata-only call -- r.duration is a genuine measurement there, not the
  // required-by-type placeholder direct.ts/wechat.ts leave it as when they
  // skip the transfer. `r.platform === 'local'` is that branch's own literal
  // tag, set nowhere else, so it identifies the branch precisely without
  // re-deriving isLocalPath from the URL. Direct/WeChat (explicitly out of
  // scope: they have no cheap metadata layer at all, and omitting duration
  // rather than inventing one is the honest, deliberate behaviour there)
  // stay exactly as before -- their own r.platform is 'direct'/'wechat_channels'.
  // `r.duration > 0`, not `r.platform === 'local'` alone: ffprobe reads some
  // containers (raw .h264 and other bare bitstreams) without reporting a
  // format duration, and resolve()'s local branch then leaves r.duration at
  // its required-by-type 0. Trusting the platform tag by itself put that 0
  // back into the reply as a measured fact -- reinstating, for local files,
  // exactly the laundering the Fix B comment above exists to prevent.
  const durationKnown = typeof r.metadata?.duration === 'number' || returnVideo
    || (r.platform === 'local' && r.duration > 0);
  return {
    status: 'ok',
    platform: r.platform,
    title: r.metadata?.title ?? r.title,
    creator: r.metadata?.creator ?? null,
    chapters: r.metadata?.chapters ?? [],
    descriptionPreview: descriptionPreview(r.metadata?.description ?? null),
    commentCount: r.metadata?.commentCount ?? null,
    metadataPath,
    ...(durationKnown ? { duration: clipDuration ?? r.metadata?.duration ?? r.duration } : {}),
    ...(videoPath ? { videoPath } : {}),
    ...(clipped ? { clipStart: appliedStart, clipEnd: appliedEnd } : {}),
    ...(returnVideo ? {} : {
      nextSteps:
        'Media was not downloaded. To fetch it, call resolve_video again with '
        + 'returnVideo: true (optionally with start/end to fetch only a section). '
        + 'To go straight to analysis, call analyze_video with this same URL.',
    }),
    ...(clipped && videoPath ? {
      note:
        `The saved file is a clip and STARTS AT 0 -- it covers ${appliedStart}s to `
        + `${appliedEnd}s of the original. Timestamps passed to analyze_video against `
        + `this file are relative to the clip, so add ${appliedStart} to convert back to `
        + 'original-video time. Passing the original URL instead keeps original timestamps.',
    } : {}),
  };
}

/**
 * Documented contract (matching analyze.ts's analyzeVideo/analyzeResolved
 * split): resolve_video RETURNS a structured result rather than throwing.
 * resolveOneVideoAttempt can throw for reasons that have nothing to do
 * with the URL or the resolver -- mkdirSync EEXIST when destinationPath
 * already exists as a file (an ordinary caller mistake, not adversarial
 * input), mediaFileName rejecting a contract-violating range, or both
 * renameSync and its copyFileSync fallback failing. Anything not already
 * absorbed into a structured ResolveFailure becomes an honest
 * 'extractor_failed' result here instead of an uncaught rejection.
 */
export async function resolveOneVideo(item: ResolveVideoItem, destinationPath: string): Promise<ResolveItemResult> {
  try {
    return await resolveOneVideoAttempt(item, destinationPath);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    let metadataPath = join(destinationPath, 'metadata.json');
    try {
      metadataPath = writeMetadata(destinationPath, { url: item.url, status: 'extractor_failed', message });
    } catch {
      // destinationPath itself may be unusable (e.g. it exists as a file,
      // not a directory) -- metadataPath still names where it WOULD have
      // gone, so the result shape stays stable even though nothing could
      // actually be written there.
    }
    return { status: 'extractor_failed', reason: `resolve_video failed: ${message}`, metadataPath };
  }
}

export interface ResolveToolArgs { destinationPath: string; videos: ResolveVideoItem[]; }
export interface ResolveToolResult { videos: ResolveItemResult[]; }

/** resolve_video's counterpart to AnalyzeRunHooks (src/agent/analyzeTool.ts)
 *  -- deliberately narrower: resolve has no slot pool of its own (no
 *  `run`/`onQueued`) and no onItemStart. onStage will in practice only ever
 *  carry 'downloading' (§4), since resolveOneVideo has no multi-stage
 *  pipeline of its own the way analyzeVideo does -- everything here reaches
 *  the caller purely via the status context wrapped around each item below. */
export interface ResolveRunHooks {
  onStage?: (itemIndex: number, stage: string) => void;
  onSpawn?: (itemIndex: number, pid: number, command: string) => void;
  onSpawnEnded?: (itemIndex: number) => void;
  /** Final whole-branch review, Important finding 2 -- resolve_video's
   *  counterpart to AnalyzeRunHooks.onItemDone (src/agent/analyzeTool.ts):
   *  fires the instant THIS item's own promise settles, inside the
   *  per-item chain below, not after the batch's own Promise.all. Same
   *  rationale as analyzeVideoTool -- driving a per-item "done" signal off
   *  Promise.all reports every item as still-running until the whole
   *  batch's slowest item finishes. `status` is the item's own
   *  result.status; resolveOneVideo never rejects (same no-throw contract
   *  as analyzeOneVideo), so there is no failure branch to add here. */
  onItemDone?: (itemIndex: number, status: string) => void;
}

export async function resolveVideoTool(args: ResolveToolArgs, hooks?: ResolveRunHooks): Promise<ResolveToolResult> {
  const n = args.videos.length;
  const videos = await Promise.all(args.videos.map((item, i) => {
    const result = runWithStatus(
      {
        onStage: (s) => hooks?.onStage?.(i, s),
        onSpawn: (pid, cmd) => hooks?.onSpawn?.(i, pid, cmd),
        onSpawnEnded: () => hooks?.onSpawnEnded?.(i),
      },
      () => resolveOneVideo(item, itemDir(args.destinationPath, i, n)),
    );
    // Final whole-branch review, Important finding 2: see
    // analyzeVideoTool's identical wiring (src/agent/analyzeTool.ts) for
    // the full rationale -- chained onto THIS item's own promise so a fast
    // item's completion is reported the instant it happens, not once every
    // item in the batch has.
    return result.then((r) => {
      hooks?.onItemDone?.(i, r.status);
      return r;
    });
  }));
  return { videos };
}
