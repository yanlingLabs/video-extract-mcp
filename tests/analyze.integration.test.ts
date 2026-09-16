import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { makeTestVideo } from '../src/media/ffmpeg.js';
import { SELECTOR_VERSION } from '../src/vision/select.js';
// getClip has no import.meta.url-relative worker to spawn (plain ffmpeg
// subprocess calls via run()), so -- unlike analyzeVideo below -- there is
// no source-vs-dist trap for it; tests/primitives.test.ts already imports it
// straight from src/ for the same reason.
import { getClip } from '../src/primitives.js';

// analyzeVideo (and its whole transitive import graph) is loaded from the
// COMPILED dist/ output, NOT the TS source -- requires `npm run build` first
// (see package.json's test script / this task's Step 5). This is not a style
// preference: src/transcript/asr.ts and src/vision/embed.ts locate their
// worker scripts via `dirname(fileURLToPath(import.meta.url)) + 'asrWorker.js'
// / 'embedWorker.js'` -- a relative path that only resolves once compiled
// (asrWorker.js/embedWorker.js exist as siblings only in dist/, never in
// src/, which has just the .ts originals). vitest's convenience .js->.ts
// resolution means `import('../src/analyze.js')` would silently load the
// SOURCE instead, and both workers would then fail to spawn
// (MODULE_NOT_FOUND) -- caught and swallowed by analyze.ts's own
// `.catch(() => null / [])` fallbacks, so a test asserting only "frames.length
// > 0" would PASS while never having run a real model. Verified directly
// against this exact test file before this fix: 'produces a manifest with
// frames...' passed while the embed worker threw
// `embed worker failed: ... MODULE_NOT_FOUND` on every call, and the
// transcript-asserting test caught the identical failure on the ASR worker
// (see task-14-report.md for both literal traces). This matches the
// established pattern already used by tests/asr.integration.test.ts and
// tests/embed.integration.test.ts, which both import their subject from
// dist/ for exactly this reason.
vi.mock('../dist/vision/embed.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../dist/vision/embed.js')>();
  return { ...real, embedImages: vi.fn(real.embedImages) };
});
vi.mock('../dist/vision/quality.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../dist/vision/quality.js')>();
  return { ...real, filterCandidates: vi.fn(real.filterCandidates) };
});
vi.mock('../dist/resolve/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../dist/resolve/index.js')>();
  return { ...real, resolve: vi.fn(real.resolve) };
});
vi.mock('../dist/media/ffmpeg.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../dist/media/ffmpeg.js')>();
  // Fix 2 split normalize() into normalizeVideo()/extractAudio(); analyze.ts
  // now calls those directly (normalize() itself has no callers left in
  // src/). Both are wrapped -- not just normalize -- so a test overriding
  // either half's implementation (e.g. to simulate a throw) actually
  // intercepts the call analyze.ts makes.
  return {
    ...real,
    normalize: vi.fn(real.normalize),
    normalizeVideo: vi.fn(real.normalizeVideo),
    extractAudio: vi.fn(real.extractAudio),
  };
});
vi.mock('../dist/vision/ocr.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../dist/vision/ocr.js')>();
  return { ...real, ocrFrame: vi.fn(real.ocrFrame) };
});

// Imported AFTER the vi.mock calls above (textually and, more importantly,
// semantically -- vitest hoists vi.mock factories ahead of all imports in
// this module regardless of position), so these bindings are the mocked
// wrappers: vi.fn()-wrapped but calling straight through to the real
// implementation until a test overrides them with .mockImplementationOnce().
const { analyzeVideo } = await import('../dist/analyze.js');
const { buildManifest } = await import('../dist/manifest.js');
const { embedImages } = await import('../dist/vision/embed.js');
const { filterCandidates } = await import('../dist/vision/quality.js');
const { resolve } = await import('../dist/resolve/index.js');
const { normalizeVideo, extractAudio } = await import('../dist/media/ffmpeg.js');
const { ocrFrame } = await import('../dist/vision/ocr.js');

/** A deterministic, distinct, already-unit-norm 768-dim vector per index. */
function unitVec(i: number): number[] {
  const v = new Array(768).fill(0) as number[];
  v[i % 768] = 1;
  return v;
}

// Guards the one test that requires the real ASR models on disk (mirrors
// tests/asr.integration.test.ts's own guard) so this suite degrades
// gracefully -- skips cleanly, does not fail -- on a machine that has the
// project built but hasn't fetched the ~1.5GB of ASR models.
const ASR_MODELS_READY = existsSync('models/silero_vad.onnx') && existsSync('models/sherpa-onnx-whisper-small');

describe('analyzeVideo (local file, end to end)', () => {
  it('produces a manifest with frames from a local synthetic video', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    const m = await analyzeVideo(`file://${v}`.replace('file://', ''), {
      maxFrames: 4, transcript: false, outDir: join(dir, 'out'),
    });
    expect(m.source.status).toBe('ok');
    expect(m.frames.length).toBeGreaterThan(0);
    expect(m.frames.length).toBeLessThanOrEqual(4);
    expect(m.processing.peakRssMb).toBeGreaterThan(0);
    expect(m.processing.selectorVersion).toBe(SELECTOR_VERSION);
    expect(m.processing.candidateFrames).toBeGreaterThan(0);
    expect(existsSync(m.frames[0]!.image)).toBe(true);
    // Every selected frame's image must be a real file, not just the first.
    for (const f of m.frames) expect(existsSync(f.image)).toBe(true);
    // source.filePath closes the coarse-to-fine handoff (task-16-report.md
    // Finding 2): a real, existing local path to the NORMALIZED working
    // video (basename fixed by normalize() in src/media/ffmpeg.ts) -- not
    // the original download, and not one of the per-frame keyframe JPEGs
    // above, which is what get_frame/get_clip need to operate on afterwards.
    expect(typeof m.source.filePath).toBe('string');
    expect(existsSync(m.source.filePath!)).toBe(true);
    expect(statSync(m.source.filePath!).size).toBeGreaterThan(0);
    expect(basename(m.source.filePath!)).toBe('work.mp4');
    // Printed, not just asserted on: the brief asks to "inspect the printed
    // peakRssMb", and a report claiming embeddings ran needs more than
    // "frames exist" -- two grid-textured frames sampled seconds apart
    // inside the SAME static colour segment (e.g. the two blue-segment
    // candidates at ~3.35s/5s) are near pixel-identical, so a genuine SigLIP
    // embedding run must produce a real nonzero cosine similarity for at
    // least one selected frame against another; if the embed worker silently
    // failed (as it did before this suite was fixed to import from dist/ --
    // see the note at the top of this file), EVERY nearestSelectedSimilarity
    // would read exactly 0, with no exceptions.
    const maxSim = Math.max(...m.frames.map((f) => f.nearestSelectedSimilarity));
    console.log('[test1] processing:', JSON.stringify(m.processing), 'maxNearestSelectedSimilarity:', maxSim);
    expect(maxSim).toBeGreaterThan(0);
    // A fully-healthy run records NO degradation warnings -- and the field
    // itself must exist (the silent-degrade trail, review IMPORTANT-6).
    expect(m.processing.warnings).toEqual([]);
  }, 900_000);

  it('returns a clean failure manifest for an unresolvable URL', async () => {
    const m = await analyzeVideo('https://example.invalid/nope', { transcript: false });
    expect(m.source.status).not.toBe('ok');
    expect(m.frames).toEqual([]);
    expect(m.transcript).toBeNull();
    expect(m.processing.peakRssMb).toBeGreaterThan(0);
    // A failure manifest must NOT claim a filePath -- there is no normalized
    // working video on a path that never resolved, and a present-but-wrong
    // filePath would be worse than omitting it (an agent could feed it
    // straight to get_frame/get_clip and get a confusing failure instead of
    // checking source.status first, which is already the documented
    // contract in src/mcp.ts's analyze_video description).
    expect(m.source.filePath).toBeUndefined();
    expect('filePath' in m.source).toBe(false);
  }, 300_000);

  it("closes the coarse-to-fine loop: a successful manifest's filePath can be fed straight into getClip and returns real frames", async () => {
    // This is the test the whole fix is FOR (task-16-report.md Finding 2):
    // an agent that ran analyze_video, spotted something at a timestamp, and
    // wants a closer look must be able to take source.filePath verbatim and
    // hand it to get_clip -- not just observe that some string was returned.
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-loop-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    const m = await analyzeVideo(v, { maxFrames: 2, transcript: false, outDir: join(dir, 'out') });
    expect(m.source.status).toBe('ok');
    expect(typeof m.source.filePath).toBe('string');
    const frames = await getClip(m.source.filePath!, 2, 5, 1, join(dir, 'clip-out'));
    // Exact count (3), matching the same fps=1-over-[2,5)-on-a-9s-fixture
    // baseline already established in tests/primitives.test.ts and
    // tests/mcp.test.ts -- not just "at least one frame", which would pass
    // even for a getClip call against a wrong or empty file in some cases.
    expect(frames).toHaveLength(3);
    expect(frames.every((f) => existsSync(f) && statSync(f).size > 0)).toBe(true);
  }, 120_000);

  it('never calls extractAudio() when transcript is false (spec §8 cost, independent of cleanup)', async () => {
    // The file-existence assertions in analyzeShortcircuit cannot see this
    // anymore: Fix 6 deletes work.wav unconditionally once the transcript
    // stage is done, so "no work.wav on disk afterwards" is now true whether
    // or not the WAV was ever extracted. A reviewer's mutation proved it --
    // hoisting extractAudio() back out of the transcript gate, paired with
    // that cleanup, passed all 33 tests in the two integration suites while
    // silently reinstating the whole per-second cost spec §8 forbids.
    // Spying on the call itself is the only timing-free assertion that
    // survives the cleanup, which is why it lives here (this suite wraps
    // ffmpeg) rather than beside its file-existence siblings.
    vi.mocked(extractAudio).mockClear();
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-noaudio-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    const m = await analyzeVideo(v, { maxFrames: 2, transcript: false, outDir: join(dir, 'out') });
    expect(m.source.status).toBe('ok');
    expect(extractAudio).not.toHaveBeenCalled();
  }, 120_000);

  it('respects the maxFrames budget when more candidates survive than the budget allows', async () => {
    // Mocked embed (fast, deterministic) -- this test is about the budget
    // wiring, not embedding correctness, so it doesn't need the real worker.
    vi.mocked(embedImages).mockImplementationOnce(async (paths: string[]) => paths.map((_, i) => unitVec(i)));
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-budget-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    const m = await analyzeVideo(v, { maxFrames: 2, transcript: false, outDir: join(dir, 'out') });
    expect(m.source.status).toBe('ok');
    // The 9s grid fixture yields more raw candidates than the budget -- this
    // is what makes the assertion below a genuine constraint, not a number
    // that happens to already fit.
    expect(m.processing.candidateFrames).toBeGreaterThan(2);
    expect(m.frames.length).toBe(2);
  }, 120_000);

  it.skipIf(!ASR_MODELS_READY)(
    'runs ASR to completion before the vision worker starts, in one real call (spec §4/§19 staged memory)',
    async () => {
      // The one test in this file that exercises BOTH real staged workers in
      // a single analyzeVideo() call -- proving the sequencing claim this
      // whole task exists to implement, not just that each worker
      // independently works (that was already proven in Tasks 11/12). The
      // fixture's audio track is silent (anullsrc), so VAD legitimately
      // finds no speech and Whisper returns zero segments -- that is still a
      // real ASR run (model loaded, VAD executed, worker exited), just an
      // honest empty transcript, not a fabricated one. Guarded by
      // ASR_MODELS_READY (skips, does not fail, when models aren't fetched)
      // -- everything else in this suite needs no ASR model at all.
      const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-staged-'));
      const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
      const m = await analyzeVideo(v, { maxFrames: 4, outDir: join(dir, 'out') });
      expect(m.source.status).toBe('ok');
      expect(m.transcript).not.toBeNull();
      expect(m.transcript!.source).toBe('asr');
      expect(Array.isArray(m.transcript!.segments)).toBe(true);
      expect(m.frames.length).toBeGreaterThan(0);
      console.log('[staged] processing:', JSON.stringify(m.processing), 'transcript:', JSON.stringify(m.transcript));
      expect(m.processing.peakRssMb).toBeGreaterThan(0);
      // Spec §4's memory bound, asserted -- not just printed. This is the
      // architectural tripwire: the bound holds BECAUSE the two model stages
      // run as sequential short-lived workers, so parallelising them (both
      // models resident at once) is exactly the change this would catch.
      // Honesty note: the fixture's audio is silent, so VAD short-circuits
      // and Whisper's weights may never fully load -- the bound is loose
      // here, a ceiling tripwire rather than proof of the worst-case peak
      // (that proof is the acceptance matrix's job on real videos).
      expect(m.processing.peakRssMb).toBeLessThan(2048);
    },
    900_000,
  );
});

describe('analyzeVideo -- range + captions alignment (B3)', () => {
  it('re-bases full-video caption timestamps to the requested range so transcript and frames agree', async () => {
    // Caption files always cover the FULL video with ABSOLUTE timestamps
    // (verified: yt-dlp writes subtitle tracks whole even under
    // --download-sections), while the analyzed media is a 0-based clip.
    // Without re-basing, every transcriptWindow is shifted by `start`
    // seconds and the manifest carries the whole video's transcript
    // against a short frame set.
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-range-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    const vtt = join(dir, 'caps.vtt');
    writeFileSync(vtt, [
      'WEBVTT', '',
      '00:00:00.500 --> 00:00:01.500', 'BEFORE_RANGE_MARKER', '',
      '00:00:04.000 --> 00:00:05.000', 'ALPHA_MARKER', '',
      '00:00:08.000 --> 00:00:08.500', 'OMEGA_MARKER', '',
    ].join('\n'));

    vi.mocked(resolve).mockImplementationOnce(async () => ({
      status: 'ok', filePath: v, platform: 'test', title: 'T', duration: 9,
      resolvedBy: 'ytdlp', captions: { manual: { path: vtt, language: 'en' }, auto: null },
      languageHint: 'en', rangeApplied: false,
    }));

    const m = await analyzeVideo('https://range.example/watch?v=x', {
      start: 3, end: 9, maxFrames: 4, outDir: join(dir, 'out'),
    });
    expect(m.source.status).toBe('ok');
    expect(m.transcript).not.toBeNull();
    expect(m.transcript!.source).toBe('manual');
    // Clip-relative and clipped: the pre-range cue is gone, the others are
    // shifted by exactly -start. (Cue times chosen to subtract exactly in
    // binary floating point.)
    expect(m.transcript!.segments).toEqual([
      { start: 1, end: 2, text: 'ALPHA_MARKER' },
      { start: 5, end: 5.5, text: 'OMEGA_MARKER' },
    ]);
    // And no frame's aligned window may quote text from before the range.
    expect(m.frames.length).toBeGreaterThan(0);
    for (const f of m.frames) {
      expect(f.transcriptWindow ?? '').not.toContain('BEFORE_RANGE_MARKER');
    }
  }, 120_000);
});

describe('analyzeVideo -- platform captions beat local ASR', () => {
  it('uses an AUTOMATIC caption track instead of transcribing locally, and never extracts audio', async () => {
    // The policy reversal, end to end. Two independent claims, because the
    // old behaviour would fail each for a different reason: it returned
    // source 'asr' (auto tracks were discarded), and it paid for a full
    // 16kHz decode pass before even consulting the tier.
    vi.mocked(extractAudio).mockClear();
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-auto-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    const vtt = join(dir, 'auto.en.vtt');
    // Rolling cues, exactly as a real automatic track emits them: a ~10ms
    // scroll cue, then a cue repeating the line before appending.
    writeFileSync(vtt, [
      'WEBVTT', 'Kind: captions', 'Language: en', '',
      '00:00:01.000 --> 00:00:02.000 align:start position:0%',
      'AUTO_ALPHA<00:00:01.500><c> tail</c>', '',
      '00:00:02.000 --> 00:00:02.010 align:start position:0%',
      'AUTO_ALPHA tail', '',
      '00:00:02.010 --> 00:00:04.000 align:start position:0%',
      'AUTO_ALPHA tail', 'AUTO_BRAVO', '',
    ].join('\n'));

    vi.mocked(resolve).mockImplementationOnce(async () => ({
      status: 'ok', filePath: v, platform: 'test', title: 'T', duration: 9,
      resolvedBy: 'ytdlp', captions: { manual: null, auto: { path: vtt, language: 'en' } },
      languageHint: 'en', rangeApplied: false,
    }));

    const m = await analyzeVideo('https://auto.example/watch?v=x', {
      maxFrames: 2, outDir: join(dir, 'out'),
    });

    expect(m.source.status).toBe('ok');
    expect(m.transcript).not.toBeNull();
    expect(m.transcript!.source).toBe('auto');
    // Deduplicated: 'AUTO_ALPHA tail' appears in all three cues but must
    // reach the agent once, and the scroll cue must not survive at all.
    expect(m.transcript!.segments).toEqual([
      { start: 1, end: 2, text: 'AUTO_ALPHA tail' },
      { start: 2.01, end: 4, text: 'AUTO_BRAVO' },
    ]);
    // The efficiency half: captions made the WAV unnecessary, so it was
    // never produced. Asserting the call, not the file, because cleanup
    // deletes the file either way and would mask a regression.
    expect(extractAudio).not.toHaveBeenCalled();
  }, 120_000);

  it('still falls back to local ASR when the video has no captions at all', async () => {
    // Guards the other direction: a fix that simply stopped calling ASR
    // would pass the test above and break every uncaptioned video.
    vi.mocked(extractAudio).mockClear();
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-noc-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    vi.mocked(resolve).mockImplementationOnce(async () => ({
      status: 'ok', filePath: v, platform: 'test', title: 'T', duration: 9,
      resolvedBy: 'ytdlp', captions: { manual: null, auto: null },
      languageHint: 'en', rangeApplied: false,
    }));
    const m = await analyzeVideo('https://nocaps.example/watch?v=x', {
      maxFrames: 2, outDir: join(dir, 'out'),
    });
    expect(m.source.status).toBe('ok');
    expect(extractAudio).toHaveBeenCalled();
  }, 120_000);
});

describe('analyzeVideo -- caption clamp time base on the single-instant carve-out (Fix A, task-8)', () => {
  // src/analyze.ts:148-168 used to clamp captions whenever opts.start/end
  // were set, regardless of whether the media itself had actually been
  // re-based onto a 0-based clip. On the 'even'+start===end carve-out
  // (analyze.ts:101-121) `trim()` never runs -- `clipRelative` stays false
  // and `video`/every frame timestamp stay in ABSOLUTE time -- but the old
  // code still clamped the captions AS IF they were clip-relative.
  // clampSegmentsToRange(segs, 100, 100) collapses a caption spanning
  // {98,102} to a zero-width {0,0}; attachTranscript then builds each
  // frame's window from the frame's ABSOLUTE timestamp, which never
  // overlaps {0,0}, so the caption was silently dropped from
  // transcript.segments itself, not just transcriptWindow. The fix gates
  // the clamp on `clipRelative` in addition to opts.start/opts.end.
  it('keeps a straddling caption in absolute time on the carve-out, and still attaches it to the frame', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-clamp-carveout-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    const vtt = join(dir, 'straddle.vtt');
    writeFileSync(vtt, [
      'WEBVTT', '',
      '00:00:03.000 --> 00:00:07.000', 'STRADDLE_MARKER', '',
    ].join('\n'));

    vi.mocked(resolve).mockImplementationOnce(async () => ({
      status: 'ok', filePath: v, platform: 'test', title: 'T', duration: 9,
      resolvedBy: 'ytdlp', captions: { manual: { path: vtt, language: 'en' }, auto: null },
      languageHint: 'en', rangeApplied: false,
    }));

    // start===end -> the carve-out: clipRelative stays false, so the caption
    // must survive UNCLAMPED, in the same absolute time base as the frame.
    const m = await analyzeVideo('https://carveout.example/watch?v=x', {
      frames: 'even', start: 5, end: 5, maxFrames: 1, outDir: join(dir, 'out'),
    });
    expect(m.source.status).toBe('ok');
    expect(m.frames).toHaveLength(1);
    expect(m.transcript).not.toBeNull();
    // Assert survival with ORIGINAL timestamps, not just non-null/non-empty:
    // the pre-fix code also produces a non-null transcript, just with the
    // segment collapsed to {start:0,end:0} -- toBe(0)/toBeFalsy() on either
    // bound would pass against the unfixed code, so the whole segment is
    // compared against an independently-computed expectation instead.
    expect(m.transcript!.segments).toEqual([{ start: 3, end: 7, text: 'STRADDLE_MARKER' }]);
    expect(m.frames[0]!.transcriptWindow).toContain('STRADDLE_MARKER');
  }, 120_000);

  // The regression twin: an ORDINARY ranged call (clipRelative true, since
  // start !== end takes the trim() branch instead of the carve-out) must
  // STILL clamp. Without this, gating on `clipRelative` could regress into
  // "never clamp" and still pass the carve-out test above.
  it('still clamps an ordinary ranged call, where clipRelative is genuinely true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-clamp-regression-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    const vtt = join(dir, 'straddle.vtt');
    writeFileSync(vtt, [
      'WEBVTT', '',
      '00:00:03.000 --> 00:00:07.000', 'STRADDLE_MARKER', '',
    ].join('\n'));

    vi.mocked(resolve).mockImplementationOnce(async () => ({
      status: 'ok', filePath: v, platform: 'test', title: 'T', duration: 9,
      resolvedBy: 'ytdlp', captions: { manual: { path: vtt, language: 'en' }, auto: null },
      languageHint: 'en', rangeApplied: false,
    }));

    // start !== end -> NOT the carve-out: trim() runs, clipRelative becomes
    // true, so the caption must come back re-based onto the [2,8) clip
    // (start:3-2=1, end:7-2=5), not left at its original absolute {3,7}.
    const m = await analyzeVideo('https://regression.example/watch?v=x', {
      frames: 'even', start: 2, end: 8, maxFrames: 1, outDir: join(dir, 'out'),
    });
    expect(m.source.status).toBe('ok');
    expect(m.transcript).not.toBeNull();
    expect(m.transcript!.segments).toEqual([{ start: 1, end: 5, text: 'STRADDLE_MARKER' }]);
  }, 120_000);
});

describe('analyzeVideo -- working directory cleanup (Fix 6, deferred #18 leak half)', () => {
  it('deletes work.wav after the transcript stage is done with it, even though extraction genuinely ran', async () => {
    // Combines two signals that only BOTH hold under a correct
    // implementation: the spy proves extractAudio() genuinely ran (so this
    // is not just Fix 2 skipping extraction for some unrelated reason), and
    // the file-existence check proves Fix 6's cleanup then removed it.
    // Nothing in Manifest ever references a wav path, so its absence can
    // never break the coarse-to-fine handoff the way deleting work.mp4
    // could -- this is deliberately the simpler, unconditional half.
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-wavcleanup-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 6);
    const outDir = join(dir, 'out');
    const m = await analyzeVideo(v, { frames: 'none', outDir });
    expect(m.source.status).toBe('ok');
    expect(extractAudio).toHaveBeenCalled();
    expect(existsSync(join(outDir, 'work.wav'))).toBe(false);
  }, 60_000);
});

describe('analyzeVideo -- documented no-throw contract (media-stage throws become failure manifests)', () => {
  it('returns an honest failure manifest (and a real peakRssMb) when normalizeVideo() throws, instead of rejecting', async () => {
    // src/mcp.ts documents analyze_video as "returns a manifest rather than
    // throwing". Pre-fix, a throw from normalize/probe/trim rejected
    // analyzeVideo AND skipped rss.stop(), leaking the 250ms ps -A sampler
    // permanently in a long-lived MCP server -- once per failed call.
    //
    // Fix 2 split normalize() into normalizeVideo()/extractAudio(), and
    // analyze.ts now calls normalizeVideo() only for frameMode 'key' (the
    // default, which this maxFrames:2 request takes) -- mocking `normalize`
    // itself here would no longer intercept anything analyze.ts actually
    // calls, and this test would silently stop proving what its name claims.
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-nothrow-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 6);
    vi.mocked(normalizeVideo).mockImplementationOnce(async () => {
      throw new Error('SIMULATED: normalize exploded');
    });

    // No try/catch on purpose: a rejection here IS the pre-fix failure mode.
    const m = await analyzeVideo(v, { maxFrames: 2, transcript: false, outDir: join(dir, 'out') });
    expect(normalizeVideo).toHaveBeenCalled();
    expect(m.source.status).toBe('extractor_failed');
    expect(m.source.reason).toContain('SIMULATED: normalize exploded');
    expect(m.frames).toEqual([]);
    // Partial context survives: the resolver DID succeed before the throw.
    expect(m.source.platform).toBe('local');
    expect(m.source.resolvedBy).toBe('direct');
    // rss.stop() ran (the tracker was started, so the peak is a real number).
    expect(m.processing.peakRssMb).toBeGreaterThan(0);
  }, 60_000);

  it('returns an honest failure manifest when extractAudio() throws, instead of rejecting', async () => {
    // The other half of the Fix 2 split, tested independently: normalizeVideo
    // throwing is covered above. frames:'none' keeps normalizeVideo out of
    // the picture entirely (never called), isolating this to the
    // audio-extraction half specifically -- transcript defaults to true, so
    // extractAudio() still runs even with no frames requested at all.
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-audiothrow-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 6);
    vi.mocked(extractAudio).mockImplementationOnce(async () => {
      throw new Error('SIMULATED: extractAudio exploded');
    });
    const m = await analyzeVideo(v, { frames: 'none', outDir: join(dir, 'out') });
    expect(extractAudio).toHaveBeenCalled();
    expect(m.source.status).toBe('extractor_failed');
    expect(m.source.reason).toContain('SIMULATED: extractAudio exploded');
    expect(m.processing.peakRssMb).toBeGreaterThan(0);
  }, 60_000);
});

describe('analyzeVideo -- issue 1: a failed embedding must not be preferentially selected', () => {
  it('drops a candidate whose embedding failed once another candidate embedded successfully (constructed directly via vi.mock)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-embedfail-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);

    let capturedPaths: string[] = [];
    vi.mocked(embedImages).mockImplementationOnce(async (paths: string[]) => {
      capturedPaths = paths;
      // Slot 0 fails (embedImages' real contract for a failed image: `[]`,
      // not a dropped entry -- see src/vision/embedWorker.ts). Every other
      // slot gets a real, distinct, orthogonal unit vector.
      return paths.map((_, i) => (i === 0 ? [] : unitVec(i)));
    });

    const m = await analyzeVideo(v, { maxFrames: 10, transcript: false, outDir: join(dir, 'out') });

    // The mock must actually have been exercised with more than one
    // candidate, or this test cannot discriminate anything.
    expect(embedImages).toHaveBeenCalled();
    expect(capturedPaths.length).toBeGreaterThanOrEqual(2);

    expect(m.source.status).toBe('ok');
    const failedPath = capturedPaths[0]!;
    // The old bug: an empty-embedding candidate reads as maximally novel
    // (cosine([], x) === 0, same as maxSim's own default) and gets
    // PREFERENTIALLY selected. Under the fix it must never appear at all
    // once a real alternative exists.
    expect(m.frames.some((f) => f.image === failedPath)).toBe(false);
    // And it must not have just been silently swallowed along with
    // everything else -- the other, embeddable candidates ARE selected.
    expect(m.frames.length).toBe(capturedPaths.length - 1);
  }, 120_000);

  it('still selects frames when EVERY embedding fails (no mass-drop when there is nothing to compare against)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-embedallfail-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);

    vi.mocked(embedImages).mockImplementationOnce(async (paths: string[]) => paths.map(() => []));

    const m = await analyzeVideo(v, { maxFrames: 10, transcript: false, outDir: join(dir, 'out') });
    expect(embedImages).toHaveBeenCalled();
    expect(m.source.status).toBe('ok');
    // If the fix dropped candidates whenever an embedding is missing (rather
    // than only when SOME other candidate embedded successfully), this would
    // be 0 -- a healthy video with a merely-unavailable embedding stage would
    // silently produce no frames at all.
    expect(m.frames.length).toBeGreaterThan(0);
    // ...and the degrade leaves a trace (IMPORTANT-6): status stays ok but
    // the manifest says the diversity signal was lost.
    expect(m.processing.warnings.some((w) => w.includes('embedding produced no vectors'))).toBe(true);
  }, 120_000);
});

describe('analyzeVideo -- silent degrades leave a manifest trace (processing.warnings)', () => {
  it('records a warning when the embedding stage rejects outright', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-warn-embed-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    vi.mocked(embedImages).mockImplementationOnce(async () => {
      throw new Error('SIMULATED: embed worker crashed');
    });
    const m = await analyzeVideo(v, { maxFrames: 4, transcript: false, outDir: join(dir, 'out') });
    expect(m.source.status).toBe('ok');
    expect(m.processing.warnings.some((w) => w.includes('embedding failed') && w.includes('SIMULATED: embed worker crashed'))).toBe(true);
  }, 120_000);

  it('carries a warning the embedding stage reports (e.g. the WebAssembly fallback) into the manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-warn-embed-fallback-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    vi.mocked(embedImages).mockImplementationOnce(async (paths: string[], warnings?: string[]) => {
      warnings?.push('SIMULATED: embedding used the slower WebAssembly runtime');
      return paths.map((_, i) => unitVec(i));
    });
    const m = await analyzeVideo(v, { maxFrames: 4, transcript: false, outDir: join(dir, 'out') });
    expect(m.source.status).toBe('ok');
    expect(m.frames.length).toBeGreaterThan(0);
    expect(m.processing.warnings).toContain('SIMULATED: embedding used the slower WebAssembly runtime');
  }, 120_000);

  it('collapses a fully-dead OCR stage into one summary warning while keeping status ok', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-warn-ocr-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    vi.mocked(ocrFrame).mockImplementation(async () => {
      throw new Error('SIMULATED: tesseract gone');
    });
    try {
      const m = await analyzeVideo(v, { maxFrames: 4, transcript: false, outDir: join(dir, 'out') });
      expect(ocrFrame).toHaveBeenCalled();
      expect(m.source.status).toBe('ok');
      expect(m.frames.length).toBeGreaterThan(0);
      const ocrWarnings = m.processing.warnings.filter((w) => w.startsWith('ocr unavailable: all '));
      expect(ocrWarnings).toHaveLength(1);
      expect(ocrWarnings[0]).toContain('SIMULATED: tesseract gone');
    } finally {
      const real = await vi.importActual<typeof import('../dist/vision/ocr.js')>('../dist/vision/ocr.js');
      vi.mocked(ocrFrame).mockImplementation(real.ocrFrame);
    }
  }, 120_000);
});

describe('analyzeVideo -- issue 2: filterCandidates throwing on total batch failure', () => {
  it('surfaces a systemic candidate-pipeline failure as a clean, honest failure manifest -- not a throw, not silent empty-but-ok frames', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-qfail-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);

    vi.mocked(filterCandidates).mockImplementationOnce(async () => {
      throw new Error('SIMULATED: all 4 candidate(s) failed to score (first error: boom)');
    });

    // No try/catch here on purpose: if analyzeVideo let the throw escape as
    // a promise rejection instead of catching it, this `await` would make
    // the whole test fail/error out -- that IS the "does not throw" proof.
    const m = await analyzeVideo(v, { maxFrames: 4, transcript: false, outDir: join(dir, 'out') });

    expect(filterCandidates).toHaveBeenCalled();
    expect(m.source.status).not.toBe('ok');
    expect(m.frames).toEqual([]);
    expect(m.source.reason).toBeDefined();
    // 'candidate pipeline failed' specifically -- the STAGE-level boundary
    // added in Task 7 -- not merely any failure manifest: analyzeVideo now
    // also has a top-level catch-all ('analysis failed: ...'), so a bare
    // 'SIMULATED' check would pass even if the stage-level catch were
    // deleted and the throw fell through to the outer one.
    expect(m.source.reason).toContain('candidate pipeline failed');
    expect(m.source.reason).toContain('SIMULATED');
    // rss.stop() must still run on this path.
    expect(m.processing.peakRssMb).toBeGreaterThan(0);
  }, 120_000);
});

describe('buildManifest', () => {
  it('maps every field into the manifest shape, including the live selector version', () => {
    const m = buildManifest({
      url: 'https://x.com/v', platform: 'youtube', title: 'T', duration: 12.5,
      resolvedBy: 'ytdlp', status: 'ok',
      transcript: null, frames: [], candidateCount: 7, peakRssMb: 123, frameMode: 'key',
    });
    expect(m.source).toEqual({
      url: 'https://x.com/v', platform: 'youtube', title: 'T', duration: 12.5,
      resolvedBy: 'ytdlp', status: 'ok',
    });
    expect(m.processing).toEqual({
      selectedFrames: 0, candidateFrames: 7, peakRssMb: 123, selectorVersion: SELECTOR_VERSION, frameMode: 'key',
      warnings: [],
    });
  });

  it('threads warnings through and defaults them to an empty array', () => {
    const base = {
      url: 'u', platform: 'p', title: 't', duration: 0, resolvedBy: 'direct', status: 'ok' as const,
      transcript: null, frames: [], candidateCount: 0, peakRssMb: 1, frameMode: 'even' as const,
    };
    expect(buildManifest(base).processing.warnings).toEqual([]);
    expect(buildManifest({ ...base, warnings: ['ocr unavailable: boom'] }).processing.warnings)
      .toEqual(['ocr unavailable: boom']);
  });

  it('omits `reason` entirely (not just undefined) when none is given', () => {
    const m = buildManifest({
      url: 'u', platform: 'p', title: 't', duration: 0, resolvedBy: 'direct', status: 'ok',
      transcript: null, frames: [], candidateCount: 0, peakRssMb: 1, frameMode: 'even',
    });
    expect('reason' in m.source).toBe(false);
  });

  it('includes `reason` when one is given', () => {
    const m = buildManifest({
      url: 'u', platform: 'unknown', title: '', duration: 0, resolvedBy: 'none', status: 'not_found',
      reason: 'nope', transcript: null, frames: [], candidateCount: 0, peakRssMb: 1, frameMode: 'key',
    });
    expect(m.source.reason).toBe('nope');
  });

  it('omits `filePath` entirely (not just undefined) when none is given', () => {
    // Mirrors the `reason`-omission test above exactly, for the field this
    // task's Finding 2 added: buildManifest is the single choke point that
    // threads filePath from analyze.ts into the Manifest, so this pins the
    // "not present at all" contract analyze_video's failure-path callers
    // rely on (a present-but-undefined key would still pass a naive
    // `?? fallback` check but is a different, weaker guarantee than the key
    // being genuinely absent, which `'filePath' in m.source` verifies).
    const m = buildManifest({
      url: 'u', platform: 'p', title: 't', duration: 0, resolvedBy: 'direct', status: 'ok',
      transcript: null, frames: [], candidateCount: 0, peakRssMb: 1, frameMode: 'even',
    });
    expect('filePath' in m.source).toBe(false);
  });

  it('includes `filePath` when one is given', () => {
    const m = buildManifest({
      url: 'u', platform: 'direct', title: 't', duration: 9, resolvedBy: 'direct', status: 'ok',
      filePath: '/work/dir/work.mp4', transcript: null, frames: [], candidateCount: 0, peakRssMb: 1, frameMode: 'key',
    });
    expect(m.source.filePath).toBe('/work/dir/work.mp4');
  });
});

describe('analyzeVideo -- onStage progress seams (spec §7)', () => {
  it('emits resolving -> transcribing -> frames for a full default run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-stage-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    vi.mocked(resolve).mockImplementationOnce(async () => ({
      status: 'ok', filePath: v, platform: 'test', title: 'T', duration: 9,
      resolvedBy: 'ytdlp', captions: { manual: null, auto: null },
      languageHint: 'en', rangeApplied: false,
    }));
    const stages: string[] = [];
    const m = await analyzeVideo('https://stage.example/v', {
      maxFrames: 2, outDir: join(dir, 'out'), onStage: (s) => stages.push(s),
    });
    expect(m.source.status).toBe('ok');
    expect(stages).toEqual(['resolving', 'transcribing', 'frames']);
  }, 120_000);

  it('emits only the stages that actually run: transcript off + frames none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-stage2-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    vi.mocked(resolve).mockImplementationOnce(async () => ({
      status: 'ok', filePath: v, platform: 'test', title: 'T', duration: 9,
      resolvedBy: 'ytdlp', captions: { manual: null, auto: null },
      languageHint: 'en', rangeApplied: false,
    }));
    const stages: string[] = [];
    const m = await analyzeVideo('https://stage.example/v2', {
      frames: 'none', transcript: false, outDir: join(dir, 'out'), onStage: (s) => stages.push(s),
    });
    expect(m.source.status).toBe('ok');
    expect(stages).toEqual(['resolving']);   // no fabricated stages for skipped work (§7/§8)
  }, 120_000);

  it("emits resolving -> transcribing -> frames for frames: 'even' too, not just the default 'key' path", async () => {
    // Review finding (task-3): test 1 above only ever exercises the 'key'
    // branch's onStage?.('frames') call, because leaving `frames` unset
    // makes resolveFrameMode default to 'key' whenever maxFrames > 0. That
    // left the 'even' branch's OWN emit as a full surviving mutant --
    // deleting that one line left all other tests (including test 1) green.
    // This test forces frames: 'even' specifically to close that gap.
    // It also reuses a manual caption track (mirroring the 'AUTOMATIC
    // caption track' test above) so the transcript stage completes via
    // captions rather than a real ASR run -- deterministic, no model
    // dependency -- which doubles as coverage for 'transcribing' firing on
    // the captions sub-path, not just the ASR sub-path test 1 covers.
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-stage-even-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    const vtt = join(dir, 'stage-even.vtt');
    writeFileSync(vtt, [
      'WEBVTT', '',
      '00:00:01.000 --> 00:00:02.000', 'STAGE_EVEN_MARKER', '',
    ].join('\n'));
    vi.mocked(resolve).mockImplementationOnce(async () => ({
      status: 'ok', filePath: v, platform: 'test', title: 'T', duration: 9,
      resolvedBy: 'ytdlp', captions: { manual: { path: vtt, language: 'en' }, auto: null },
      languageHint: 'en', rangeApplied: false,
    }));
    const stages: string[] = [];
    const m = await analyzeVideo('https://stage.example/v3', {
      frames: 'even', maxFrames: 2, outDir: join(dir, 'out'), onStage: (s) => stages.push(s),
    });
    expect(m.source.status).toBe('ok');
    expect(m.transcript).not.toBeNull();
    expect(m.transcript!.source).toBe('manual');
    expect(stages).toEqual(['resolving', 'transcribing', 'frames']);
  }, 120_000);
});
