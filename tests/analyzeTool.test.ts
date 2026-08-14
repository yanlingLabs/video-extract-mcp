import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const analyzeMock = vi.fn();
vi.mock('../src/analyze.js', () => ({ analyzeVideo: (...a: unknown[]) => analyzeMock(...a) }));
const { analyzeVideoTool, itemDir } = await import('../src/agent/analyzeTool.js');
afterEach(() => analyzeMock.mockReset());

const manifest = (over: Record<string, unknown> = {}) => ({
  source: { url: 'u', platform: 'p', title: 'T', duration: 10, resolvedBy: 'ytdlp', status: 'ok', filePath: '/x/work.mp4' },
  transcript: { language: 'en', source: 'asr', segments: [{ start: 0, end: 1, text: 'hi' }] },
  frames: [{ timestamp: 1, sceneId: 0, image: '/x/f1.jpg', importance: 0.5, reasons: [], ocrContent: null, transcriptWindow: null, nearestSelectedSimilarity: 0 }],
  processing: { selectedFrames: 1, candidateFrames: 3, peakRssMb: 100, selectorVersion: '1', frameMode: 'key', warnings: [] },
  ...over,
});

describe('analyzeVideoTool', () => {
  it('always writes the transcript to disk, even when returning it inline', async () => {
    analyzeMock.mockResolvedValue(manifest());
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [{ pathOrUrl: 'https://x/v' }] });
    expect(existsSync(r.videos[0]!.transcriptPath!)).toBe(true);
    expect(r.videos[0]!.transcript).toBeDefined();
  });

  it('writes the transcript but omits it inline when it is long', async () => {
    // NOTE: the brief's own fixture (800 segments of `line ${i}`) totals
    // 6290 chars -- BELOW INLINE_TRANSCRIPT_MAX_CHARS (8000), so it would
    // actually get inlined and this test would fail against a correct
    // implementation (verified directly: node -e with the brief's exact
    // generator prints 6290). Padded here so the total genuinely clears
    // the threshold, which is the property this test exists to check.
    const segments = Array.from({ length: 800 }, (_, i) => ({ start: i, end: i + 1, text: `line number ${i} of the transcript` }));
    analyzeMock.mockResolvedValue(manifest({ transcript: { language: 'en', source: 'asr', segments } }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [{ pathOrUrl: 'https://x/v' }] });
    expect(existsSync(r.videos[0]!.transcriptPath!)).toBe(true);
    expect(r.videos[0]!.transcript).toBeUndefined();
    expect(JSON.parse(readFileSync(r.videos[0]!.transcriptPath!, 'utf8')).segments).toHaveLength(800);
  });

  it('always writes the manifest at the literal expected path (manifest.json)', async () => {
    // Asserts the literal expected path, not just existsSync(r.manifestPath)
    // read back from the function's own return value -- an implementation
    // that writes to the wrong filename but faithfully reports that same
    // wrong path back would pass an existsSync-only check. This is the
    // exact weakness called out from an earlier task in this plan, where
    // three mutants survived a test shaped that way.
    analyzeMock.mockResolvedValue(manifest());
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [{ pathOrUrl: 'https://x/v' }] });
    const expectedPath = join(dir, 'manifest.json');
    expect(r.videos[0]!.manifestPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
  });

  it('passes destinationPath and outDir down so the video and frames land there (spec §2.2)', async () => {
    analyzeMock.mockResolvedValue(manifest());
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    await analyzeVideoTool({ destinationPath: dir, videos: [{ pathOrUrl: 'https://x/v' }] });
    expect(analyzeMock.mock.calls[0]![1]).toMatchObject({ destinationPath: dir, outDir: dir });
  });

  it('forwards language as the explicit override (spec §4)', async () => {
    analyzeMock.mockResolvedValue(manifest());
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    await analyzeVideoTool({ destinationPath: dir, videos: [{ pathOrUrl: 'https://x/v', language: 'ja' }] });
    expect(analyzeMock.mock.calls[0]![1]).toMatchObject({ preferredLanguage: 'ja' });
  });

  it('surfaces a failure manifest without throwing', async () => {
    analyzeMock.mockResolvedValue(manifest({
      source: { url: 'u', platform: 'unknown', title: '', duration: 0, resolvedBy: 'none', status: 'unsupported', reason: 'drm_protected' },
      transcript: null, frames: [],
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [{ pathOrUrl: 'https://x/v' }] });
    expect(r.videos[0]!.status).toBe('unsupported');
    expect(r.videos[0]!.frameCount).toBe(0);
  });

  it('returns a structured failure instead of throwing when destinationPath exists as a file (EEXIST)', async () => {
    // Mirrors tests/resolveTool.test.ts's own EEXIST case: an ordinary
    // caller mistake (a stale or mistyped destinationPath that is actually
    // a file) throws from mkdirSync before analyzeVideo is ever called.
    // Without an outer boundary this is an uncaught rejection, breaking the
    // "returns a result, never throws" contract every other failure path
    // in this module (and its sibling resolveVideoTool) honours.
    analyzeMock.mockResolvedValue(manifest());
    const parent = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const notADir = join(parent, 'blocked');
    writeFileSync(notADir, 'i am a file, not a directory');
    const r = await analyzeVideoTool({ destinationPath: notADir, videos: [{ pathOrUrl: 'https://x/v' }] });
    expect(r.videos[0]!.status).not.toBe('ok');
    expect(typeof r.videos[0]!.manifestPath).toBe('string');
    expect(r.videos[0]!.videoPath).toBeUndefined();
  });

  it('returns a structured failure instead of throwing when analyzeVideo itself rejects unexpectedly', async () => {
    // The real analyzeVideo never rejects (src/analyze.ts wraps its whole
    // body in try/catch and always resolves to a Manifest) -- but this
    // handler must not simply trust that forever. A mocked rejection
    // stands in for "something inside the attempt threw" generally,
    // proving the outer boundary catches it rather than propagating an
    // unhandled rejection to the caller.
    analyzeMock.mockRejectedValue(new Error('pipeline exploded'));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [{ pathOrUrl: 'https://x/v' }] });
    expect(r.videos[0]!.status).not.toBe('ok');
    expect(r.videos[0]!.reason).toContain('pipeline exploded');
    expect(r.videos[0]!.videoPath).toBeUndefined();
  });

  it('reports degradation warnings so silent failure is visible', async () => {
    analyzeMock.mockResolvedValue(manifest({
      processing: { selectedFrames: 1, candidateFrames: 3, peakRssMb: 100, selectorVersion: '1', frameMode: 'key', warnings: ['ocr unavailable'] },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [{ pathOrUrl: 'https://x/v' }] });
    expect(r.videos[0]!.warnings).toEqual(['ocr unavailable']);
  });

  it('omits transcriptPath entirely when no transcript was produced', async () => {
    analyzeMock.mockResolvedValue(manifest({ transcript: null }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [{ pathOrUrl: 'https://x/v' }] });
    expect(r.videos[0]!.transcriptPath).toBeUndefined();
  });

  it('does not copy a local source into destinationPath (spec §2.1)', async () => {
    // A clip the agent already placed must not be duplicated: videoPath
    // points at the existing file, and no copy of it appears alongside
    // the manifest. Catches an implementation that copies unconditionally.
    const src = mkdtempSync(join(tmpdir(), 'norma-src-'));
    const local = join(src, 'clip.mp4');
    writeFileSync(local, 'not-real-video');
    analyzeMock.mockResolvedValue(manifest({
      source: { url: local, platform: 'local', title: 'T', duration: 10, resolvedBy: 'direct', status: 'ok', filePath: local },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [{ pathOrUrl: local }] });
    expect(r.videos[0]!.videoPath).toBe(local);
    expect(readdirSync(dir).filter((f) => f.endsWith('.mp4'))).toEqual([]);
  });

  it("keeps analyzeVideo's own working directory out of destinationPath for a local source (spec §2.1)", async () => {
    // analyzeVideo's normalize() step (src/media/ffmpeg.ts) unconditionally
    // writes a re-encoded working copy into whatever outDir it receives
    // (src/analyze.ts passes opts.outDir straight through as workDir).
    // Passing destinationPath as outDir for an already-local source would
    // put that re-encoded copy directly in the deliverable directory --
    // exactly the duplication spec §2.1 forbids -- even though the tool
    // itself never calls copyFileSync. Because analyzeVideo is mocked here
    // and never really runs normalize(), readdirSync(dir) alone cannot
    // observe this; only the options passed to analyzeVideo can prove the
    // fix is in place.
    const src = mkdtempSync(join(tmpdir(), 'norma-src-'));
    const local = join(src, 'clip.mp4');
    writeFileSync(local, 'not-real-video');
    analyzeMock.mockResolvedValue(manifest({
      source: { url: local, platform: 'local', title: 'T', duration: 10, resolvedBy: 'direct', status: 'ok', filePath: local },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    await analyzeVideoTool({ destinationPath: dir, videos: [{ pathOrUrl: local }] });
    const opts = analyzeMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.outDir).not.toBe(dir);
  });

  it('relocates frame thumbnails into destinationPath for a local source, without duplicating the video (spec §2.1)', async () => {
    // Frames are new artifacts analyzeVideo just generated (not a copy of
    // the source), so they belong in destinationPath regardless of where
    // the source came from -- the "not a duplicate of the video" rule
    // applies only to the video itself. Since outDir is deliberately kept
    // away from destinationPath for a local source (previous test), frames
    // land in analyzeVideo's own private working directory unless this
    // handler relocates them itself.
    const src = mkdtempSync(join(tmpdir(), 'norma-src-'));
    const local = join(src, 'clip.mp4');
    writeFileSync(local, 'not-real-video');
    const workDir = mkdtempSync(join(tmpdir(), 'norma-work-'));
    const framePath = join(workDir, 'f1.jpg');
    writeFileSync(framePath, 'not-real-jpeg');
    analyzeMock.mockResolvedValue(manifest({
      source: { url: local, platform: 'local', title: 'T', duration: 10, resolvedBy: 'direct', status: 'ok', filePath: local },
      frames: [{ timestamp: 1, sceneId: 0, image: framePath, importance: 0.5, reasons: [], ocrContent: null, transcriptWindow: null, nearestSelectedSimilarity: 0 }],
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [{ pathOrUrl: local }] });
    const expectedFrame = join(dir, 'f1.jpg');
    expect(r.videos[0]!.framePaths).toEqual([expectedFrame]);
    expect(existsSync(expectedFrame)).toBe(true);
    expect(existsSync(framePath)).toBe(false);
    const saved = JSON.parse(readFileSync(r.videos[0]!.manifestPath, 'utf8'));
    expect(saved.frames[0].image).toBe(expectedFrame);
  });

  it('cleans up analyzeVideo\'s orphaned working copy for a local source, without ever touching the caller\'s own file (Fix 6, deferred #18 leak half)', async () => {
    // frameMode 'key' means analyzeVideo's own manifest.source.filePath
    // points at its private, ephemeral re-encoded copy (work.mp4) -- a REAL
    // file here, standing in for what normalizeVideo() actually produces.
    // The rewrite above replaces source.filePath with args.pathOrUrl
    // (`local`), so nothing in the final reply/manifest references the
    // ephemeral copy any more once this call returns -- exactly the leak
    // deferred #18 describes ("every local analyze_video call leaves a full
    // re-encode... behind"). local !== ephemeralCopy is the load-bearing
    // part of this fixture: an implementation that deleted based on `local`
    // alone (not on whether the path actually changed) would ALSO destroy
    // the caller's own file whenever frameMode wasn't 'key' and filePath
    // already equalled pathOrUrl -- see the companion test below.
    const src = mkdtempSync(join(tmpdir(), 'norma-src-'));
    const local = join(src, 'clip.mp4');
    writeFileSync(local, 'the-callers-own-video-bytes');
    const workDir = mkdtempSync(join(tmpdir(), 'norma-work-'));
    const ephemeralCopy = join(workDir, 'work.mp4');
    writeFileSync(ephemeralCopy, 'analyzeVideos-own-reencoded-copy');
    analyzeMock.mockResolvedValue(manifest({
      source: { url: local, platform: 'local', title: 'T', duration: 10, resolvedBy: 'direct', status: 'ok', filePath: ephemeralCopy },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [{ pathOrUrl: local }] });
    expect(r.videos[0]!.status).toBe('ok');
    expect(r.videos[0]!.videoPath).toBe(local);
    expect(existsSync(local)).toBe(true);
    expect(existsSync(ephemeralCopy)).toBe(false);
  });

  it('does NOT delete the caller\'s own file when analyzeVideo already reports it verbatim as filePath (regression guard for the fix above)', async () => {
    // The companion/negative case: when analyzeVideo's own filePath ALREADY
    // equals pathOrUrl (the common case for 'even'/'none' frame modes, or
    // any local source resolve() passes straight through unchanged), the
    // cleanup must be a no-op -- deleting it here would destroy the file the
    // reply itself points at, reintroducing a Fix-1-shaped data-loss bug
    // through Fix 6 instead.
    const src = mkdtempSync(join(tmpdir(), 'norma-src-'));
    const local = join(src, 'clip.mp4');
    writeFileSync(local, 'the-callers-own-video-bytes');
    analyzeMock.mockResolvedValue(manifest({
      source: { url: local, platform: 'local', title: 'T', duration: 10, resolvedBy: 'direct', status: 'ok', filePath: local },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [{ pathOrUrl: local }] });
    expect(r.videos[0]!.status).toBe('ok');
    expect(r.videos[0]!.videoPath).toBe(local);
    expect(existsSync(local)).toBe(true);
  });
});

describe('batching (spec §3-§5)', () => {
  it('itemDir: flat at N=1, video-N subdirs at N>1', () => {
    expect(itemDir('/d', 0, 1)).toBe('/d');
    expect(itemDir('/d', 0, 3)).toBe(join('/d', 'video-1'));
    expect(itemDir('/d', 2, 3)).toBe(join('/d', 'video-3'));
  });

  it('N=2 writes each item into its own subdir -- manifests do not collide', async () => {
    // mock analyzeVideo to return ok manifests with distinct titles per URL
    analyzeMock.mockImplementation(async (url: string) => manifest({
      source: { url, platform: 'p', title: `T-${url}`, duration: 10, resolvedBy: 'ytdlp', status: 'ok', filePath: '/x/work.mp4' },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-batch-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [
      { pathOrUrl: 'https://x.test/a' }, { pathOrUrl: 'https://x.test/b' },
    ]});
    expect(r.videos).toHaveLength(2);
    expect(r.videos[0]!.manifestPath).toBe(join(dir, 'video-1', 'manifest.json'));
    expect(r.videos[1]!.manifestPath).toBe(join(dir, 'video-2', 'manifest.json'));
    expect(existsSync(r.videos[0]!.manifestPath)).toBe(true);
    expect(existsSync(r.videos[1]!.manifestPath)).toBe(true);
    const m1 = JSON.parse(readFileSync(r.videos[0]!.manifestPath, 'utf8'));
    const m2 = JSON.parse(readFileSync(r.videos[1]!.manifestPath, 'utf8'));
    expect(m1.source.url).not.toBe(m2.source.url);   // kills the shared-directory mutant
  });

  it('partial failure: item statuses are independent, the call resolves', async () => {
    // mock analyzeVideo: ok for /a, extractor_failed manifest for /b
    analyzeMock.mockImplementation(async (url: string) => (
      url.endsWith('/dead')
        ? manifest({
            source: { url, platform: 'unknown', title: '', duration: 0, resolvedBy: 'none', status: 'extractor_failed', reason: 'dead link' },
            transcript: null, frames: [],
          })
        : manifest({ source: { url, platform: 'p', title: 'T', duration: 10, resolvedBy: 'ytdlp', status: 'ok', filePath: '/x/work.mp4' } })
    ));
    const dir = mkdtempSync(join(tmpdir(), 'norma-batch-pf-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [
      { pathOrUrl: 'https://x.test/a' }, { pathOrUrl: 'https://x.test/dead' },
    ]});
    expect(r.videos[0]!.status).toBe('ok');
    expect(r.videos[1]!.status).toBe('extractor_failed');
    expect(r.videos[1]!.manifestPath).toBe(join(dir, 'video-2', 'manifest.json'));
  });

  it('hooks: run wraps each item, onStage/onQueued carry the item index', async () => {
    // analyzeMock must actually DRIVE onStage (via opts.onStage) for this test
    // to exercise anything -- an unconfigured mock resolves `undefined` and
    // analyzeOneVideoAttempt throws before onStage is ever reached, so a mock
    // that never touches onStage/onQueued cannot prove their index attribution
    // either way. Item 0 ('/a') is delayed so item 1 ('/b') completes first --
    // the discriminating condition: a correct per-iteration `i` binding
    // (analyzeVideoTool's `.map((item, i) => ...)`) reports the right index no
    // matter which item's async work finishes last, whereas a shared,
    // reassigned counter closed over by reference would -- by the time the
    // LATE item's callback finally fires -- already reflect the loop's final
    // value, reporting the SAME wrong index for whichever item is slowest,
    // regardless of firing order.
    analyzeMock.mockImplementation(async (url: string, opts: { onStage?: (s: string) => void }) => {
      if (url.endsWith('/a')) await new Promise((res) => setTimeout(res, 20));
      opts?.onStage?.('resolving');
      return manifest({ source: { url, platform: 'p', title: 'T', duration: 10, resolvedBy: 'ytdlp', status: 'ok', filePath: '/x/work.mp4' } });
    });
    const dir = mkdtempSync(join(tmpdir(), 'norma-batch-hooks-'));
    const ran: number[] = []; const staged: Array<[number, string]> = []; const queued: Array<[number, number]> = [];
    let live = 0, peak = 0, aheadCounter = 0;
    await analyzeVideoTool(
      { destinationPath: dir, videos: [{ pathOrUrl: 'https://x.test/a' }, { pathOrUrl: 'https://x.test/b' }] },
      {
        run: async (fn, onQueued) => {
          live++; peak = Math.max(peak, live); ran.push(live);
          onQueued(aheadCounter++);                      // distinct value per item, forwarded via hooks.onQueued below
          const r = await fn(); live--; return r;
        },
        onStage: (i, s) => staged.push([i, s]),
        onQueued: (i, ahead) => queued.push([i, ahead]),
        onItemStart: (i) => staged.push([i, 'start']),
      },
    );
    expect(ran).toHaveLength(2);                       // every item went through run
    expect(peak).toBe(2);                              // both items were genuinely in flight together, not serialized
    expect(staged.filter(([, s]) => s === 'start').map(([i]) => i).sort()).toEqual([0, 1]);
    // Positional, not sorted-then-compared: a closure that captured the wrong
    // (shared, stale) index would still often produce the right SET for the
    // synchronous onItemStart entries above, but onStage fires from inside the
    // (here, deliberately delayed-for-item-0) mocked analyzeVideo call -- late
    // enough that a shared-counter bug reports the loop's final value instead
    // of the item's own index. Item 1 finishes first (no delay), item 0
    // finishes last (20ms delay); both must still show their OWN index.
    expect(staged).toContainEqual([0, 'resolving']);
    expect(staged).toContainEqual([1, 'resolving']);
    // onQueued's ahead value is assigned by call order (item 0's run() call
    // happens before item 1's, synchronously, per Promise.all(map(...))) --
    // 0 for item 0, 1 for item 1 -- so correct attribution means exactly the
    // pairs below, not e.g. both landing on the same (stale) index.
    expect(queued).toContainEqual([0, 0]);
    expect(queued).toContainEqual([1, 1]);
  });

  it('onItemDone fires per item as ITS OWN promise settles, not after the whole batch (final review, Important 2)', async () => {
    // Final whole-branch review, Important finding 2: src/mcp.ts drives
    // statusRegistry.finish() off this hook so a fast item reads as done
    // the instant it actually finishes, not 18s later when its slowest
    // sibling does. Item 0 ('/slow') is delayed well past item 1 ('/fast').
    // A CORRECT implementation (onItemDone attached to each item's OWN
    // promise, inside Promise.all's own map) fires index 1 first, in real
    // settlement order. The bug this hook exists to fix -- driving a
    // per-item "done" signal off a forEach over Promise.all's own resolved
    // array -- can only ever fire in ARRAY order (index 0, then 1),
    // regardless of which item actually finished first: that wrong-order
    // signature is exactly what this test's ordering assertion below
    // catches, without needing a separate real-time witness.
    analyzeMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/slow')) await new Promise((res) => setTimeout(res, 30));
      return manifest({ source: { url, platform: 'p', title: 'T', duration: 10, resolvedBy: 'ytdlp', status: 'ok', filePath: '/x/work.mp4' } });
    });
    const dir = mkdtempSync(join(tmpdir(), 'norma-batch-itemdone-'));
    const done: Array<[number, string]> = [];

    await analyzeVideoTool(
      { destinationPath: dir, videos: [{ pathOrUrl: 'https://x.test/slow' }, { pathOrUrl: 'https://x.test/fast' }] },
      { onItemDone: (i, status) => done.push([i, status]) },
    );

    expect(done).toEqual([[1, 'ok'], [0, 'ok']]);
  });

  it('a hooks.onStage that throws on "resolving" does not turn an otherwise-fine analyze call into extractor_failed (Task 4 mandate A)', async () => {
    // analyzeOneVideo's own onStage parameter -- the bridge lambda at
    // analyzeTool.ts's analyzeVideoTool, `safe((s) => hooks?.onStage?.(i, s))`
    // -- is a SEPARATE threading path from the runWithStatus() context used
    // just above it (already safe() by construction since Task 2). Before
    // Task 4, that lambda was bare: `(s) => hooks?.onStage?.(i, s)`, calling
    // a caller-supplied hook directly with no guard. The real src/analyze.ts
    // calls `opts.onStage?.('resolving')` as the FIRST statement of its own
    // try block with no local try/catch of its own -- a throw there is
    // absorbed by analyze.ts's OWN catch into a normal-looking, non-rejecting
    // Manifest with status:'extractor_failed', silently turning a
    // legitimate analysis into a reported failure (Task 2's review found and
    // routed this exact class here). This mock reproduces that same call
    // shape (`opts.onStage?.('resolving')`, unguarded) directly, so a
    // pre-fix bare lambda would let the mock's own promise reject here and
    // land in analyzeOneVideo's outer catch instead -- a different absorber
    // than the real analyze.ts, but the SAME observable bug this test pins:
    // status flips to extractor_failed instead of staying ok.
    analyzeMock.mockImplementation(async (url: string, opts: { onStage?: (s: string) => void }) => {
      opts?.onStage?.('resolving');
      return manifest({ source: { url, platform: 'p', title: 'T', duration: 10, resolvedBy: 'ytdlp', status: 'ok', filePath: '/x/work.mp4' } });
    });
    const dir = mkdtempSync(join(tmpdir(), 'norma-throwing-onstage-'));
    const r = await analyzeVideoTool(
      { destinationPath: dir, videos: [{ pathOrUrl: 'https://x.test/a' }] },
      { onStage: (_i, s) => { if (s === 'resolving') throw new Error('reporting must never break work'); } },
    );
    expect(r.videos[0]!.status).toBe('ok');
  });

  it('N=2: one item genuinely rejects (not a failure status) and the sibling still lands ok -- per-item no-throw guarantee holds at N=2', async () => {
    // Distinct from the 'partial failure' test above, which mocks analyzeVideo
    // resolving to a status-carrying failure manifest. Here analyzeVideo itself
    // REJECTS for one item -- proving analyzeOneVideo's own try/catch boundary
    // (already proven at N=1 by "returns a structured failure instead of
    // throwing when analyzeVideo itself rejects unexpectedly" above) isolates
    // each item independently inside Promise.all, rather than one item's
    // rejection taking down the whole batch call.
    analyzeMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/boom')) throw new Error('pipeline exploded');
      return manifest({ source: { url, platform: 'p', title: 'T', duration: 10, resolvedBy: 'ytdlp', status: 'ok', filePath: '/x/work.mp4' } });
    });
    const dir = mkdtempSync(join(tmpdir(), 'norma-batch-throw-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [
      { pathOrUrl: 'https://x.test/ok' }, { pathOrUrl: 'https://x.test/boom' },
    ]});
    expect(r.videos[0]!.status).toBe('ok');
    expect(r.videos[1]!.status).not.toBe('ok');
    expect(r.videos[1]!.reason).toContain('pipeline exploded');
    expect(r.videos[1]!.manifestPath).toBe(join(dir, 'video-2', 'manifest.json'));
  });
});
