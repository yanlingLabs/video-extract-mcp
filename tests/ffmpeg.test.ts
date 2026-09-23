import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, statSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe, normalize, trim, extractFrame, makeTestVideo, extractAudio } from '../src/media/ffmpeg.js';
import { run } from '../src/util/run.js';

let dir: string, sample: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'norma-'));
  sample = await makeTestVideo(join(dir, 'sample.mp4'), 6);
}, 60_000);

describe('ffmpeg layer', () => {
  it('probes duration and dimensions', async () => {
    const p = await probe(sample);
    expect(p.duration).toBeGreaterThan(5);
    expect(p.width).toBe(1280);
    expect(p.fps).toBeGreaterThan(0);
  });
  it('normalizes to a 720p-capped video plus 16kHz mono wav', async () => {
    const { video, audio: maybeAudio } = await normalize(sample, dir);
    expect(maybeAudio).not.toBeNull();
    const audio = maybeAudio!;
    expect(existsSync(video)).toBe(true);
    expect(statSync(video).size).toBeGreaterThan(0);
    expect(existsSync(audio)).toBe(true);
    expect(statSync(audio).size).toBeGreaterThan(0);
    // Verify audio is actually 16kHz mono via ffprobe
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate,channels',
      '-of', 'json', audio,
    ]);
    const audioInfo = JSON.parse(stdout) as { streams?: Array<{ sample_rate?: string; channels?: number }> };
    const audioStream = audioInfo.streams?.[0];
    expect(Number(audioStream?.sample_rate ?? 0)).toBe(16000);
    expect(audioStream?.channels).toBe(1);
    // Verify video height is capped at 720
    const vp = await probe(video);
    expect(vp.height).toBe(720);
  });
  it('trims to the requested range', async () => {
    const out = await trim(sample, 1, 3, join(dir, 'clip.mp4'));
    const p = await probe(out);
    expect(p.duration).toBeGreaterThan(1.5);
    expect(p.duration).toBeLessThan(2.6);
  });
  it('extracts a single frame at a timestamp', async () => {
    const out = await extractFrame(sample, 2.5, join(dir, 'f.jpg'));
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(0);
  });
  it('normalizes a portrait (odd-scaled) video to even dimensions (TikTok/Reels/Shorts shape)', async () => {
    // 1080x1920 portrait: the aspect-preserving 720p cap yields 405x720 --
    // an ODD width -- and libx264 with yuv420p rejects odd dimensions with an
    // opaque "Invalid argument". Every other fixture in this repo is
    // even-dimensioned, so only a portrait input can catch this. The fixture
    // is generated at runtime (committed .mp4 files are gitignored).
    const portrait = join(dir, 'portrait.mp4');
    const r = await run('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=red:s=1080x1920:d=2',
      '-vf', 'drawgrid=w=40:h=40:t=3:c=black@0.6',
      '-r', '25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', portrait,
    ]);
    expect(r.code).toBe(0);
    const workDir = join(dir, 'portrait-work');
    mkdirSync(workDir, { recursive: true });
    const { video } = await normalize(portrait, workDir);
    expect(existsSync(video)).toBe(true);
    const vp = await probe(video);
    expect(vp.width % 2).toBe(0);
    expect(vp.height % 2).toBe(0);
    expect(vp.height).toBeLessThanOrEqual(720);
    expect(vp.width).toBeLessThanOrEqual(1280);
  }, 60_000);

  it('keeps the audio in the normalized video, so a delivered videoPath can be transcribed again', async () => {
    const workDir = join(dir, 'keeps-audio');
    mkdirSync(workDir, { recursive: true });
    const { video } = await normalize(sample, workDir);
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', video,
    ]);
    expect(stdout.trim()).toBe('aac');
  });

  it('reports a failed audio extraction instead of passing it off as a silent video', async () => {
    const broken = join(dir, 'not-a-video.mp4');
    writeFileSync(broken, 'this is not media');
    await expect(extractAudio(broken, dir)).rejects.toThrow(/could not read/);
  });

  it('handles audio absence: silent video produces no audio file', async () => {
    // Create a fixture with no audio stream (colour source only, no anullsrc)
    const noAudioFixture = join(dir, 'silent.mp4');
    const r = await run('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=640x480:d=2',
      '-r', '25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', noAudioFixture,
    ]);
    expect(r.code).toBe(0);
    // Normalize should succeed for video but audio file should not exist
    const workDir = join(dir, 'silent-work');
    mkdirSync(workDir, { recursive: true });
    const { video, audio } = await normalize(noAudioFixture, workDir);
    expect(existsSync(video)).toBe(true);
    expect(statSync(video).size).toBeGreaterThan(0);
    expect(audio).toBeNull();
    expect(existsSync(join(workDir, 'work.wav'))).toBe(false);
  });
});

describe('extractFrame when ffmpeg exits 0 without writing a frame', () => {
  // Ubuntu 24.04's ffmpeg 6.1 does this when a seek lands past the last frame
  // ("Output file is empty, nothing was encoded"); the 8.x this project is
  // developed on exits non-zero instead. Found by the first CI run on Linux.
  let prevPath: string | undefined;
  afterEach(() => { if (prevPath !== undefined) process.env['PATH'] = prevPath; prevPath = undefined; });

  function useSilentFfmpeg(): void {
    const binDir = mkdtempSync(join(tmpdir(), 'vem-silent-ffmpeg-'));
    writeFileSync(join(binDir, 'ffmpeg'),
      '#!/bin/sh\necho "Output file is empty, nothing was encoded (check -ss / -t / -frames parameters if used)" >&2\nexit 0\n');
    chmodSync(join(binDir, 'ffmpeg'), 0o755);
    prevPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
  }

  it('throws instead of returning the path of a file that was never written', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'vem-frame-')), 'f.jpg');
    useSilentFfmpeg();
    await expect(extractFrame(sample, 5.99, out)).rejects.toThrow(/nothing was encoded/);
    expect(existsSync(out)).toBe(false);
  });

  it('does not take a file left by an earlier call for this call\'s frame', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'vem-frame-')), 'f.jpg');
    writeFileSync(out, 'an older frame');
    useSilentFfmpeg();
    await expect(extractFrame(sample, 5.99, out)).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
  });
});
