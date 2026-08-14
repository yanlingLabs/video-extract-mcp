import { mkdirSync, existsSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AnalyzeStage, FrameMode, Manifest, Transcript } from '../types.js';
import { analyzeVideo } from '../analyze.js';
import { buildManifest } from '../manifest.js';
import { writeManifest, writeTranscript } from './artifacts.js';
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

/**
 * Moves (falling back to copying, e.g. across devices) a working-directory
 * frame image into destinationPath, matching resolveTool.ts's own
 * rename-then-copy pattern for videoPath. A source that no longer exists is
 * left exactly as reported rather than throwing: this only ever runs
 * against paths analyzeVideo itself produced, but a defensive no-op keeps a
 * surprising pipeline state from taking down the whole call over a handful
 * of frame thumbnails.
 */
function relocateFrame(destinationPath: string, imagePath: string): string {
  if (!existsSync(imagePath)) return imagePath;
  const dest = join(destinationPath, basename(imagePath));
  if (dest === imagePath) return imagePath;
  try { renameSync(imagePath, dest); } catch { copyFileSync(imagePath, dest); }
  return dest;
}

/**
 * Fix 6 (deferred #18, local-source leak half): for a local source,
 * analyzeVideo ran against its own private mkdtempSync'd working directory
 * (outDir was deliberately left unset above), and when frameMode is 'key'
 * its manifest's source.filePath points at the re-encoded copy it made
 * there (work.mp4) -- never cleaned up, so every local analyze_video call
 * left a full re-encode behind (deferred #18). The rewrite below always
 * replaces that path with item.pathOrUrl for a local source, so once it has
 * happened, nothing in the final reply or manifest (`m`) references the
 * pre-rewrite path any more -- it is an orphaned temp, not a second copy of
 * anything the agent still needs.
 *
 * Comparing the pre- and post-rewrite VALUES -- not "is this a local
 * source" -- is what keeps this safe: it is what the brief calls "check
 * what the reply's videoPath and the manifest's source.filePath actually
 * reference" before deleting anything. When frameMode isn't 'key', or no
 * range was applied, analyzeVideo's own filePath is often ALREADY
 * item.pathOrUrl (resolve()'s bare-local-path branch returns the caller's
 * path back unchanged) -- rawFilePath === finalFilePath in that case, so
 * this is a no-op, and the caller's own file is never touched. Only a
 * genuinely different, analyzeVideo-created path is ever removed.
 * Best-effort: a failed delete must never fail the call.
 */
function cleanupOrphanedCopy(rawFilePath: string | undefined, finalFilePath: string | undefined): void {
  if (!rawFilePath || rawFilePath === finalFilePath) return;
  try { rmSync(rawFilePath, { force: true }); } catch { /* best-effort */ }
}

async function analyzeOneVideoAttempt(
  item: AnalyzeVideoItem, destinationPath: string, onStage?: (stage: AnalyzeStage) => void,
): Promise<AnalyzeItemResult> {
  mkdirSync(destinationPath, { recursive: true });

  // Spec §2.1: a source already on disk must not be duplicated into
  // destinationPath. analyzeVideo's normalize() step unconditionally writes
  // a re-encoded working copy (plus its frames/ subdirectory) into whatever
  // outDir it is given (src/analyze.ts -> src/media/ffmpeg.ts's
  // normalize()) -- there is no way to get frames out of it without also
  // getting that copy in the same directory. For a URL source that copy IS
  // the deliverable (the agent has no other local copy), so outDir stays
  // destinationPath as usual. For an already-local source it would be a
  // second, disk-doubling copy of a file the agent already placed, so
  // outDir is left unset -- analyzeVideo falls back to its own private
  // mkdtempSync'd directory (src/analyze.ts) -- and only the (cheap) frame
  // thumbnails are relocated into destinationPath below.
  const local = isLocalPath(item.pathOrUrl);

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
    ...(local ? {} : { outDir: destinationPath }),
  });

  // Spec §2.1: for a local source, relocate the frame thumbnails into
  // destinationPath (a handful of JPEGs, not the video) and point
  // source.filePath back at the file the agent already has, rather than at
  // analyzeVideo's private, ephemeral normalized copy -- which is kept OUT
  // of destinationPath specifically so it never persists as a second copy
  // of the source (see the outDir comment above).
  const m: Manifest = local
    ? {
        ...raw,
        source: raw.source.filePath ? { ...raw.source, filePath: item.pathOrUrl } : raw.source,
        frames: raw.frames.map((f) => ({ ...f, image: relocateFrame(destinationPath, f.image) })),
      }
    : raw;

  // Fix 6: clean up analyzeVideo's own working copy once it has been
  // superseded above -- see cleanupOrphanedCopy's doc comment for why this
  // order (after computing `m`, comparing against the pre-rewrite `raw`) is
  // what keeps it from ever touching a file the reply still points at.
  cleanupOrphanedCopy(raw.source.filePath, m.source.filePath);

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
  };
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
): Promise<AnalyzeItemResult> {
  try {
    return await analyzeOneVideoAttempt(item, destinationPath, onStage);
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
      manifestPath, warnings: [],
    };
  }
}

export interface AnalyzeToolArgs { destinationPath: string; videos: AnalyzeVideoItem[]; }
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
          () => analyzeOneVideo(item, itemDir(args.destinationPath, i, n), safe((s: AnalyzeStage) => hooks?.onStage?.(i, s))),
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
