import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeVideo } from '../src/analyze.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';

/**
 * A transcript-only request against a captioned video must not download the
 * media at all -- nothing downstream ever opens it. Measured on a 27-minute
 * YouTube video before this existed: 285 MB fetched to produce a 58 KB
 * transcript.
 *
 * These assert on what yt-dlp was ASKED to do (its argv, one line per
 * invocation) and what landed on disk, not on transcript content: the shape
 * of the invocation is the behaviour under test, and it stays verifiable on
 * a machine with no speech models installed.
 */

const CAPTIONS = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nhello from the caption track\n';

interface Fake { binDir: string; workDir: string; log: string }

/**
 * Installs a fake yt-dlp ahead of the real one on PATH. It logs its own argv,
 * writes caption files when `withCaptions`, and produces a media file ONLY
 * when --skip-download is absent -- exactly the split this feature turns on.
 */
function fakeYtDlp(opts: { withCaptions: boolean; video: string; captionFile?: boolean }): Fake {
  const binDir = mkdtempSync(join(tmpdir(), 'vem-skipbin-'));
  const workDir = mkdtempSync(join(tmpdir(), 'vem-skipwork-'));
  const log = join(binDir, 'invocations.log');
  const vtt = join(binDir, 'fixture.vtt');
  writeFileSync(vtt, CAPTIONS);

  const subsJson = opts.withCaptions ? '"requested_subtitles":{"en":{"ext":"vtt"}}' : '"requested_subtitles":null';
  // captionFile defaults to withCaptions; setting it false independently
  // reproduces yt-dlp announcing a track whose file never made it to disk.
  const writesFile = (opts.captionFile ?? opts.withCaptions);
  const writeCaptions = writesFile ? `cp "${vtt}" "${workDir}/source.en.vtt"` : ':';

  const script = [
    '#!/bin/sh',
    `echo "$@" >> "${log}"`,
    // Real yt-dlp writes subtitles on BOTH paths (--skip-download only skips
    // the media transfer), so the fake must too -- otherwise the test would
    // pass for the wrong reason on the download path.
    writeCaptions,
    'case " $* " in',
    '  *" --skip-download "*) ;;',
    `  *) cp "${opts.video}" "${workDir}/source.mp4" ;;`,
    'esac',
    `echo '{"title":"fake","duration":12,"extractor":"youtube",${subsJson}}'`,
    'exit 0',
  ].join('\n');

  const bin = join(binDir, 'yt-dlp');
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return { binDir, workDir, log };
}

function invocations(f: Fake): string[] {
  return existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

let prevPath: string | undefined;
let prevModels: string | undefined;
afterEach(() => {
  if (prevPath !== undefined) process.env.PATH = prevPath;
  if (prevModels === undefined) delete process.env.VIDEO_EXTRACT_MODELS_DIR;
  else process.env.VIDEO_EXTRACT_MODELS_DIR = prevModels;
  prevPath = undefined; prevModels = undefined;
});

function usePath(binDir: string): void {
  prevPath = process.env.PATH;
  process.env.PATH = `${binDir}:${prevPath ?? ''}`;
}

/** Points ASR at an empty directory so it fails fast instead of loading ~1.5 GB. */
function useNoModels(): void {
  prevModels = process.env.VIDEO_EXTRACT_MODELS_DIR;
  process.env.VIDEO_EXTRACT_MODELS_DIR = join(mkdtempSync(join(tmpdir(), 'vem-nomodels-')), 'absent');
}

const URL = 'https://example.invalid/watch?v=abc';

describe('a captioned transcript-only request', () => {
  it('never downloads the media, and transcribes from the captions', async () => {
    const video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-skipsrc-')), 'v.mp4'), 1);
    const f = fakeYtDlp({ withCaptions: true, video });
    usePath(f.binDir);

    const m = await analyzeVideo(URL, { frames: 'none', outDir: f.workDir });

    expect(m.source.status).toBe('ok');
    // The point of the whole change: no media file, ever.
    expect(readdirSync(f.workDir).filter((n) => /^source\.(mp4|mkv|webm|m4v)$/.test(n))).toEqual([]);
    expect(existsSync(join(f.workDir, 'source.mp4'))).toBe(false);
    // Exactly one yt-dlp call, and it asked not to download.
    expect(invocations(f).length).toBe(1);
    expect(invocations(f)[0]).toContain('--skip-download');
    // And the transcript is real, from the captions.
    expect(m.transcript?.source).toBe('manual');
    expect(m.transcript?.segments.map((s) => s.text).join(' ')).toContain('hello from the caption track');
    // Duration comes from the extractor's metadata rather than a probe.
    expect(m.source.duration).toBe(12);
    // No media means no filePath to report -- the manifest omits it rather
    // than carrying an empty string.
    expect('filePath' in m.source).toBe(false);
    expect(m.processing.warnings).toEqual([]);
  }, 60_000);
});

describe('an UNcaptioned transcript-only request', () => {
  it('falls back to fetching the media, so local ASR still has audio', async () => {
    // The half of the gate that must NOT skip: with no captions the pipeline
    // needs a WAV, so the cheap pass has to be followed by a real download.
    const video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-skipsrc2-')), 'v.mp4'), 1);
    const f = fakeYtDlp({ withCaptions: false, video });
    usePath(f.binDir);
    useNoModels();

    const m = await analyzeVideo(URL, { frames: 'none', outDir: f.workDir });

    // Two calls: the cheap probe, then the real fetch.
    const calls = invocations(f);
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('--skip-download');
    expect(calls[1]).not.toContain('--skip-download');
    // The media really did arrive, so extractAudio had something to read.
    expect(existsSync(join(f.workDir, 'source.mp4'))).toBe(true);
    expect(m.source.status).toBe('ok');
    // ASR itself is unavailable here by construction; it must degrade
    // VISIBLY rather than look like a video with no speech.
    expect(m.transcript).toBeNull();
    expect(m.processing.warnings.some((w) => w.startsWith('asr failed'))).toBe(true);
  }, 120_000);
});

describe('a caption track the platform announced but never wrote', () => {
  it('counts as no captions, so the media is fetched for ASR', async () => {
    // yt-dlp lists a track in requested_subtitles before writing it, so an
    // announced-but-absent track is a real shape. What this pins is the
    // END-TO-END outcome: the pipeline treats it as "no captions" and goes
    // and fetches the media, rather than skipping the download and then
    // having nothing to transcribe.
    //
    // It does NOT pin usableCaption's own existence check -- pickManualCaption
    // filters the track out first, so this passes with either check removed.
    // Their contracts are covered directly in tests/usableCaption.test.ts;
    // see the note on usableCaption for why both exist.
    const video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-skipsrc7-')), 'v.mp4'), 1);
    const f = fakeYtDlp({ withCaptions: true, captionFile: false, video });
    usePath(f.binDir);
    useNoModels();

    const m = await analyzeVideo(URL, { frames: 'none', outDir: f.workDir });

    const calls = invocations(f);
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('--skip-download');
    expect(calls[1]).not.toContain('--skip-download');
    expect(existsSync(join(f.workDir, 'source.mp4'))).toBe(true);
    // Degraded honestly, never a hard failure and never a silent empty.
    expect(m.source.status).toBe('ok');
    expect(m.processing.warnings.some((w) => w.startsWith('asr failed'))).toBe(true);
  }, 120_000);
});

describe('the download is skipped only for frames: "none"', () => {
  it('still downloads for even-sampled frames, which need the media', async () => {
    // The gate is `frameMode === 'none'`; any other mode must reach the
    // media. 'even' exercises that branch without paying for scene
    // detection, OCR and embeddings the way 'key' would.
    const video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-skipsrc3-')), 'v.mp4'), 2);
    const f = fakeYtDlp({ withCaptions: true, video });
    usePath(f.binDir);

    const m = await analyzeVideo(URL, { frames: 'even', maxFrames: 1, outDir: f.workDir });

    expect(invocations(f).length).toBe(1);
    expect(invocations(f)[0]).not.toContain('--skip-download');
    expect(existsSync(join(f.workDir, 'source.mp4'))).toBe(true);
    expect(m.frames.length).toBe(1);
  }, 60_000);

  it('still downloads for key frames, the default mode', async () => {
    const video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-skipsrc4-')), 'v.mp4'), 2);
    const f = fakeYtDlp({ withCaptions: true, video });
    usePath(f.binDir);

    // Asserted on the invocation alone: what happens after the download is
    // the existing key-frame pipeline, covered elsewhere and dependent on
    // optional vision models this assertion must not require.
    await analyzeVideo(URL, { frames: 'key', maxFrames: 2, outDir: f.workDir });

    expect(invocations(f).length).toBe(1);
    expect(invocations(f)[0]).not.toContain('--skip-download');
    expect(existsSync(join(f.workDir, 'source.mp4'))).toBe(true);
  }, 180_000);
});

describe('a RANGED transcript-only request', () => {
  it('still downloads -- the skip is deliberately not extended to ranges', async () => {
    // Pinned so the exclusion stays a decision rather than an accident. A
    // range makes the media's time base load-bearing: `clipRelative` gates
    // the caption clamp on whether the media was really re-based, so
    // skipping the fetch would answer "just this section" with a
    // whole-video transcript. See docs/follow-ups.md.
    const video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-skipsrc5-')), 'v.mp4'), 4);
    const f = fakeYtDlp({ withCaptions: true, video });
    usePath(f.binDir);

    await analyzeVideo(URL, { frames: 'none', start: 1, end: 3, outDir: f.workDir });

    expect(invocations(f).length).toBe(1);
    expect(invocations(f)[0]).not.toContain('--skip-download');
    expect(existsSync(join(f.workDir, 'source.mp4'))).toBe(true);
  }, 60_000);
});

describe('transcript: false with no frames', () => {
  it('still downloads, since the skip is gated on captions actually being used', async () => {
    // Not an oversight: with transcript disabled the caption check never
    // runs, so there is nothing establishing that a real extractor supplied
    // the duration. direct/wechat return 0 as a type placeholder, and
    // putting that in the manifest would be a fabricated measurement.
    const video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-skipsrc6-')), 'v.mp4'), 1);
    const f = fakeYtDlp({ withCaptions: true, video });
    usePath(f.binDir);

    const m = await analyzeVideo(URL, { frames: 'none', transcript: false, outDir: f.workDir });

    expect(invocations(f).length).toBe(1);
    expect(invocations(f)[0]).not.toContain('--skip-download');
    expect(m.transcript).toBeNull();
  }, 60_000);
});
