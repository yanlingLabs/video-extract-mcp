import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ocrFrame } from '../src/vision/ocr.js';
import { makeTestVideo, extractFrame } from '../src/media/ffmpeg.js';

/**
 * A tesseract failure must say what the INPUT was, not only what tesseract
 * said about it.
 *
 * A real run lost all 459 frames to an OCR failure that could not be
 * diagnosed from its own error text. leptonica reports "image file not
 * found", then retries using the file's own magic bytes as the filename, so
 * the message reads `image file not found: \x89PNG` -- which looks like this
 * code passed raw image data where a path belonged. It does not. That
 * misreading cost a long investigation and a hypothesis (a space in the temp
 * path) that a controlled experiment later disproved.
 *
 * The fact that would have settled it in one line is whether the file was
 * still on disk when tesseract looked at it, which is why that is now
 * recorded AFTER the call rather than assumed from the write succeeding.
 */

/** The rejection message, typed -- ocrFrame resolves to an object otherwise. */
async function failureMessage(frame: string, langs: string): Promise<string> {
  try {
    await ocrFrame(frame, langs);
    throw new Error('expected ocrFrame to reject');
  } catch (e) {
    return (e as Error).message;
  }
}

const ready = (() => {
  try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

describe.skipIf(!ready)('a failing tesseract call', () => {
  it('reports the input path, whether it survived, its size, and the languages', async () => {
    const d = mkdtempSync(join(tmpdir(), 'vem-ocrdiag-'));
    const video = await makeTestVideo(join(d, 'v.mp4'), 1);
    const frame = await extractFrame(video, 0.5, join(d, 'f.jpg'));

    // A language pack that cannot exist: tesseract exits non-zero on a
    // perfectly good image, which is the failure shape under test -- the
    // image is fine, so any claim about it must come from a real check.
    await expect(ocrFrame(frame, 'zzz_nonexistent')).rejects.toThrow(/tesseract exited/);

    const err = await failureMessage(frame, 'zzz_nonexistent');

    expect(err).toMatch(/input: \S+\.png/);          // the actual temp path
    expect(err).toMatch(/present, \d+ bytes/);       // it was there, and how big
    expect(err).toContain('zzz_nonexistent');        // what we asked for
    expect(err).toMatch(/tesseract exited \d+/);     // and the exit code
    // The raw text is kept too -- a human still needs tesseract's own words.
    expect(err.length).toBeGreaterThan(80);
  }, 60_000);

  it('distinguishes a vanished input from a present one', async () => {
    // The two cases lead to different bugs: "present" means tesseract could
    // not read a file that was there; "MISSING" means it was never written or
    // something removed it mid-call. Collapsing them is what made the
    // original report undiagnosable, so the wording must actually differ.
    const d = mkdtempSync(join(tmpdir(), 'vem-ocrdiag2-'));
    const video = await makeTestVideo(join(d, 'v.mp4'), 1);
    const frame = await extractFrame(video, 0.5, join(d, 'f.jpg'));
    const err = await failureMessage(frame, 'zzz_nonexistent');

    expect(err).toContain('present,');
    expect(err).not.toContain('MISSING');
  }, 60_000);
});

describe.skipIf(!ready)('where the OCR crop is staged', () => {
  it('does not depend on os.tmpdir() at all', async () => {
    // A real run lost all 459 frames with the crop in /tmp: the file was
    // there, 193101 bytes of it, and tesseract still reported "image file not
    // found", while the frames in that same directory were read without
    // trouble. Crops are therefore staged beside the frame -- a directory the
    // pipeline is demonstrably reading and writing already.
    //
    // Pointing TMPDIR somewhere unusable proves the dependency is gone: the
    // previous implementation wrote there and would fail outright.
    const d = mkdtempSync(join(tmpdir(), 'vem-ocrstage-'));
    const video = await makeTestVideo(join(d, 'v.mp4'), 1);
    const frame = await extractFrame(video, 0.5, join(d, 'f.jpg'));

    const prev = process.env['TMPDIR'];
    process.env['TMPDIR'] = join(d, 'does', 'not', 'exist');
    try {
      const r = await ocrFrame(frame, 'eng');
      expect(typeof r.content).toBe('string');
    } finally {
      if (prev === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = prev;
    }
  }, 60_000);

  it('leaves no crop files behind next to the frame', async () => {
    const d = mkdtempSync(join(tmpdir(), 'vem-ocrclean-'));
    const video = await makeTestVideo(join(d, 'v.mp4'), 1);
    const frame = await extractFrame(video, 0.5, join(d, 'f.jpg'));
    await ocrFrame(frame, 'eng');
    expect(readdirSync(d).sort()).toEqual(['f.jpg', 'v.mp4']);
  }, 60_000);
});
