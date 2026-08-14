import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync, writeFileSync, existsSync, readdirSync, chmodSync, mkdirSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeVideoTool } from '../src/agent/analyzeTool.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';

/**
 * destinationPath receives RESULTS, not the pipeline's scratch.
 *
 * Before this, a URL source used destinationPath as its working directory and
 * the caller got everything: one real 40-frame request left 258 candidate
 * JPEGs, plus both the download and its normalized re-encode -- 390 MB for a
 * result of 40 images and a transcript.
 *
 * Asserted structurally (what is in the directory versus what the reply
 * names) rather than by candidate count, which depends on how many scene
 * boundaries a given video happens to have.
 */

let prevPath: string | undefined;
afterEach(() => {
  if (prevPath !== undefined) process.env['PATH'] = prevPath;
  prevPath = undefined;
});

/** Fake yt-dlp writing a real video wherever -o points. */
function fakeYtDlp(video: string): void {
  const binDir = mkdtempSync(join(tmpdir(), 'vem-wdbin-'));
  writeFileSync(join(binDir, 'yt-dlp'), [
    '#!/bin/sh',
    'out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
    'dir=$(dirname "$out")',
    `cp "${video}" "$dir/source.mp4"`,
    `echo '{"title":"fake","duration":3,"extractor":"youtube","requested_subtitles":null}'`,
    'exit 0',
  ].join('\n'));
  chmodSync(join(binDir, 'yt-dlp'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

const URL = 'https://example.invalid/watch?v=abc';
const workDirs = (dir: string): string[] => readdirSync(dir).filter((n) => n.startsWith('.work-'));

/** A pid that is genuinely dead: spawned, reaped, gone. */
function deadPid(): number {
  const p = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return p.pid!;
}

describe('what a URL source leaves in destinationPath', () => {
  it('delivers exactly the frames it reported, and no scratch', async () => {
    const video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-wdsrc-')), 'v.mp4'), 3);
    fakeYtDlp(video);
    const dest = mkdtempSync(join(tmpdir(), 'vem-wddest-'));

    const r = await analyzeVideoTool({
      destinationPath: dest,
      videos: [{ pathOrUrl: URL, frames: 'key', maxFrames: 2, transcript: false }],
    });
    const item = r.videos[0]!;
    expect(item.status).toBe('ok');

    // Every JPEG on disk is one the reply named -- no rejected candidates.
    const jpegs = readdirSync(dest).filter((n) => n.endsWith('.jpg')).sort();
    expect(jpegs).toEqual(item.framePaths.map((p) => basename(p)).sort());
    for (const p of item.framePaths) expect(existsSync(p)).toBe(true);

    // The candidate pool's own directory never reaches the caller.
    expect(existsSync(join(dest, 'frames'))).toBe(false);
    // Nor does the scratch directory, on the success path.
    expect(workDirs(dest)).toEqual([]);
  }, 180_000);

  it('delivers ONE video -- the one videoPath names -- not the download and its re-encode too', async () => {
    // 'key' mode re-encodes, so the pipeline holds source.mp4 AND work.mp4.
    // Both used to be handed over; only the one the reply points at should be.
    const video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-wdsrc2-')), 'v.mp4'), 3);
    fakeYtDlp(video);
    const dest = mkdtempSync(join(tmpdir(), 'vem-wddest2-'));

    const r = await analyzeVideoTool({
      destinationPath: dest,
      videos: [{ pathOrUrl: URL, frames: 'key', maxFrames: 2, transcript: false }],
    });
    const item = r.videos[0]!;

    const videos = readdirSync(dest).filter((n) => /\.(mp4|mkv|webm|m4v)$/.test(n));
    expect(videos.length).toBe(1);
    expect(existsSync(item.videoPath!)).toBe(true);
    expect(dirname(item.videoPath!)).toBe(dest);
    // And it is a real file, not a zero-byte stub left by a failed move.
    expect(statSync(item.videoPath!).size).toBeGreaterThan(0);
  }, 180_000);

  it('leaves no scratch behind for a transcript-only request either', async () => {
    const video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-wdsrc3-')), 'v.mp4'), 2);
    fakeYtDlp(video);
    const dest = mkdtempSync(join(tmpdir(), 'vem-wddest3-'));
    await analyzeVideoTool({
      destinationPath: dest, videos: [{ pathOrUrl: URL, frames: 'none', transcript: false }],
    });
    expect(workDirs(dest)).toEqual([]);
  }, 120_000);

  it('gives each batch item its own scratch, and cleans both', async () => {
    const video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-wdsrc4-')), 'v.mp4'), 2);
    fakeYtDlp(video);
    const dest = mkdtempSync(join(tmpdir(), 'vem-wddest4-'));

    await analyzeVideoTool({
      destinationPath: dest,
      videos: [
        { pathOrUrl: URL, frames: 'none', transcript: false },
        { pathOrUrl: URL, frames: 'none', transcript: false },
      ],
    });
    // N>1 uses video-1/, video-2/ -- each must be clean, and the parent too.
    expect(workDirs(dest)).toEqual([]);
    expect(workDirs(join(dest, 'video-1'))).toEqual([]);
    expect(workDirs(join(dest, 'video-2'))).toEqual([]);
  }, 180_000);
});

describe('scratch left by a run that was killed', () => {
  it('is swept by the NEXT call into that directory', async () => {
    // The regression risk this whole design introduces: with a per-call
    // scratch name, the age-gated partials sweep can no longer collect an
    // abandoned run's bytes -- it only ever looks inside the download's own
    // directory, which is now the abandoned scratch itself. Without an
    // explicit sweep, every SIGKILLed run's video would accumulate in the
    // caller's directory forever.
    const video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-wdsrc5-')), 'v.mp4'), 2);
    fakeYtDlp(video);
    const dest = mkdtempSync(join(tmpdir(), 'vem-wddest5-'));

    const orphan = join(dest, `.work-${deadPid()}-1`);
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'source.mp4'), Buffer.alloc(1_000_000));

    await analyzeVideoTool({
      destinationPath: dest, videos: [{ pathOrUrl: URL, frames: 'none', transcript: false }],
    });

    expect(existsSync(orphan)).toBe(false);
    expect(workDirs(dest)).toEqual([]);
  }, 120_000);

  it('is NOT swept while the process that owns it is still alive', async () => {
    // What makes concurrent calls into one destinationPath safe: a live pid's
    // scratch is another call's working directory, and deleting it would
    // destroy a download in flight -- the exact harm the partials rules exist
    // to prevent, in a new place.
    const video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-wdsrc6-')), 'v.mp4'), 2);
    fakeYtDlp(video);
    const dest = mkdtempSync(join(tmpdir(), 'vem-wddest6-'));

    // This process is unquestionably alive.
    const live = join(dest, `.work-${process.pid}-999999`);
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'source.mp4'), Buffer.alloc(2_368_000));

    await analyzeVideoTool({
      destinationPath: dest, videos: [{ pathOrUrl: URL, frames: 'none', transcript: false }],
    });

    expect(existsSync(live)).toBe(true);
    expect(statSync(join(live, 'source.mp4')).size).toBe(2_368_000);
  }, 120_000);

  it('never touches a directory that is not ours, whatever it is called', async () => {
    const video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-wdsrc7-')), 'v.mp4'), 2);
    fakeYtDlp(video);
    const dest = mkdtempSync(join(tmpdir(), 'vem-wddest7-'));

    const keep = ['.work', '.workspace', 'work-123-1', '.work-abc-1', '.git', 'frames'];
    for (const n of keep) mkdirSync(join(dest, n), { recursive: true });
    writeFileSync(join(dest, '.work-notes.txt'), 'mine');

    await analyzeVideoTool({
      destinationPath: dest, videos: [{ pathOrUrl: URL, frames: 'none', transcript: false }],
    });

    for (const n of keep) expect(existsSync(join(dest, n))).toBe(true);
    expect(existsSync(join(dest, '.work-notes.txt'))).toBe(true);
  }, 120_000);
});
