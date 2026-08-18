import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AnalyzeOptions, Manifest, Transcript, Candidate, SelectedFrame, FrameMode, CaptionTrack, ResolveOptions,
} from './types.js';
import { resolveFrameMode } from './types.js';
import { resolve } from './resolve/index.js';
import { probe, normalizeVideo, extractAudio, trim } from './media/ffmpeg.js';
import { FFmpegSceneDetector } from './media/scenes.js';
import { planCandidates, extractCandidates } from './media/candidates.js';
import { filterCandidates } from './vision/quality.js';
import { ocrFrame, computeTextNovelty } from './vision/ocr.js';
import { embedImages } from './vision/embed.js';
import { selectFrames } from './vision/select.js';
import { sampleEven, evenTimestamps } from './vision/even.js';
import { attachTranscript } from './align.js';
import { parseVtt, chooseCaptionTier, clampSegmentsToRange } from './transcript/captions.js';
import { chooseAsrEngine } from './transcript/routing.js';
import { transcribeAudio } from './transcript/asr.js';
import { ensureAsrModels } from './transcript/fetchModels.js';
import { resolveModelsDir } from './util/models.js';
import { buildManifest } from './manifest.js';
import { PeakRssTracker } from './util/rss.js';

// This module must NEVER import sherpa-onnx-node or @huggingface/transformers
// directly (spec §4/§19) -- only the driver modules above (transcribeAudio,
// embedImages), which spawn short-lived child processes that load those
// libraries, transcribe/embed, and exit. That process boundary is the entire
// memory strategy: it is what lets the ASR model's RSS be fully released
// before the vision model is ever loaded. Importing either library here
// directly would pull its native addon / ONNX runtime into the long-lived
// orchestrator process, permanently resident for the tool's whole lifetime.

/**
 * The caption track this run would actually transcribe from, or null if it
 * would have to fall back to local ASR.
 *
 * Deliberately ONE function serving two callers -- the stage-1 decision about
 * whether media is needed at all, and the transcript stage that builds the
 * transcript. If those two ever disagree, stage 1 skips the download and the
 * transcript stage then asks for audio that was never fetched.
 *
 * The existence check here is the one that decides, and it is deliberately
 * kept even though no current resolver can violate it: pickManualCaption
 * (src/resolve/ytdlp.ts) only reports a track it found on disk, and
 * downloadAutoTrack writes the file before returning one. Measured with
 * mutants rather than assumed:
 *  - deleting pickManualCaption's check alone changes NOTHING observable --
 *    this function backstops it (an equivalent mutant, and left as one);
 *  - deleting this one alone changes no end-to-end pipeline behaviour for
 *    the same reason in reverse, so it is pinned directly by
 *    tests/usableCaption.test.ts instead;
 *  - deleting BOTH turns a missing caption file from "fall back to ASR"
 *    into a readFileSync throw -- a hard extractor_failed for a video that
 *    merely lacks captions.
 * That last combination is the one that matters, and it is the reason the
 * pair stays. Exported so the contract can be tested directly, since the
 * pipeline cannot currently produce the input that exercises it.
 */
export function usableCaption(
  captions: { manual: CaptionTrack | null; auto: CaptionTrack | null },
): { tier: 'manual' | 'auto'; track: CaptionTrack } | null {
  const tier = chooseCaptionTier(captions);
  if (tier === 'asr') return null;
  const track = tier === 'manual' ? captions.manual! : captions.auto!;
  return existsSync(track.path) ? { tier, track } : null;
}

export async function analyzeVideo(url: string, opts: AnalyzeOptions = {}): Promise<Manifest> {
  // Computed once, up front: resolveFrameMode is a pure function of
  // frames/maxFrames, and both the catch-all failure manifest below and
  // every stage inside analyzeResolved need the same value (spec §8).
  const frameMode = resolveFrameMode(opts.frames, opts.maxFrames);
  const rss = new PeakRssTracker();
  rss.start();
  // Best-known source context for the catch-all failure manifest below --
  // updated as stages succeed, so a mid-pipeline throw still reports which
  // platform/title it got as far as resolving.
  const src = { platform: 'unknown', title: '', resolvedBy: 'none', duration: 0 };
  // Silent-degrade trail (Manifest.processing.warnings): shared with the
  // pipeline so degradations recorded before a later hard failure still
  // reach the failure manifest.
  const warnings: string[] = [];
  try {
    // Progress seam (spec §7): about to resolve. First statement of the try
    // block, before analyzeResolved runs anything, so a caller sees it even
    // if resolution itself fails.
    opts.onStage?.('resolving');
    return await analyzeResolved(url, opts, frameMode, rss, src, warnings);
  } catch (e) {
    // The documented contract (src/mcp.ts): analyze_video RETURNS a manifest
    // rather than throwing. Anything the stage-level handling below did not
    // absorb (normalize/probe/trim, filesystem errors, ...) becomes an
    // honest failure manifest here instead of a rejection.
    return buildManifest({
      url, platform: src.platform, title: src.title, duration: src.duration,
      resolvedBy: src.resolvedBy, status: 'extractor_failed',
      reason: `analysis failed: ${e instanceof Error ? e.message : String(e)}`,
      transcript: null, frames: [], candidateCount: 0, peakRssMb: rss.stop(), frameMode, warnings,
    });
  } finally {
    // ALWAYS stop the sampler -- on the throw path above, but also as a
    // backstop for any return path: in the long-lived MCP server a missed
    // stop() leaks a 250ms `ps -A` interval permanently, once per call.
    // stop() is idempotent (the timer is cleared and nulled).
    rss.stop();
  }
}

async function analyzeResolved(
  url: string, opts: AnalyzeOptions, frameMode: FrameMode, rss: PeakRssTracker,
  src: { platform: string; title: string; resolvedBy: string; duration: number },
  warnings: string[],
): Promise<Manifest> {
  const maxFrames = opts.maxFrames ?? 35;
  const workDir = opts.outDir ?? mkdtempSync(join(tmpdir(), 'norma-'));
  mkdirSync(workDir, { recursive: true });
  const framesDir = join(workDir, 'frames');
  mkdirSync(framesDir, { recursive: true });

  // 1. Resolve (preferredLanguage steers which caption track a resolver picks)
  //
  // Two-phase, because for one common shape the media file is never read at
  // all: a transcript-only request (frames 'none') against a video that has
  // platform captions. Nothing downstream opens it -- no normalize, no scene
  // detection, no WAV extraction -- so downloading it is pure waste. Measured
  // on a 27-minute YouTube video with manual captions: 285 MB and minutes of
  // transfer, for a 58 KB transcript.
  //
  // The chicken-and-egg (captions are only known AFTER resolving) is settled
  // by resolving metadata-only FIRST: yt-dlp's --skip-download still writes
  // the caption files and still reports duration -- verified directly against
  // the installed yt-dlp, and again end-to-end (888 KB, 3.4s, no media file).
  // If that cheap pass shows ASR will be needed after all, phase 2 fetches the
  // media exactly as before; the wasted phase-1 cost is one metadata call on
  // yt-dlp and literally nothing on the other two resolvers, whose
  // metadata-only branches touch the network not at all.
  //
  // Deliberately NOT extended to ranged requests. A range makes the media's
  // time base load-bearing: `clipRelative` below gates the caption clamp on
  // whether the media was really re-based, and skipping the download would
  // leave a whole-video transcript answering a "just this section" request,
  // plus a manifest duration that silently changed meaning from clip to
  // source. That is the invariant CLAUDE.md marks load-bearing, with tests
  // pinned in both directions; the measured win here is the whole-video case
  // anyway. Recorded in docs/follow-ups.md rather than half-done.
  const wantsRange = opts.start !== undefined && opts.end !== undefined;
  const mightSkipMedia = frameMode === 'none' && opts.transcript !== false && !wantsRange;
  const resolveOpts: ResolveOptions = {
    start: opts.start, end: opts.end, workDir, preferredLanguage: opts.preferredLanguage,
  };
  let res = await resolve(url, mightSkipMedia ? { ...resolveOpts, returnVideo: false } : resolveOpts);
  // Phase 2: the cheap pass produced no media and the transcript will need
  // ASR, so fetch it for real. The `filePath === ''` term is what keeps a
  // LOCAL file path out of this branch -- resolve() short-circuits those
  // before dispatch and hands back the real path (with no captions), so
  // re-resolving would re-probe a file already in hand.
  if (res.status === 'ok' && mightSkipMedia && res.filePath === '' && !usableCaption(res.captions)) {
    res = await resolve(url, resolveOpts);
  }
  if (res.status !== 'ok') {
    return buildManifest({
      url, platform: 'unknown', title: '', duration: 0, resolvedBy: res.resolvedBy ?? 'none',
      status: res.status, reason: typeof res.reason === 'string' ? res.reason : res.message,
      transcript: null, frames: [], candidateCount: 0, peakRssMb: rss.stop(), frameMode, warnings,
    });
  }
  src.platform = res.platform; src.title = res.title;
  src.resolvedBy = res.resolvedBy; src.duration = res.duration;

  // 2. Apply the range if the resolver could not (spec §18: optimization, not
  // guarantee). `clipRelative` tracks whether `media` (and later `video` /
  // `meta.duration`) now covers exactly [start,end] rather than the whole
  // source -- the 'even' dispatch in stage 5-7 needs to know this to sample
  // in the right time base.
  let media = res.filePath;
  let clipRelative = res.rangeApplied;
  // No media file on disk -- the phase-1 resolve above was enough. Stated as
  // a fact about what is on disk rather than as a copy of the decision that
  // led here, so a phase-2 download that somehow produced nothing is treated
  // as "no media" too (the ASR guard below then fails loudly) instead of
  // being assumed present.
  const mediaSkipped = media === '';
  if (opts.start !== undefined && opts.end !== undefined && !res.rangeApplied) {
    if (frameMode === 'even' && opts.start === opts.end) {
      // Single-instant even-sampling request (spec §8's canonical example:
      // start===end, maxFrames:1). ffmpeg's `-ss X -to X` trim fails
      // outright -- verified directly against this project's trim(): exit
      // code 234, stderr "-to value smaller than -ss; aborting", no output
      // file produced at all -- so there is no clip to pre-trim here.
      // `clipRelative` stays false (its `res.rangeApplied` initial value,
      // false on this branch) and the dispatch below samples the untrimmed,
      // normalized source directly at the absolute timestamp instead.
      //
      // Deliberately gated to 'even' specifically, not any start===end
      // request: an unconditional skip would let 'key' mode silently run
      // scene detection over the WHOLE video for a "single instant" request
      // and return frames from outside the requested range, violating spec
      // §2.2 ("Frame selection is bounded to the range, in both modes").
      // 'key' + start===end keeps failing loudly via trim() below, exactly
      // as it did before this task.
    } else {
      media = await trim(media, opts.start, opts.end, join(workDir, 'clip.mp4'));
      clipRelative = true;
    }
  }

  // 3. Normalize -- spec §8 / Fix 2: only pay for what this call needs.
  // 'key' is the only mode that needs the re-encoded, canonical-format copy
  // (scene detection, candidate extraction and quality filtering all assume
  // it); 'even' and 'none' sample or skip the un-normalized media directly
  // -- ffprobe/ffmpeg handle whatever container the resolver produced, and
  // single-frame extraction does not care. This is the cost spec §8 named
  // (re-encoding a two-hour source, plus a full WAV extraction below, to
  // answer a one-frame request) that the model-stage short-circuiting alone
  // (tests/analyzeShortcircuit.integration.test.ts) never removed.
  const video = frameMode === 'key' ? (await normalizeVideo(media, workDir)).video : media;
  // With no media there is nothing to probe -- and probing '' would throw
  // into the catch-all, turning every skipped download into an
  // extractor_failed. The extractor's own duration is a genuine measurement,
  // not a placeholder: yt-dlp scrapes it during extraction, wholly
  // independent of the download step (see src/resolve/ytdlp.ts's note on the
  // same field). Reachable only when a caption track was found, which is
  // exactly the case where a real extractor supplied that metadata --
  // direct/wechat return duration 0 as a type placeholder, and both also
  // return no captions, so neither can arrive here.
  const meta = mediaSkipped ? { duration: res.duration } : await probe(video);
  src.duration = meta.duration;

  // ASR routing depends only on preferredLanguage/languageHint, so the same
  // engine choice governs both the transcript stage and OCR's language pack
  // below -- computed once so the two decisions can't silently diverge.
  const engine = chooseAsrEngine({ preferredLanguage: opts.preferredLanguage, languageHint: res.languageHint });

  // 4. Transcript -- STAGE 1 (ASR worker runs and exits before any vision work)
  let transcript: Transcript | null = null;
  if (opts.transcript !== false) {
    // Progress seam (spec §7): the transcript stage is actually about to run.
    opts.onStage?.('transcribing');
    // Fix 2 (spec §8): the WAV extraction is real cost -- a full 16kHz decode
    // pass over the whole source. It is now deferred until captions have
    // actually been ruled out, because platform captions win whenever they
    // exist: extracting first would pay the decode on every captioned video
    // and then throw the result away. `audio` stays null until that happens,
    // which is also what the cleanup below keys on.
    let audio: string | null = null;
    try {
      // ANY platform caption beats local speech recognition -- manual first,
      // then automatic, with local ASR as the fallback only when the video
      // carries no captions at all. chooseCaptionTier documents the measured
      // comparison that reversed the original accuracy bias.
      // usableCaption() -- the SAME call stage 1 made to decide whether the
      // media was needed. Sharing it is what guarantees the two agree.
      const cap = usableCaption(res.captions);
      if (cap) {
        let segments = parseVtt(readFileSync(cap.track.path, 'utf8'));
        // Caption files carry ABSOLUTE full-video timestamps. `clipRelative`
        // (declared at :99, set true at :120) is true exactly when `video`
        // -- and therefore every frame timestamp -- has been re-based onto a
        // 0-based clip, whether the resolver applied the range itself or
        // stage 2's trim() did, so only then must captions be re-based too,
        // or every transcriptWindow would be shifted by `start` seconds.
        // Gating on `clipRelative` in addition to opts.start/opts.end (the
        // same flag stage 5-7 already uses at :212-213) is what keeps this
        // correct on the 'even'+start===end carve-out above: there
        // clipRelative stays false, trim() never ran, and both `video` and
        // every frame timestamp stay in ABSOLUTE time, so clamping here
        // would be exactly the bug this gate exists to avoid --
        // clampSegmentsToRange(segs, start, start) would collapse a caption
        // straddling `start` to a zero-width {0,0} segment that no longer
        // lines up with the frame's real (absolute) timestamp, silently
        // corrupting transcript.segments rather than just transcriptWindow.
        if (opts.start !== undefined && opts.end !== undefined && clipRelative) {
          segments = clampSegmentsToRange(segments, opts.start, opts.end);
        }
        transcript = {
          // The TRACK's own language, not the video's: a deliberately-picked
          // English caption file for a French video is in English.
          language: cap.track.language ?? res.languageHint ?? 'unknown',
          source: cap.tier,
          segments,
        };
      }
      // No usable caption track: this is the only path that needs audio, so
      // it is also the only path that pays for extracting it.
      if (!transcript) {
        // Unreachable by construction -- stage 1 skips the download only when
        // usableCaption() returned a track, and this line is reached only when
        // that same call returned null. Asserted rather than assumed because
        // the failure it guards is silent: extractAudio('') would hand ffmpeg
        // an empty path, and the resulting failure would read as "this video's
        // audio could not be decoded" rather than "the pipeline never fetched
        // it". If these two decisions ever drift apart, say so.
        if (mediaSkipped) {
          throw new Error(
            'internal: transcription needs audio, but stage 1 skipped the media download '
            + '(usableCaption disagreed with itself between stage 1 and the transcript stage)',
          );
        }
        ({ audio } = await extractAudio(media, workDir));
      }
      if (transcript === null && audio !== null && existsSync(audio)) {
        // preferredLanguage is passed through (not dropped): pickSenseVoiceLanguage
        // falls back to it when SenseVoice's own raw per-segment language signal
        // isn't usable (routing.ts; the common case on the current sherpa-onnx-node
        // build per task-11-report.md), so wiring it through is what lets a
        // caller-declared language reach transcript.language honestly instead of
        // silently downgrading to 'auto'.
        // Fetch the speech models if this machine has not got them yet.
        // The LAST possible moment on purpose: a captioned video, or
        // transcript:false, must never trigger a ~1.5GB download, and only
        // here is it certain that local recognition is genuinely the answer.
        // Only the engine actually chosen is fetched (1.3GB Whisper versus
        // 233MB SenseVoice). Failure falls into the same catch below and
        // degrades to a recorded warning, exactly as a missing model did
        // before this existed.
        transcript = await ensureAsrModels(engine, resolveModelsDir())
          .then(() => transcribeAudio(audio!, { engine, preferredLanguage: opts.preferredLanguage }))
          .catch((e: unknown) => {
          // Same silent-degrade class as OCR/embeddings below: a null
          // transcript is otherwise indistinguishable from "no speech found".
          warnings.push(`asr failed: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
      }
    } finally {
      // Fix 6 (deferred #18, leak half): nothing downstream ever references
      // work.wav -- Manifest has no field for it -- so it is always safe to
      // remove once this stage is done with it, whether that stage ended in
      // a transcript, a degraded-but-recorded ASR failure, or (via this
      // finally) an unexpected throw from caption parsing. Best-effort: a
      // failed delete must never fail the call. Deliberately scoped to
      // exactly the block that created `audio` (Fix 2's transcript!==false
      // gate) -- an unconditional end-of-function cleanup would also mop up
      // after a REGRESSION that extracted audio unconditionally, silently
      // hiding exactly the file-existence check Fix 2's own tests rely on.
      // Null when captions supplied the transcript and no WAV was ever made.
      if (audio !== null) { try { rmSync(audio, { force: true }); } catch { /* best-effort */ } }
    }
  }

  // 5-7. Frames -- frame-mode dispatch (spec §8). 'none' and 'even'
  // deliberately skip scene detection, quality filtering, OCR and
  // embeddings: a caller asking for one frame at a timestamp must not pay
  // for the full pipeline. Those are exactly the stages with a resident (or
  // subprocess-loaded) model or heavyweight native call; short-circuiting
  // before them is the entire point of this task.
  let frames: SelectedFrame[] = [];
  let candidateCount = 0;

  if (frameMode === 'even') {
    // Progress seam (spec §7): emitted here, not above the dispatch, so
    // frameMode === 'none' -- which reaches neither branch -- emits nothing.
    opts.onStage?.('frames');
    // Fix 4(b): a half-specified range must be genuinely ignored here too,
    // matching stage 2's own trim gate above and the documented "either
    // alone is ignored" claim (src/mcp.ts) -- both bounds or neither.
    // Falling back independently per-bound (the pre-fix shape) let a lone
    // `start` silently narrow the sampling window to [start, duration) while
    // leaving the download/transcript untouched: a three-way split nothing
    // documented.
    const bothBoundsGiven = opts.start !== undefined && opts.end !== undefined;
    const from = bothBoundsGiven ? opts.start! : 0;
    const to = bothBoundsGiven ? opts.end! : meta.duration;
    // `video` is already trimmed to [start,end] whenever clipRelative is
    // true (either the resolver applied the range, or stage 2's trim() did),
    // so sample in clip time. In the single-instant carve-out above,
    // clipRelative is false and lo/hi fall back to the absolute timestamps,
    // since there is no trimmed clip to be relative to.
    const lo = (opts.start !== undefined && clipRelative) ? 0 : from;
    const hi = (opts.end !== undefined && clipRelative) ? meta.duration : to;
    // What sampleEven SHOULD produce for this window/budget, per its own
    // (pure, exported) timestamp planner -- the honest baseline to compare
    // actual output against. Comparing against raw `maxFrames` instead would
    // spuriously warn on every single-instant request with maxFrames > 1,
    // since evenTimestamps collapses a zero-length window to exactly one
    // stamp BY DESIGN, not as a shortfall.
    const requested = evenTimestamps(lo, hi, maxFrames).length;
    const cands = await sampleEven(video, lo, hi, maxFrames, framesDir);
    candidateCount = cands.length;
    if (cands.length < requested) {
      // sampleEven silently drops a timestamp it fails to extract (an
      // unseekable point) rather than throwing -- record it here so a
      // caller can tell "fewer frames than asked for, and here's why" apart
      // from a healthy, fully-satisfied request (Manifest.processing.warnings'
      // whole purpose: a degraded-but-'ok' run must leave a trace).
      warnings.push(
        `even sampling requested ${requested} frame(s) across [${lo}, ${hi}) but only `
        + `extracted ${cands.length}; some timestamps were not seekable`,
      );
    }
    frames = cands.map((c) => ({
      timestamp: c.timestamp, sceneId: 0, image: c.imagePath,
      importance: 0, reasons: ['even_sample'],
      ocrContent: null, transcriptWindow: null, nearestSelectedSimilarity: 0,
    }));
  } else if (frameMode === 'key') {
    // Progress seam (spec §7): mirrors the 'even' branch above -- same
    // reasoning, so 'none' still emits nothing.
    opts.onStage?.('frames');
    // 5. Candidates -> quality filter -> OCR -> text novelty. No resident
    // model in this block (scene detection/candidates/quality/OCR are all
    // subprocess or cheap-native), but two of its steps can genuinely throw:
    //  - FFmpegSceneDetector.detect() on a hard ffmpeg failure (corrupt/empty
    //    normalized video), and
    //  - filterCandidates() when EVERY candidate in a non-empty batch fails to
    //    SCORE (src/vision/quality.ts) -- added deliberately (Task 7) so a
    //    systemic failure (broken sharp install, a corrupted extraction batch)
    //    cannot silently look identical to "this video legitimately has no
    //    interesting frames". Both failure modes mean the same thing from here:
    //    "no usable candidates" -- so both are caught by one boundary around
    //    the whole candidate-generation stage, surfaced as an honest non-'ok'
    //    manifest rather than swallowed into an empty-but-'ok' frame list
    //    (which would silently restore exactly the failure mode Task 7 added
    //    the throw to prevent) or left to reject analyzeVideo's promise.
    let cands: Candidate[] = [];
    try {
      const boundaries = await new FFmpegSceneDetector().detect(video);
      const plan = planCandidates(meta.duration, boundaries);
      cands = await extractCandidates(video, plan, framesDir);
      candidateCount = cands.length;
      cands = await filterCandidates(cands);

      const langs = engine === 'sensevoice' ? 'chi_sim+eng' : 'eng';
      // Per-frame OCR failures degrade (empty text) but are RECORDED: a dead
      // tesseract (missing binary, missing language pack) fails every frame
      // and collapses to one summary warning; isolated per-frame failures are
      // listed individually. ocrFrame/ocrBuffer now propagate real failures
      // (nonzero tesseract exit, spawn error) instead of swallowing them into
      // '' -- an empty string still means "no text seen", honestly.
      const ocrFailures: string[] = [];
      for (const c of cands) {
        try {
          const { content, subtitle } = await ocrFrame(c.imagePath, langs);
          c.ocrContent = content; c.ocrSubtitle = subtitle;
        } catch (e) {
          c.ocrContent = ''; c.ocrSubtitle = '';
          ocrFailures.push(`ocr failed for frame at ${c.timestamp.toFixed(2)}s: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (ocrFailures.length > 0 && ocrFailures.length === cands.length) {
        warnings.push(`ocr unavailable: all ${cands.length} candidate frames failed (first: ${ocrFailures[0]})`);
      } else {
        warnings.push(...ocrFailures);
      }
      // One pass over the FULL surviving batch, not chunked: computeTextNovelty's
      // persistence check looks one candidate ahead to decide whether a text
      // change holds (genuine) or churns (subtitle/OCR noise), so only the
      // batch's true final candidate should ever fall back to full weight.
      // Splitting this call would manufacture an artificial "last candidate"
      // at every chunk boundary, multiplying the one-frame edge case that
      // computeTextNovelty's own doc comment already accepts at the real end.
      cands = computeTextNovelty(cands);
    } catch (e) {
      return buildManifest({
        url, platform: res.platform, title: res.title, duration: meta.duration,
        resolvedBy: res.resolvedBy, status: 'extractor_failed',
        reason: `candidate pipeline failed: ${e instanceof Error ? e.message : String(e)}`,
        transcript, frames: [], candidateCount, peakRssMb: rss.stop(), frameMode, warnings,
      });
    }

    // 6. Embeddings -- STAGE 2 (vision worker; ASR already exited)
    let embedError: string | null = null;
    const vectors = await embedImages(cands.map((c) => c.imagePath)).catch((e: unknown) => {
      embedError = e instanceof Error ? e.message : String(e);
      return [] as number[][];
    });

    // Guarded assignment: embedImages returns `[]` (never a dropped array
    // entry) in a candidate's slot when that one image failed to embed, to
    // preserve index alignment with `cands` (src/vision/embed.ts). Only ever
    // assign a REAL vector; a candidate whose embed failed keeps `embedding`
    // unset. This alone is necessary but NOT sufficient: an empty array and
    // `undefined` are provably indistinguishable to src/vision/select.ts's
    // selectFrames today (cosine([], x) truncates to length 0 and returns
    // exactly 0, the same value maxSim already defaults to when `c.embedding`
    // is falsy -- verified directly against the compiled selector, see
    // task-14-report.md), so leaving the array unassigned changes nothing about
    // that candidate's own selection score by itself.
    let anyEmbedded = false;
    cands.forEach((c, i) => {
      const v = vectors[i];
      if (v && v.length) { c.embedding = v; anyEmbedded = true; }
    });
    if (anyEmbedded) {
      // The actual fix: drop a candidate whose embedding failed, but ONLY when
      // at least one other candidate in this batch embedded successfully.
      // Rationale: selectFrames treats "no embedding" as maxSim=0, i.e.
      // unpenalized for similarity to whatever is already picked -- the most
      // favorable score the diversity term can produce. A real embedded
      // candidate almost never scores that well (two genuinely different
      // images still cosine-similarity high in practice -- Task 12 measured
      // 0.82 between two flat, unrelated colours), so an embedding-less
      // candidate would systematically outrank ones we can actually vouch for.
      // Dropping it is safe here specifically because these images already
      // passed filterCandidates' own sharp-decode gate upstream, so a
      // SigLIP-only failure on one of them is a genuine anomaly, not the
      // common case. When NONE embedded (worker crashed, model unavailable,
      // no network) every candidate is treated identically -- keep them all,
      // since a uniform maxSim=0 is an unbiased degrade, not a bias toward any
      // particular frame, and dropping the whole pool would silently turn a
      // healthy video into an empty result.
      cands = cands.filter((c) => c.embedding !== undefined);
    }
    if (embedError !== null) {
      warnings.push(`embedding failed: ${embedError}`);
    } else if (!anyEmbedded && cands.length > 0) {
      warnings.push('embedding produced no vectors; similarity dedupe is disabled for this run');
    }

    // 7. Select
    frames = selectFrames(cands, maxFrames, meta.duration);
  }
  // frameMode === 'none': frames stays [], candidateCount stays 0 -- no
  // scene detection, no quality filter, no OCR, no embeddings run at all.

  if (transcript && frames.length > 0) frames = attachTranscript(frames, transcript.segments);

  return buildManifest({
    url, platform: res.platform, title: res.title, duration: meta.duration,
    resolvedBy: res.resolvedBy, status: 'ok', filePath: video,
    transcript, frames, candidateCount, peakRssMb: rss.stop(), frameMode, warnings,
  });
}
