import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/util/run.js';

// The flagship discrimination, end to end (review IMPORTANT-5): a text
// change in the CONTENT region must drive frame selection ('new_text'),
// while a caption band churning at subtitle cadence must not rescue
// visually-redundant frames -- spec §13. No committed test covered the
// OCR -> computeTextNovelty -> selectFrames chain before this one:
// transposing the content/subtitle assignment in src/analyze.ts passed all
// 261 pre-existing tests.
//
// Fixture (generated at runtime; committed .mp4 files are gitignored):
// 20s, 1280x720, eight 2.5s segments on a mid-dark background (luma safely
// above the DARK_FLOOR quality gate). The middle of the frame shows
// CONTENT_A for the first half and CONTENT_B for the second (one persistent
// content change); the bottom band (below the 0.78h caption boundary)
// shows a DIFFERENT caption line every segment (churn at subtitle cadence).
// Validated standalone before this test was wired: scdet finds no
// boundaries (text-only cuts), so candidates are pure 5s heartbeats
// (0/5/10/15/20); all survive the quality gate (~0.88); tesseract reads
// both regions exactly on every candidate; computeTextNovelty yields 1.0
// at the content change and 0.1 (the subtitle discount, below the 0.3
// 'new_text' threshold) everywhere else.
//
// Discrimination proof (run manually, documented in the final fix report):
// swapping `c.ocrContent = content` / `c.ocrSubtitle = subtitle` at the
// analyze.ts OCR call site makes this test fail on both assertions below;
// the full 261-test pre-existing suite did not notice that mutation.

const FONT = '/System/Library/Fonts/Supplemental/Arial.ttf';
const tesseractPresent = spawnSync('tesseract', ['--version']).status === 0;
// The fixture draws its text with ffmpeg's drawtext filter, which not every
// build has: Homebrew's ffmpeg 9 dropped it (the macOS CI runner has no
// drawtext), so skip rather than fail on a fixture that cannot be built.
const drawtextPresent = / drawtext /.test(spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? '');
const ready = tesseractPresent && drawtextPresent && existsSync(FONT) && existsSync('dist/analyze.js');

const CONTENT_A = 'GRADIENT DESCENT CONVERGES';
const CONTENT_B = 'EIGENVALUE SPECTRUM SHIFTED';
const CAPTIONS = [
  'welcome back to the channel',
  'today we optimize models',
  'remember to like subscribe',
  'this part gets tricky',
  'watch the matrix closely',
  'numbers never lie folks',
  'almost done with proofs',
  'thanks for watching everyone',
];

async function makeOcrChainFixture(out: string): Promise<string> {
  const seg = 2.5;
  const inputs: string[] = [];
  const filters: string[] = [];
  for (let i = 0; i < 8; i++) {
    inputs.push('-f', 'lavfi', '-i', `color=c=0x2b3440:s=1280x720:d=${seg}`);
    const content = i < 4 ? CONTENT_A : CONTENT_B;
    filters.push(
      `[${i}:v]`
      + `drawtext=fontfile=${FONT}:text='${content}':fontsize=56:fontcolor=white:x=(w-text_w)/2:y=h*0.40,`
      + `drawtext=fontfile=${FONT}:text='${CAPTIONS[i]!}':fontsize=44:fontcolor=yellow:x=(w-text_w)/2:y=h*0.88`
      + `[v${i}]`,
    );
  }
  filters.push(`${Array.from({ length: 8 }, (_, i) => `[v${i}]`).join('')}concat=n=8:v=1:a=0[v]`);
  const r = await run('ffmpeg', [
    '-y', ...inputs, '-filter_complex', filters.join(';'),
    '-map', '[v]', '-r', '25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out,
  ]);
  if (r.code !== 0) throw new Error(`fixture generation failed: ${r.stderr.slice(-300)}`);
  return out;
}

describe.skipIf(!ready)('OCR -> text novelty -> selector chain (spec §13, end to end)', () => {
  let dir: string, video: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'norma-ocrchain-'));
    video = await makeOcrChainFixture(join(dir, 'ocrchain.mp4'));
  }, 120_000);

  it('selects the content-change frame with a new_text reason and never awards new_text to caption churn', async () => {
    const { analyzeVideo } = await import('../dist/analyze.js');
    // maxFrames=3 of ~5 candidates: real budget pressure, so the content
    // change must WIN a slot on merit, not fill an oversized quota.
    const m = await analyzeVideo(video, { maxFrames: 3, transcript: false, outDir: join(dir, 'out') });
    expect(m.source.status).toBe('ok');
    expect(m.processing.warnings).toEqual([]); // healthy run: OCR genuinely ran everywhere
    expect(m.frames).toHaveLength(3);
    expect(m.processing.candidateFrames).toBeGreaterThanOrEqual(4);

    const newTextFrames = m.frames.filter((f) => f.reasons.includes('new_text'));
    // Exactly ONE frame earns new_text: the persistent content change...
    expect(newTextFrames).toHaveLength(1);
    const changeFrame = newTextFrames[0]!;
    // ...its content-region OCR text landed in ocrContent (a transposed
    // wiring would put the caption line here instead)...
    expect(changeFrame.ocrContent ?? '').toContain('EIGENVALUE');
    // ...and it sits where the change actually happens (first candidate
    // whose frame shows CONTENT_B; scdet sees no boundaries in this
    // fixture, so candidates are 5s heartbeats and the B-side starts >10s).
    expect(changeFrame.timestamp).toBeGreaterThan(10);
    expect(changeFrame.timestamp).toBeLessThan(18);

    // Every OTHER selected frame sat through a full caption-band text swap
    // (the fixture churns the caption EVERY 2.5s) yet must not read as a
    // text-novelty pick: the subtitle discount caps churn at 0.1, below the
    // 0.3 new_text threshold.
    for (const f of m.frames) {
      if (f === changeFrame) continue;
      expect(f.reasons).not.toContain('new_text');
    }
  }, 300_000);
});
