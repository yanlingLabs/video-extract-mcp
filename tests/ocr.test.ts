import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyTextRegion, normalizeText, textDelta, computeTextNovelty, ocrFrame,
} from '../src/vision/ocr.js';
import type { Candidate } from '../src/types.js';

const cand = (over: Partial<Candidate>): Candidate => ({
  timestamp: 0, sceneId: 0, imagePath: 'x.jpg', sceneSignificance: 0, quality: 1, ...over,
});

// ---------------------------------------------------------------------------
// Canonical MUST-KEEP examples from the design intent (review round 2,
// finding 1): a chart value changing inside a table, and one code line
// changing inside a block. Both are constructed with a SINGLE changed
// token-pair against a majority-unique surrounding vocabulary -- verified
// below, not assumed -- so they actually exercise dilution: a repeated
// filler token would silently shrink the measured symmetric difference and
// make the test pass for the wrong reason.
// ---------------------------------------------------------------------------

// 32 tokens, all unique (verified: measure-canonical.ts reported 32/32
// unique on each side before this fix). "$12m"/"$27m" appear nowhere else in
// the sentence.
const chartA = "quarterly review meeting notes discussed regional sales performance across north and south divisions with steady upward trends noted by senior leadership Revenue: $12M total reported for the fiscal period under normal conditions";
const chartB = "quarterly review meeting notes discussed regional sales performance across north and south divisions with steady upward trends noted by senior leadership Revenue: $27M total reported for the fiscal period under normal conditions";

// ~10 lines / 39 tokens, 23 unique (repeats are realistic code tokens like
// "=", "let", "total" -- fine, they sit in the intersection). The changed
// tokens ("0" removed, "calculate_total(items)" added) are each unique to
// that one line and appear nowhere else in the block.
const codeA = `function processOrder(order) {
  const items = order.items
  const customer = order.customer
  total = 0
  let discount = getDiscount(customer)
  let tax = calculateTax(order)
  let shipping = getShippingCost(order)
  let finalAmount = total + tax + shipping - discount
  return finalAmount
}`;
const codeB = `function processOrder(order) {
  const items = order.items
  const customer = order.customer
  total = calculate_total(items)
  let discount = getDiscount(customer)
  let tax = calculateTax(order)
  let shipping = getShippingCost(order)
  let finalAmount = total + tax + shipping - discount
  return finalAmount
}`;

// ---------------------------------------------------------------------------
// Pure-logic tests: classifyTextRegion, normalizeText, textDelta, and
// computeTextNovelty all take primitives/plain objects and do no I/O, so per
// the task brief these are exercised directly with real strings -- no
// mocking of tesseract or sharp is needed or used anywhere in this section.
// ---------------------------------------------------------------------------

describe('classifyTextRegion', () => {
  it('treats the lower third as a caption band', () => {
    // Kills "classifyTextRegion always returns 'content'": this must be caption_band.
    expect(classifyTextRegion({ top: 640, height: 40 }, 720)).toBe('caption_band');
  });
  it('treats the upper edge as a caption band', () => {
    // Second, independent way to kill "always returns 'content'" -- an upper-band case too.
    expect(classifyTextRegion({ top: 10, height: 30 }, 720)).toBe('caption_band');
  });
  it('treats the middle as content', () => {
    // Kills "classifyTextRegion always returns 'caption_band'": this must be content.
    expect(classifyTextRegion({ top: 300, height: 40 }, 720)).toBe('content');
  });
});

describe('normalizeText', () => {
  it('lowercases', () => {
    expect(normalizeText('Revenue')).toBe('revenue');
  });
  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeText('a    b\t\tc')).toBe('a b c');
  });
  it('trims leading and trailing whitespace', () => {
    expect(normalizeText('  padded  ')).toBe('padded');
  });
});

describe('textDelta', () => {
  it('is 0 for identical text', () => expect(textDelta('total = 0', 'total = 0')).toBe(0));
  it('is 1 when text appears from nothing', () => expect(textDelta('', 'Revenue: $12M')).toBe(1));
  it('is high for a changed value', () => {
    expect(textDelta('Revenue: $12M', 'Revenue: $27M')).toBeGreaterThan(0.2);
  });
  it('ignores whitespace and case noise', () => {
    // Together with the two tests above (which require deltas of 1 and >0.2),
    // no constant return value can also satisfy this 0 -- kills "textDelta
    // returns a constant".
    expect(textDelta('Total = 0', 'total   =  0')).toBe(0);
  });
});

describe('textDelta (review round 2, finding 1: dilution)', () => {
  // Measured against the PRE-fix implementation (see task-8-report.md
  // addendum): textDelta(chartA, chartB) = 0.0606, textDelta(codeA, codeB) =
  // 0.0833 -- both far below the 0.3 HIGH bar. A pooled ratio over the whole
  // token set dilutes a single-token edit by the size of the surrounding
  // document; the fix must register a LOCALIZED change strongly regardless
  // of how much unchanged text surrounds it. Catches: a measure that still
  // divides the changed-token count by the total vocabulary size instead of
  // saturating on the absolute count of changed tokens.
  it('registers the canonical chart-value substitution embedded in ~30 tokens of unchanged text as HIGH', () => {
    expect(textDelta(chartA, chartB)).toBeGreaterThan(0.3);
  });

  it('registers the canonical one-changed-line-in-a-code-block substitution as HIGH', () => {
    expect(textDelta(codeA, codeB)).toBeGreaterThan(0.3);
  });

  it('still yields exactly 0 for identical text, at this length too', () => {
    // Guards that the dilution fix didn't trade the false-negative (missed
    // edit) for a false-positive (long identical text reading as changed).
    expect(textDelta(chartA, chartA)).toBe(0);
  });

  it('still yields exactly 1 when text appears from nothing, at this length too', () => {
    expect(textDelta('', chartA)).toBe(1);
  });

  it('still yields the wholesale-replacement ceiling for a SHORT completely-different text', () => {
    // Catches a "fix" that solves dilution by replacing the Jaccard ratio
    // outright with a raw count/K formula: for a short text (few tokens),
    // count/K would UNDERSHOOT 1 even for 100% replacement (e.g. 2 changed
    // tokens / K=3 = 0.667, not ~1), which would be a regression against the
    // ALREADY-passing "textDelta is high for a changed value" test's spirit
    // and against short caption-vs-caption wholesale swaps generally. The
    // fix must keep (not replace) the property that zero token overlap ==
    // maximal delta regardless of size.
    expect(textDelta('hello there friend', 'goodbye now stranger')).toBe(1);
  });

  it('registers a modest genuinely-new addition (not just a substitution) as more than noise', () => {
    // Two new tokens appended, nothing removed, nothing already present in
    // chartA repeated ("plus" and "updates" do not appear in chartA).
    expect(textDelta(chartA, chartA + ' plus updates')).toBeGreaterThan(0.1);
  });

  it('keeps a single localized substitution distinctly below a wholesale replacement -- not a step function', () => {
    // Ordering test, mirroring the project's decisive-comparison pattern:
    // proves the fix has genuine gradation rather than jumping straight to
    // ~1 for ANY nonzero difference once token count clears the small
    // saturating denominator. Catches an over-correction where the measure
    // becomes "any difference at all = maximal", which would ALSO
    // technically satisfy the two HIGH-novelty tests above for the wrong
    // reason (everything reads as maximal, indiscriminately).
    const localized = textDelta(chartA, chartB); // one token-pair changed
    const wholesale = textDelta(chartA, 'zebra umbrella typewriter mountain velvet orchestra prism lantern');
    expect(wholesale).toBeGreaterThan(localized);
  });
});

describe('computeTextNovelty (spec §13)', () => {
  it('gives HIGH novelty when persistent content text changes', () => {
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'total = 0', ocrSubtitle: '' }),
      cand({ timestamp: 5, ocrContent: 'total = calculate_total(items)', ocrSubtitle: '' }),
    ]);
    expect(out[1]!.textNovelty!).toBeGreaterThan(0.3);
  });

  it('gives LOW novelty when only the subtitle overlay changes', () => {
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'same slide', ocrSubtitle: 'and then I said' }),
      cand({ timestamp: 5, ocrContent: 'same slide', ocrSubtitle: 'something completely different' }),
    ]);
    expect(out[1]!.textNovelty!).toBeLessThan(0.15);
  });

  it('still gives a subtitle-only change a small POSITIVE novelty -- not zero', () => {
    // Pins the exact discounted value. contentDelta is 0 (identical content
    // text) and subtitleDelta is exactly 1 (zero token overlap between "and
    // then i said" and "something completely different"), so a correct
    // SUBTITLE_DISCOUNT=0.1 implementation must land on exactly 0 + 0.1*1 =
    // 0.1. This single assertion kills BOTH required mutations at once:
    // - SUBTITLE_DISCOUNT=1.0 would give 0 + 1.0*1 = 1.0 (fails toBeCloseTo(0.1))
    // - SUBTITLE_DISCOUNT=0   would give 0 + 0*1   = 0.0 (fails toBeGreaterThan(0)
    //   AND fails toBeCloseTo(0.1))
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'same slide', ocrSubtitle: 'and then I said' }),
      cand({ timestamp: 5, ocrContent: 'same slide', ocrSubtitle: 'something completely different' }),
    ]);
    expect(out[1]!.textNovelty!).toBeGreaterThan(0);
    expect(out[1]!.textNovelty!).toBeCloseTo(0.1, 10);
  });

  it('ranks a content change above a subtitle change (the decisive spec §13 behavior)', () => {
    // This is the test that encodes the whole point of the task: a
    // visually-identical pair of frames where ONLY the caption-band text
    // changed must rank BELOW a pair where the content-region text changed.
    // An implementation that returns a mid-range constant for every input
    // (e.g. always 0.5) ties these two cases and fails the ordering
    // assertion below, even though such a constant might slip past
    // threshold-only tests elsewhere.
    const [, subtitleOnly] = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'slide', ocrSubtitle: 'a' }),
      cand({ timestamp: 5, ocrContent: 'slide', ocrSubtitle: 'totally new words here' }),
    ]);
    const [, contentChange] = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'slide one', ocrSubtitle: 'a' }),
      cand({ timestamp: 5, ocrContent: 'slide two entirely', ocrSubtitle: 'a' }),
    ]);
    expect(contentChange!.textNovelty!).toBeGreaterThan(subtitleOnly!.textNovelty!);
  });

  it('gives the first candidate zero novelty (nothing to compare against)', () => {
    const out = computeTextNovelty([cand({ ocrContent: 'hello', ocrSubtitle: '' })]);
    expect(out[0]!.textNovelty).toBe(0);
  });

  it('compares each candidate against the PRECEDING candidate, not a fixed reference', () => {
    // With only 2 candidates (as in every test above), "prev" and "the first
    // candidate" are the same object, so those tests cannot distinguish a
    // correct cands[i-1] lookup from a bug that always compares against
    // cands[0]. A 3rd candidate whose content diverges from candidate 0 but
    // matches candidate 1 breaks that tie.
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'aaa', ocrSubtitle: '' }),
      cand({ timestamp: 5, ocrContent: 'bbb', ocrSubtitle: '' }),
      cand({ timestamp: 10, ocrContent: 'bbb', ocrSubtitle: '' }),
    ]);
    // Sanity check shared by both correct and buggy implementations (i=1's
    // predecessor is index 0 either way): totally disjoint tokens -> max delta.
    expect(out[1]!.textNovelty).toBe(1);
    // Decisive: candidate 2 has IDENTICAL text to candidate 1 (its true
    // predecessor) but totally different text from candidate 0 (the first
    // candidate). Comparing against cands[i-1] gives 0; comparing against a
    // fixed "first candidate" reference gives 1.
    expect(out[2]!.textNovelty).toBe(0);
  });

  it('preserves unrelated Candidate fields on the output, not just the ones it reads', () => {
    const c0 = cand({
      timestamp: 1, sceneId: 4, imagePath: 'foo.jpg', sceneSignificance: 0.5,
      quality: 0.77, embedding: [1, 2, 3], ocrContent: 'a', ocrSubtitle: '',
    });
    const c1 = cand({
      timestamp: 2, sceneId: 9, imagePath: 'bar.jpg', sceneSignificance: 0.9,
      quality: 0.42, embedding: [4, 5, 6], ocrContent: 'b', ocrSubtitle: '',
    });
    const out = computeTextNovelty([c0, c1]);
    expect(out[0]!.imagePath).toBe('foo.jpg');
    expect(out[0]!.embedding).toEqual([1, 2, 3]);
    expect(out[0]!.quality).toBe(0.77);
    expect(out[1]!.imagePath).toBe('bar.jpg');
    expect(out[1]!.sceneId).toBe(9);
    expect(out[1]!.embedding).toEqual([4, 5, 6]);
  });
});

describe('computeTextNovelty (review round 2, finding 1: dilution)', () => {
  // The acceptance criteria are phrased in terms of computeTextNovelty's
  // output ("must yield HIGH novelty"), not just textDelta's, so these
  // exercise the full path a real Candidate pair goes through -- not
  // redundant with the textDelta-level tests above, since a bug introduced
  // between textDelta and the final novelty value (e.g. a weight applied to
  // the wrong term) would not be visible at the textDelta level at all.
  it('gives HIGH novelty for the canonical chart-value MUST-KEEP example', () => {
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: chartA, ocrSubtitle: '' }),
      cand({ timestamp: 5, ocrContent: chartB, ocrSubtitle: '' }),
    ]);
    expect(out[1]!.textNovelty!).toBeGreaterThan(0.3);
  });

  it('gives HIGH novelty for the canonical one-changed-line-in-a-code-block MUST-KEEP example', () => {
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: codeA, ocrSubtitle: '' }),
      cand({ timestamp: 5, ocrContent: codeB, ocrSubtitle: '' }),
    ]);
    expect(out[1]!.textNovelty!).toBeGreaterThan(0.3);
  });
});

describe('computeTextNovelty (review round 2, finding 2: persistence-aware content discount)', () => {
  // Spatial discounting alone cannot tell an upper-third caption (churns
  // every couple of seconds, spec's explicit "sometimes upper third" case)
  // apart from a slide title (changes once, then holds) -- both sit in the
  // content region, so spatial classification alone treats them
  // identically. Persistence -- does the change hold into the NEXT
  // candidate, or does it change again right away -- is what the finding
  // says must discriminate them.
  //
  // NOTE on red/green: the "persists" test below is expected to ALREADY
  // pass before this fix (a content change with nothing to compare against
  // in the next candidate already got full weight under the pre-fix
  // formula, which had no notion of "next" at all). Its purpose is not to
  // fail pre-fix; it is the paired absolute-threshold half of the decisive
  // ordering test, and it is what mutation 8 (persistence signal that
  // ALWAYS discounts) fails against. The "churns" and "ranks" tests below
  // ARE expected to fail pre-fix, since pre-fix there is no discount at all
  // for a content-region change regardless of what happens next.
  it('keeps FULL weight for a content change that PERSISTS into the next candidate (genuine change)', () => {
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'intro title slide', ocrSubtitle: '' }),
      cand({ timestamp: 5, ocrContent: 'quarterly results overview', ocrSubtitle: '' }),
      cand({ timestamp: 10, ocrContent: 'quarterly results overview', ocrSubtitle: '' }), // holds steady
    ]);
    expect(out[1]!.textNovelty!).toBeGreaterThan(0.3);
  });

  it('discounts a content change that CHURNS again in the next candidate (subtitle cadence, not a genuine change)', () => {
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'intro title slide', ocrSubtitle: '' }),
      cand({ timestamp: 5, ocrContent: 'random caption words here', ocrSubtitle: '' }),
      cand({ timestamp: 10, ocrContent: 'totally unrelated phrases now', ocrSubtitle: '' }), // churns again
    ]);
    expect(out[1]!.textNovelty!).toBeLessThan(0.15);
  });

  it('ranks a persisting content change above a churning content change (the decisive persistence behavior)', () => {
    // Mirrors the project's established decisive-ordering-test pattern: an
    // implementation that discounts everything, or nothing, or a constant
    // amount regardless of what comes next, ties or inverts this ordering.
    const persisting = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'intro title slide', ocrSubtitle: '' }),
      cand({ timestamp: 5, ocrContent: 'quarterly results overview', ocrSubtitle: '' }),
      cand({ timestamp: 10, ocrContent: 'quarterly results overview', ocrSubtitle: '' }),
    ])[1]!;
    const churning = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'intro title slide', ocrSubtitle: '' }),
      cand({ timestamp: 5, ocrContent: 'random caption words here', ocrSubtitle: '' }),
      cand({ timestamp: 10, ocrContent: 'totally unrelated phrases now', ocrSubtitle: '' }),
    ])[1]!;
    expect(persisting.textNovelty!).toBeGreaterThan(churning.textNovelty!);
  });

  it('gives text VANISHING no novelty: the frame after a flashed overlay is not new_text', () => {
    // Real-run regression: 14 of 35 selected frames of a music video carried
    // `new_text` with empty ocrContent. textDelta is symmetric, so "text ->
    // nothing" scored 1 on the empty frame while the frame that actually
    // showed the text was discounted as churn. Pinned exactly: the flashed
    // frame keeps its transient discount (0.1), the empty ones score 0.
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: '', ocrSubtitle: '' }),
      cand({ timestamp: 5, ocrContent: 'hello world a b', ocrSubtitle: '' }),
      cand({ timestamp: 10, ocrContent: '', ocrSubtitle: '' }),
      cand({ timestamp: 15, ocrContent: '', ocrSubtitle: '' }),
    ]);
    expect(out.map((c) => Number(c.textNovelty!.toFixed(6)))).toEqual([0, 0.1, 0, 0]);
  });

  it('gives a subtitle VANISHING no novelty either', () => {
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'same slide', ocrSubtitle: 'and then I said' }),
      cand({ timestamp: 5, ocrContent: 'same slide', ocrSubtitle: '' }),
    ]);
    expect(out[1]!.textNovelty).toBe(0);
  });

  it('gives FULL weight to text that appears on an empty frame and holds', () => {
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: '', ocrSubtitle: '' }),
      cand({ timestamp: 5, ocrContent: 'quarterly results overview', ocrSubtitle: '' }),
      cand({ timestamp: 10, ocrContent: 'quarterly results overview', ocrSubtitle: '' }),
    ]);
    expect(out[1]!.textNovelty).toBe(1);
  });

  it('does NOT discount a content change at the LAST candidate, where there is no next frame to test persistence against', () => {
    // Documents a deliberate tradeoff (see src/vision/ocr.ts comment): with
    // no future candidate to check, there is no evidence of churn, so we do
    // not discount -- absence of evidence is not evidence of churn. This
    // means a genuinely churning sequence's FINAL frame always gets full
    // weight (a small, accepted budget-leak at the batch boundary).
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'intro title slide', ocrSubtitle: '' }),
      cand({ timestamp: 5, ocrContent: 'quarterly results overview', ocrSubtitle: '' }),
    ]);
    expect(out[1]!.textNovelty!).toBeGreaterThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// ocrFrame: the real I/O boundary (sharp crop + tesseract subprocess). Per
// the task's evidence-integrity bar, this is exercised against REAL
// generated images containing REAL text -- no mocking of sharp or tesseract.
// Images are synthesized with sharp's SVG rasterizer so the exact pixels are
// under test control, then handed to the real ocrFrame implementation.
// ---------------------------------------------------------------------------

describe('ocrFrame', () => {
  let dir: string;
  let mixedPath: string;   // content-region text + caption-band text, same frame
  let blankPath: string;   // no text anywhere
  let chinesePath: string; // non-Latin script, content region only
  let oddPaths: string[];  // atypical dimensions, to prove the crop math never exceeds bounds

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'norma-ocr-'));

    // 1280x720: content text sits mid-frame (well inside the [0.12h, 0.78h]
    // content band); caption text sits on a black bar in the bottom 100px
    // (well inside the bottom 22% caption band), mimicking a burned-in
    // subtitle. Manually verified with the real tesseract binary before
    // writing this test: content crop OCRs to "Revenue 12M dollars" and the
    // bottom crop OCRs to "and then | said something" (capital "I" reads as
    // a pipe -- real OCR jitter), which is why assertions below key on
    // lowercased substrings that are robust to that jitter, not exact equality.
    mixedPath = join(dir, 'mixed.png');
    const mixedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
      <rect width="1280" height="720" fill="white"/>
      <text x="80" y="360" font-family="Arial, sans-serif" font-size="60" fill="black">Revenue 12M dollars</text>
      <rect x="0" y="620" width="1280" height="100" fill="black"/>
      <text x="80" y="685" font-family="Arial, sans-serif" font-size="40" fill="white">and then I said something</text>
    </svg>`;
    await sharp(Buffer.from(mixedSvg)).png().toFile(mixedPath);

    // Pure white, no text anywhere -- OCR on a blank frame should yield "".
    blankPath = join(dir, 'blank.png');
    await sharp({ create: { width: 640, height: 360, channels: 3, background: '#ffffff' } })
      .png().toFile(blankPath);

    // Chinese content text (simplified). Manually verified: chi_sim reads
    // this correctly as "你好世界收入"; the default 'eng' langs reads the
    // SAME image as garbage ("(oF tt RUA") -- grounding why the langs
    // parameter must actually reach tesseract, not be hardcoded to 'eng'.
    chinesePath = join(dir, 'chinese.png');
    const chineseSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300">
      <rect width="800" height="300" fill="white"/>
      <text x="40" y="150" font-family="PingFang SC, Heiti SC, Arial Unicode MS, sans-serif" font-size="60" fill="black">你好世界收入</text>
    </svg>`;
    await sharp(Buffer.from(chineseSvg)).png().toFile(chinesePath);

    // Atypical dimensions (odd, tiny) exercising the floor()-based crop math
    // (spec brief: sharp's .extract throws if a region exceeds the image
    // bounds). Blank content is fine here -- the point is that ocrFrame must
    // resolve at all, not what text it finds.
    const oddDims: Array<[number, number]> = [[11, 9], [101, 203], [721, 1281], [3, 7]];
    oddPaths = [];
    for (const [w, h] of oddDims) {
      const p = join(dir, `odd-${w}x${h}.png`);
      await sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } })
        .png().toFile(p);
      oddPaths.push(p);
    }
  }, 30_000);

  afterAll(() => {
    // Review round 2, Minor: this mkdtempSync fixture directory was never
    // cleaned up -- the reviewer found 25 leaked directories accumulated
    // across runs. force:true so a missing/already-removed dir doesn't fail
    // the suite.
    rmSync(dir, { recursive: true, force: true });
  });

  it('separates persistent content-region text from caption-band text', async () => {
    const { content, subtitle } = await ocrFrame(mixedPath);
    const c = content.toLowerCase();
    const s = subtitle.toLowerCase();
    // The content crop must contain the content-region text...
    expect(c).toContain('revenue');
    expect(c).toContain('12m');
    // ...and must NOT contain the caption text (proves the crop is spatially
    // bounded to the content band, not the whole frame).
    expect(c).not.toContain('something');
    // The caption crop must contain the caption text...
    expect(s).toContain('something');
    // ...and must NOT contain the content text (proves the two regions
    // aren't swapped or merged).
    expect(s).not.toContain('revenue');
  });

  it('returns empty strings for a frame with no text at all', async () => {
    const { content, subtitle } = await ocrFrame(blankPath);
    expect(content).toBe('');
    expect(subtitle).toBe('');
  });

  it('reads non-Latin script when the caller passes the matching tesseract language', async () => {
    const { content } = await ocrFrame(chinesePath, 'chi_sim');
    expect(content).toContain('你好');
  });

  it('does not throw when crop regions fall on atypical (odd/tiny) pixel boundaries', async () => {
    for (const p of oddPaths) {
      const result = await ocrFrame(p);
      expect(typeof result.content).toBe('string');
      expect(typeof result.subtitle).toBe('string');
    }
  });
});
