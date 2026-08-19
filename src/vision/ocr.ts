import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { run } from '../util/run.js';
import type { Candidate } from '../types.js';

// Caption bands per spec (lower third, sometimes upper third, of the frame).
// classifyTextRegion's per-box classification and ocrFrame's fixed-crop
// boundaries both derive from these two constants so they cannot silently
// drift apart -- review round 2 finding: previously duplicated as
// independent magic literals in each function (0.12/0.78 in both places,
// plus a THIRD literal, 0.66, in ocrFrame's content height that happened to
// equal their difference without saying so).
//
// classifyTextRegion itself currently has no caller in this module.
// ocrFrame does two FIXED crops rather than classifying individual OCR
// bounding boxes -- tesseract's plain-stdout mode (what ocrBuffer uses)
// returns no box coordinates to classify, so there is no natural per-box
// call site to wire classifyTextRegion into without speculatively
// restructuring working crop logic for no behavioral gain. Sharing these
// constants is the correctly-scoped fix for the actual risk named in review
// (the two thresholds drifting apart), not a reason to force a call site
// that doesn't exist yet.
const CAPTION_BAND_TOP = 0.12;
const CAPTION_BAND_BOTTOM = 0.78;

/** Burned-in captions live in the top/bottom bands; real content lives in the middle. */
export function classifyTextRegion(
  box: { top: number; height: number }, frameHeight: number,
): 'caption_band' | 'content' {
  const center = box.top + box.height / 2;
  const r = center / frameHeight;
  return r > CAPTION_BAND_BOTTOM || r < CAPTION_BAND_TOP ? 'caption_band' : 'content';
}

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// spec review round 2, finding 1: the motivating examples (one code line
// changing inside a block; one chart value changing inside a table) are
// LOCALIZED edits inside much larger unchanged regions -- the content crop
// spans 66% of frame height, so multi-line/multi-value text is the normal
// case. A small, fixed denominator so a handful of changed tokens already
// reads as high novelty, however large the surrounding document is.
const TOKEN_CHANGE_SATURATION = 3;

/**
 * Token-level change measure: robust to OCR jitter (case/whitespace fully
 * absorbed by normalizeText before tokens are ever compared), sensitive to
 * real edits, and NOT diluted by unchanged surrounding text. Two components,
 * combined by taking the larger:
 *  - `ratio`: the original Jaccard distance, 1 - |intersection|/|union|.
 *    Already correct for SHORT texts on its own: whenever the two token sets
 *    share nothing, ratio is exactly 1 regardless of size, so a short
 *    wholesale replacement (e.g. one caption swapped for a totally different
 *    one) still reads as maximal novelty.
 *  - `saturating`: |symmetric difference| / TOKEN_CHANGE_SATURATION, capped
 *    at 1. This is what fixes dilution (review round 2, finding 1): a
 *    handful of changed tokens registers strongly no matter how large the
 *    surrounding vocabulary is, because it is never divided by the total
 *    token count.
 * `ratio` alone under-reacts on long documents (dilution); `saturating`
 * alone under-reacts on short ones (a 1-token vs 1-token total replacement
 * would undershoot 1). Taking the max keeps both guarantees.
 *
 * On the jitter/genuine-edit balance: this function cannot, and does not try
 * to, distinguish a genuine single-token edit from a single-token OCR
 * misread by string content alone -- those are lexically identical events,
 * and no pairwise lexical comparison can tell them apart. That
 * discrimination is deliberately NOT this function's job. It belongs to
 * computeTextNovelty's persistence check (a change must hold steady into
 * the next candidate to keep full weight): a genuine content change
 * persists on screen; OCR noise and subtitle churn do not.
 */
export function textDelta(a: string, b: string): number {
  const A = new Set(normalizeText(a).split(' ').filter(Boolean));
  const B = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (A.size === 0 && B.size === 0) return 0;
  if (A.size === 0 || B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  const ratio = 1 - inter / union;
  const changed = (A.size - inter) + (B.size - inter); // |A\B| + |B\A|
  const saturating = Math.min(1, changed / TOKEN_CHANGE_SATURATION);
  return Math.max(ratio, saturating);
}

// spec §13: burned-in captions (TikTok/Reels/Shorts-style) churn every couple
// of seconds as the speaker talks and are already captured by the transcript,
// so a subtitle-only change must not by itself make a visually-redundant
// frame look "important". Content-region text (slide/code/chart/UI) changing
// is the strong signal; a subtitle changing alone should nudge novelty up
// only slightly, never dominate it. Also reused below as the persistence
// discount floor (review round 2, finding 2) -- the finding's own language
// is "discounted toward the subtitle weight", i.e. the same constant, not a
// new one.
const SUBTITLE_DISCOUNT = 0.1;   // spec §13: overlays must not rescue redundant frames

export function computeTextNovelty(cands: Candidate[]): Candidate[] {
  return cands.map((c, i) => {
    if (i === 0) return { ...c, textNovelty: 0 };
    const prev = cands[i - 1]!;
    const next = cands[i + 1]; // undefined when c is the last candidate

    const contentDeltaIn = textDelta(prev.ocrContent ?? '', c.ocrContent ?? '');
    const subtitleDelta = textDelta(prev.ocrSubtitle ?? '', c.ocrSubtitle ?? '');

    // Persistence-aware discount (spec §13, review round 2 finding 2):
    // spatial discounting alone can't tell an upper-third caption that
    // churns every couple of seconds apart from a slide title that changes
    // once and holds -- both sit in the content region. Persistence is the
    // discriminator the spec calls for. Check whether c's content survives
    // into the NEXT candidate: if it changes again right away (churns),
    // discount toward the same weight a caption-band change gets; if it
    // holds (persists), it's a genuine change and keeps full weight.
    //
    // With no next candidate (c is the last one in the batch), there is no
    // evidence either way, and absence of evidence is not evidence of
    // churn, so we do not discount. Documented tradeoff: in a genuinely
    // churning sequence, every MIDDLE candidate gets discounted but the
    // batch's FINAL candidate always gets full weight -- a small, accepted
    // one-frame budget leak at the boundary. A wider look-ahead window could
    // close it; this minimal 3-candidate check (prev, current, next) matches
    // the finding's own "differs, then differs again" description and no
    // more.
    const contentDeltaOut = next ? textDelta(c.ocrContent ?? '', next.ocrContent ?? '') : 0;
    const persistenceWeight = 1 - contentDeltaOut * (1 - SUBTITLE_DISCOUNT);
    const contentContribution = contentDeltaIn * persistenceWeight;

    const novelty = Math.min(1, contentContribution + SUBTITLE_DISCOUNT * subtitleDelta);
    return { ...c, textNovelty: novelty };
  });
}

/** Splits the frame into caption bands vs content and OCRs them separately. */
export async function ocrFrame(imagePath: string, langs = 'eng') {
  const meta = await sharp(imagePath).metadata();
  const w = meta.width ?? 0, h = meta.height ?? 0;
  if (!w || !h) return { content: '', subtitle: '' };

  const contentTop = Math.floor(h * CAPTION_BAND_TOP);
  const bottomTop = Math.floor(h * CAPTION_BAND_BOTTOM);
  // Derived from the two already-floored boundaries, not a separate 0.66
  // literal, so the content crop ends exactly where the bottom crop begins
  // -- no float-epsilon question, and no gap row left uncovered by either
  // crop (the old floor(h*0.66) form occasionally undershot by 1px; e.g. at
  // h=9 it gave contentH=5, leaving row 6 in neither crop, versus 6 here).
  const contentH = Math.max(1, bottomTop - contentTop);

  // tesseract reads a file more reliably than stdin across builds; write temp crops.
  const contentBuf = await sharp(imagePath).extract({ left: 0, top: contentTop, width: w, height: contentH }).png().toBuffer();
  const bottomBuf = await sharp(imagePath)
    .extract({ left: 0, top: bottomTop, width: w, height: Math.max(1, h - bottomTop) }).png().toBuffer();

  // Crops are staged NEXT TO the frame, not in os.tmpdir().
  //
  // A real run lost all 459 frames with the crop written to /tmp: the file
  // was there, 193101 bytes of it, and tesseract still reported "image file
  // not found". The frames in that same run were read without trouble by
  // ffmpeg and sharp -- so the directory holding them demonstrably works for
  // this process and its children, and a global temp directory demonstrably
  // The difference was found by reading the failing server's own environment:
  // it had NO TMPDIR set at all, where a server launched by another client on
  // the same machine had `TMPDIR=/var/folders/.../T/`. With TMPDIR unset,
  // os.tmpdir() falls back to `/tmp` -- and the failing crop path was
  // `/tmp/norma-ocr-<pid>-....png` carrying that server's exact pid. So the
  // temp directory this code writes to is decided by how the MCP client
  // happened to launch the process, which is not something a video pipeline
  // should depend on. Staging beside the frame removes the dependency
  // entirely; it needs no theory about why `/tmp` failed for that process.
  const stageDir = dirname(imagePath);
  const [content, subtitle] = await Promise.all([
    ocrBuffer(contentBuf, langs, stageDir), ocrBuffer(bottomBuf, langs, stageDir),
  ]);
  return { content, subtitle };
}

/**
 * What the file tesseract was pointed at actually looked like, described
 * without throwing -- a diagnostic must never become the failure it reports.
 */
function describeInput(p: string): string {
  try {
    return `present, ${statSync(p).size} bytes`;
  } catch {
    return 'MISSING when tesseract ran';
  }
}

async function ocrBuffer(buf: Buffer, langs: string, stageDir: string): Promise<string> {
  const { writeFile, unlink } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const p = join(stageDir, `.norma-ocr-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
  await writeFile(p, buf);
  try {
    // Failures PROPAGATE (spawn error rejects; nonzero exit -- missing
    // language pack, timeout-kill's code -1 -- throws below) instead of
    // being swallowed into ''. The caller (src/analyze.ts) records each
    // failure in Manifest.processing.warnings; a genuinely textless crop
    // still returns '' via a clean zero exit, so "no text" stays honest and
    // a dead tesseract no longer masquerades as it.
    const { stdout, stderr, code } = await run('tesseract', [p, 'stdout', '-l', langs], { timeoutMs: 30_000 });
    if (code !== 0) {
      // Say what the input WAS, not just what tesseract said about it.
      //
      // A real run lost all 459 frames to this, and the message made the
      // cause undiagnosable: leptonica reports "image file not found", then
      // retries using the file's own magic bytes as the filename, so it
      // prints `image file not found: \x89PNG` -- which reads as though this
      // code passed image data where a path belonged. It does not. Hours went
      // into a hypothesis (a space in the temp path) that a controlled test
      // later disproved outright.
      //
      // The one fact that would have settled it is whether the file was still
      // there when tesseract looked, so it is now recorded AFTER the call:
      // present with a plausible size means the problem is tesseract's
      // reading of it; absent or empty means it was never written, or
      // something removed it mid-call, and those are different bugs.
      throw new Error(
        `tesseract exited ${code} [input: ${p}, ${describeInput(p)}, langs: ${langs}]: `
        + stderr.slice(-200).trim(),
      );
    }
    return stdout.replace(/\s+/g, ' ').trim();
  } finally { await unlink(p).catch(() => {}); }
}
