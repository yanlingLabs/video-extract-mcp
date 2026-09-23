import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalyzeStage, CookieUse, FrameMode, Manifest, Transcript } from '../types.js';
import { analyzeVideo } from '../analyze.js';
import { buildManifest } from '../manifest.js';
import { writeManifest, writeTranscript } from './artifacts.js';
import { mintWorkDir, sweepAbandonedWorkDirs, discardWorkDir, deliverFile } from './workdir.js';
import { runWithStatus, safe } from '../status/context.js';

/** Above this, the transcript goes to disk only -- a long transcript is
 *  exactly the payload destinationPath exists to keep out of context. */
export const INLINE_TRANSCRIPT_MAX_CHARS = 8000;

export interface AnalyzeItemResult {
  status: string;
  reason?: string;
  title: string;
  duration: number;
  frameCount: number;
  framePaths: string[];
  transcript?: Transcript;
  transcriptPath?: string;
  manifestPath: string;
  videoPath?: string;
  warnings: string[];
  /** What credential was sent (see CookieUse), on every result. */
  cookies: CookieUse;
}

export interface AnalyzeVideoItem {
  pathOrUrl: string;
  start?: number;
  end?: number;
  frames?: FrameMode;
  maxFrames?: number;
  transcript?: boolean;
  language?: string;
}

function transcriptChars(t: Transcript): number {
  return t.segments.reduce((n, s) => n + s.text.length, 0);
}

/**
 * Same "bare local path" test src/resolve/index.ts uses ahead of resolver
 * dispatch: no http(s) scheme, and it genuinely exists on disk. Mirrored
 * here (resolve/index.ts does not export it) so this module can tell
 * "already local" apart from "must be fetched" *before* calling
 * analyzeVideo -- the only point where that distinction can still change
 * what gets passed in.
 */
function isLocalPath(pathOrUrl: string): boolean {
  return !/^https?:\/\//i.test(pathOrUrl) && existsSync(pathOrUrl);
}

async function analyzeOneVideoAttempt(
  item: AnalyzeVideoItem, destinationPath: string, onStage: ((stage: AnalyzeStage) => void) | undefined,
  userCookies: boolean, requestedBy: string | undefined,
): Promise<AnalyzeItemResult> {
  mkdirSync(destinationPath, { recursive: true });

  // Spec §2.1: a source already on disk must not be duplicated into
  // destinationPath -- the reply points at the caller's own file instead.
  const local = isLocalPath(item.pathOrUrl);

  // Every source works in a private scratch directory inside destinationPath
  // (src/agent/workdir.ts explains why there rather than os.tmpdir()), and
  // only the deliverables are moved out. Pointed straight at destinationPath,
  // one real run left 258 candidate JPEGs for a 40-frame request plus both
  // the download and its re-encode -- 390 MB for 40 images and a transcript.
  // A local source used to get analyzeVideo's own os.tmpdir() directory
  // instead, which nothing removed: every call left a `norma-XXXXXX/` of
  // candidate frames behind.
  //
  // Swept on entry, before minting: a killed run's scratch is collected by
  // the next call into that directory. Nothing else can collect it -- the
  // age-gated partials sweep only ever looks inside the download's own
  // directory, which is now the abandoned scratch itself.
  sweepAbandonedWorkDirs(destinationPath);
  const workDir = mintWorkDir(destinationPath);

  try {
    const raw = await analyzeVideo(item.pathOrUrl, {
      start: item.start,
      end: item.end,
      frames: item.frames,
      maxFrames: item.maxFrames,
      transcript: item.transcript,
      // Spec §4: an explicit language is the override; it outranks metadata.
      preferredLanguage: item.language,
      destinationPath,
      onStage,
      outDir: workDir,
      userCookies,
      requestedBy,
    });

    // Move the deliverables out of the scratch directory: the SELECTED
    // frames (not the candidate pool they were chosen from) and, for a URL,
    // the one video file the reply will point at. For a local source the
    // reply points at the caller's own file rather than at any re-encode
    // made from it. Everything else the pipeline wrote -- rejected
    // candidates, a second copy of the video, the caption files the
    // transcript was parsed out of -- is discarded with the scratch
    // directory in the finally below.
    const m: Manifest = {
      ...raw,
      source: !raw.source.filePath
        ? raw.source
        : { ...raw.source, filePath: local ? item.pathOrUrl : deliverFile(destinationPath, workDir, raw.source.filePath) },
      frames: raw.frames.map((f) => ({ ...f, image: deliverFile(destinationPath, workDir, f.image) })),
    };

    const manifestPath = writeManifest(destinationPath, m);

    // Spec §3: the transcript is ALWAYS written, and additionally returned
    // inline only when short enough to be worth the context.
    let transcriptPath: string | undefined;
    let inline: Transcript | undefined;
    if (m.transcript) {
      transcriptPath = writeTranscript(destinationPath, m.transcript);
      if (transcriptChars(m.transcript) <= INLINE_TRANSCRIPT_MAX_CHARS) inline = m.transcript;
    }

    return {
      status: m.source.status,
      ...(m.source.reason ? { reason: m.source.reason } : {}),
      title: m.source.title,
      duration: m.source.duration,
      frameCount: m.frames.length,
      framePaths: m.frames.map((f) => f.image),
      ...(inline ? { transcript: inline } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
      manifestPath,
      ...(m.source.filePath ? { videoPath: m.source.filePath } : {}),
      warnings: m.processing.warnings,
      cookies: m.source.cookies,
    };
  } finally {
    // Every return above is inside the try, and analyzeVideo can also throw
    // (analyzeOneVideo's own catch turns that into a failure result) -- so a
    // finally is the only placement that cannot leave a full video and a few
    // hundred JPEGs behind in the caller's directory.
    discardWorkDir(workDir);
  }
}

/**
 * Documented contract (matching resolveOneVideo/analyzeVideo's own shape):
 * analyze_video RETURNS a structured result rather than throwing.
 * analyzeOneVideoAttempt can throw for reasons that have nothing to do
 * with the URL or the pipeline -- mkdirSync EEXIST when destinationPath
 * already exists as a file (an ordinary caller mistake, not adversarial
 * input), or any other unexpected error analyzeVideo itself did not already
 * absorb into a status-carrying Manifest. Anything not already absorbed
 * becomes an honest 'extractor_failed' result here instead of an uncaught
 * rejection.
 */
export async function analyzeOneVideo(
  item: AnalyzeVideoItem, destinationPath: string, onStage?: (stage: AnalyzeStage) => void,
  userCookies = false, requestedBy?: string,
): Promise<AnalyzeItemResult> {
  try {
    return await analyzeOneVideoAttempt(item, destinationPath, onStage, userCookies, requestedBy);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    let manifestPath = join(destinationPath, 'manifest.json');
    try {
      manifestPath = writeManifest(destinationPath, buildManifest({
        url: item.pathOrUrl, platform: 'unknown', title: '', duration: 0, resolvedBy: 'none',
        status: 'extractor_failed', reason: `analyze_video failed: ${message}`,
        transcript: null, frames: [], candidateCount: 0, peakRssMb: 0, frameMode: 'none', warnings: [],
      }));
    } catch {
      // destinationPath itself may be unusable (e.g. it exists as a file,
      // not a directory) -- manifestPath still names where it WOULD have
      // gone, so the result shape stays stable even though nothing could
      // actually be written there.
    }
    return {
      status: 'extractor_failed',
      reason: `analyze_video failed: ${message}`,
      title: '', duration: 0, frameCount: 0, framePaths: [],
      manifestPath, warnings: [], cookies: 'none',
    };
  }
}

export interface AnalyzeToolArgs {
  destinationPath: string;
  videos: AnalyzeVideoItem[];
  /** Per call: the user allowed their browser session for this one (ResolveOptions.userCookies). */
  userCookies?: boolean;
  /** Set by the MCP layer, never by the caller: see ResolveOptions.requestedBy. */
  requestedBy?: string;
}
export interface AnalyzeToolResult { videos: AnalyzeItemResult[]; }
export interface AnalyzeRunHooks {
  /** Wraps each item's execution -- the MCP layer passes the slot pool here.
   *  Omitted = run directly (library callers manage their own concurrency). */
  run?: <T>(fn: () => Promise<T>, onQueued: (ahead: number) => void) => Promise<T>;
  onStage?: (itemIndex: number, stage: AnalyzeStage) => void;
  onQueued?: (itemIndex: number, ahead: number) => void;
  /** Spawn lifecycle for the item's currently-running child process
   *  (yt-dlp/ffmpeg/asrWorker/embedWorker). Reported via the status context
   *  (src/status/context.ts) established around the item's execution below
   *  -- src/util/run.ts reads it, so this reaches every run()-calling
   *  module with no signature changes there. */
  onSpawn?: (itemIndex: number, pid: number, command: string) => void;
  onSpawnEnded?: (itemIndex: number) => void;
  /** Fires when the item actually starts executing (post-queue, inside the
   *  `run` wrapper's own fn). Available for any caller that wants this
   *  signal; src/mcp.ts's own honest-cancellation marking no longer goes
   *  through this hook specifically -- it now calls its equivalent callback
   *  directly at the top of its `run` wrapper, before that wrapper's own
   *  cancellation check, which this hook (firing only once `fn` itself
   *  runs) would reach too late to do the same job. See src/mcp.ts's
   *  runAnalyzeExecution for the full rationale. */
  onItemStart?: (itemIndex: number) => void;
  /** Final whole-branch review, Important finding 2: fires the instant THIS
   *  item's own execution settles -- inside the per-item promise chain
   *  below, not after the batch's own Promise.all. Without this, a caller
   *  driving a per-item "done" signal off Promise.all (src/mcp.ts's
   *  registerItems/statusRegistry.finish() wiring) reports every item as
   *  still-running until the whole batch's slowest item finishes, even
   *  though a fast sibling released its pool slot and genuinely completed
   *  much earlier -- exactly the "stuck" signature the status channel's own
   *  docs teach an agent to read as a hung item. `status` is the item's own
   *  result.status (never thrown -- analyzeOneVideo's own contract is to
   *  return a status-carrying result, not reject), so this never needs a
   *  failure branch of its own. */
  onItemDone?: (itemIndex: number, status: string) => void;
}

/** Spec §4: one video writes flat (today's layout, byte-identical); several
 *  each get destinationPath/video-N so metadata.json never collides. */
export function itemDir(destinationPath: string, index: number, total: number): string {
  return total === 1 ? destinationPath : join(destinationPath, `video-${index + 1}`);
}

export async function analyzeVideoTool(
  args: AnalyzeToolArgs, hooks?: AnalyzeRunHooks,
): Promise<AnalyzeToolResult> {
  const n = args.videos.length;
  const exec = hooks?.run ?? (<T,>(fn: () => Promise<T>) => fn());
  const videos = await Promise.all(args.videos.map((item, i) => {
    const result = exec(
      () => {
        hooks?.onItemStart?.(i);
        return runWithStatus(
          {
            onStage: (s) => hooks?.onStage?.(i, s as AnalyzeStage),
            onSpawn: (pid, cmd) => hooks?.onSpawn?.(i, pid, cmd),
            onSpawnEnded: () => hooks?.onSpawnEnded?.(i),
          },
          // Task 4 mandate (A): this bridges analyzeOneVideo's OWN onStage
          // parameter (the pre-existing 'resolving'/'transcribing'/'frames'
          // thread, independent of the runWithStatus() context established
          // just above) straight to hooks.onStage -- a caller-supplied
          // callback, now a REAL one (the status registry) as of this task.
          // Routed DIRECTLY, not through statusCallbacks(), so it was never
          // covered by Task 2's safe()-at-establishment fix: a throwing
          // hooks.onStage here reaches analyzeVideo's own opts.onStage?.()
          // call unguarded, which src/analyze.ts invokes as the first
          // statement of its OWN try block -- the throw is absorbed there
          // into a normal-looking status:'extractor_failed' Manifest, not a
          // rejection, silently turning a legitimate analysis into a
          // reported failure. safe() (src/status/context.ts) closes this the
          // same way runWithStatus() already closes the context path.
          () => analyzeOneVideo(
            item, itemDir(args.destinationPath, i, n), safe((s: AnalyzeStage) => hooks?.onStage?.(i, s)),
            args.userCookies === true, args.requestedBy,
          ),
        );
      },
      (ahead) => hooks?.onQueued?.(i, ahead),
    );
    // Final whole-branch review, Important finding 2: chained onto THIS
    // item's own promise, not onto Promise.all below -- firing here means
    // onItemDone runs the instant this one item settles, however long its
    // siblings still have left, rather than only once every item in the
    // batch has (src/mcp.ts's statusRegistry.finish() call used to be
    // wired to the latter, so a fast item read as still-running -- frozen
    // bytes, no childPid, a climbing "in stage" age -- for as long as 18s
    // while its slowest sibling ran, the exact signature the status
    // channel's own docs teach an agent to read as stuck). analyzeOneVideo
    // never rejects (it absorbs its own failures into a status-carrying
    // result), so there is no rejection branch to mirror here; a real
    // rejection (a queued item's TaskCancelledError, at the mcp.ts layer
    // above `exec`) simply skips this .then(), and that layer keeps its own
    // post-Promise.all finish() as the backstop for exactly that case.
    return result.then((r) => {
      hooks?.onItemDone?.(i, r.status);
      return r;
    });
  }));
  return { videos };
}
