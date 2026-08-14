export type ResolveStatus =
  | 'ok' | 'auth_required' | 'auth_expired' | 'needs_interaction'
  | 'unsupported' | 'not_found' | 'rate_limited' | 'extractor_failed';

export type UnsupportedReason = 'drm_protected' | 'unsupported_link' | 'extractor_unsupported';

export type FrameMode = 'key' | 'even' | 'none';

export interface Chapter { start: number; end: number; title: string; }

export interface VideoMetadata {
  title: string;
  creator: string | null;
  /** Null, not 0, when the platform genuinely omits it (live streams,
   *  premieres, some non-YouTube extractors) -- matching the `| null`
   *  convention its neighbouring fields already use, so "unknown" and
   *  "measured zero" stay distinguishable downstream (resolveTool.ts). */
  duration: number | null;
  chapters: Chapter[];
  description: string | null;
  uploadDate: string | null;
  viewCount: number | null;
  commentCount: number | null;
  /** Platform comments, written to the metadata file only (never surfaced inline).
   *  Absent unless explicitly requested via ResolveOptions.comments. Comment structure
   *  varies by extractor; not typed to avoid pinning to a specific schema. */
  comments?: unknown[];
}

/**
 * Spec §2.2: `frames` is the documented control, but a zero (or negative)
 * budget means the same thing as 'none' and must not error -- an agent
 * reasoning about budgets may reach for the number before the enum.
 * An explicit mode always wins, so `frames:'even', maxFrames:0` stays
 * 'even' and is caught later by the range validation rather than silently
 * becoming a transcript-only call.
 */
export function resolveFrameMode(
  frames: FrameMode | undefined,
  maxFrames: number | undefined,
): FrameMode {
  if (frames !== undefined) return frames;
  if (maxFrames !== undefined && maxFrames <= 0) return 'none';
  return 'key';
}

/** One acquired caption file plus the language it is actually in. */
export interface CaptionTrack {
  /** Local path to the downloaded caption file (VTT, or SRT -- parseVtt reads both cue syntaxes). */
  path: string;
  /** Normalized base language of the track (e.g. 'en' for an 'en-US' tag), when known. */
  language: string | null;
}

export interface ResolvedMedia {
  status: 'ok';
  filePath: string;
  platform: string;
  title: string;
  duration: number;
  resolvedBy: 'ytdlp' | 'direct' | 'wechat';
  captions: { manual: CaptionTrack | null; auto: CaptionTrack | null };
  languageHint: string | null;
  /** True when the resolver already trimmed to the requested range. */
  rangeApplied: boolean;
  /** Platform metadata for resolve_video's inline result (spec §9). */
  metadata?: VideoMetadata;
  /** Applied range against the ORIGINAL video, when one was (spec §5.1). */
  clipStart?: number;
  clipEnd?: number;
}

export interface ResolveFailure {
  status: Exclude<ResolveStatus, 'ok'>;
  reason?: UnsupportedReason | string;
  message: string;
  resolvedBy?: string;
}

export type ResolveResult = ResolvedMedia | ResolveFailure;

export interface ResolveOptions {
  start?: number; end?: number; workDir: string;
  preferredLanguage?: string;
  /** Spec §2.1: metadata-only by default; media is the opt-in. */
  returnVideo?: boolean;
  /** Spec §2.1: can be very slow on popular videos. */
  comments?: boolean;
}

export interface VideoResolver {
  readonly name: string;
  canResolve(url: string): boolean;
  resolve(url: string, opts: ResolveOptions): Promise<ResolveResult>;
}

export interface TranscriptSegment { start: number; end: number; text: string; }
export type TranscriptSource = 'manual' | 'auto' | 'asr';
export interface Transcript {
  language: string; source: TranscriptSource; segments: TranscriptSegment[];
}

export interface Candidate {
  timestamp: number;
  sceneId: number;
  imagePath: string;
  /** Set by scene detector: how strong the boundary was, 0..1. 0 for heartbeat frames. */
  sceneSignificance: number;
  quality: number;               // 0..1, from src/vision/quality.ts
  embedding?: number[];          // 768-dim, normalized
  ocrContent?: string;           // persistent-region text only
  ocrSubtitle?: string;          // caption-band text (discounted)
  textNovelty?: number;          // 0..1, computed subtitle-aware
}

export interface SelectedFrame {
  timestamp: number;
  sceneId: number;
  image: string;
  importance: number;
  reasons: string[];
  ocrContent: string | null;
  transcriptWindow: string | null;
  nearestSelectedSimilarity: number;
}

export interface Manifest {
  source: {
    url: string; platform: string; title: string; duration: number;
    resolvedBy: string; status: ResolveStatus; reason?: string;
    /**
     * Local filesystem path to the video analyzeVideo actually worked from
     * -- present only on the 'ok' path. In 'key' mode this is the normalized
     * re-encode (NOT the original download). In 'even'/'none' mode spec §8's
     * cheapness rules out re-encoding, so it is the resolver's own output,
     * or the caller's own file when a local path was passed -- which is also
     * why that file must never be deleted as cleanup.
     * This is what closes the coarse-to-fine loop: get_frame/get_clip
     * operate on a local file, and until this field existed, analyzeVideo's
     * own manifest had no such path for them to operate on (only individual
     * per-keyframe image paths). See task-16-report.md Finding 2.
     */
    filePath?: string;
  };
  transcript: Transcript | null;
  frames: SelectedFrame[];
  processing: {
    selectedFrames: number; candidateFrames: number;
    peakRssMb: number; selectorVersion: string; frameMode: FrameMode;
    /**
     * Silent-degrade trail: each optional stage that failed and was degraded
     * past (dead/failed OCR, failed embeddings, failed ASR) records one
     * human-readable entry here. Empty on a fully-healthy run. Without this,
     * a manifest with status 'ok' was indistinguishable from one produced
     * with OCR and embeddings silently dead.
     */
    warnings: string[];
  };
}


/** Progress seams analyzeVideo reports through AnalyzeOptions.onStage (spec §7).
 *  A stage firing means that work is STARTING, not that it already
 *  succeeded -- each call is the first statement of its stage, before
 *  anything in it has actually run, so a caller sees it even when that
 *  stage goes on to fail. 'downloading' fires when media transfer genuinely
 *  begins (never on a metadata-only resolve); it is emitted from the resolver
 *  layer via the status context (src/status/context.ts), so it reaches
 *  agent-layer hooks but not a bare library caller's opts.onStage. */
export type AnalyzeStage = 'resolving' | 'downloading' | 'transcribing' | 'frames';

export interface AnalyzeOptions {
  start?: number; end?: number; maxFrames?: number; transcript?: boolean;
  frames?: FrameMode;
  /** Explicit override; outranks platform metadata (spec §4). */
  language?: string;
  preferredLanguage?: string;
  destinationPath?: string;
  outDir?: string;
  /** Called at pipeline seams; only for stages that actually run. A call
   *  means the stage is STARTING -- it does not mean the stage, or the
   *  overall analysis, went on to succeed. Failures in the callback are
   *  the caller's own problem -- not caught here. */
  onStage?: (stage: AnalyzeStage) => void;
}
