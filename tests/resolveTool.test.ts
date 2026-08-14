import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { makeTestVideo, probe } from '../src/media/ffmpeg.js';

const resolveMock = vi.fn();
vi.mock('../src/resolve/index.js', () => ({ resolve: (...a: unknown[]) => resolveMock(...a) }));
const { resolveVideoTool } = await import('../src/agent/resolveTool.js');
afterEach(() => resolveMock.mockReset());

/**
 * resolveVideoTool gates the video move on existsSync(r.filePath) -- a
 * defensive check (resolve()'s own contract promises a real file whenever
 * status is 'ok', mirroring the existsSync guards analyze.ts already uses
 * around res.captions.*.path). A fixture pointing at a nonexistent path
 * (e.g. a bare '/x/source.mp4' literal) silently short-circuits that guard:
 * videoPath, note and the clip filename all end up computed against a file
 * that was never there, so any test relying on them passes for the wrong
 * reason -- it cannot tell a correct implementation from a broken one.
 * Verified empirically: the brief's own literal reference implementation,
 * run against its own literal fixture, fails "warns that a clipped file
 * starts at zero" (r.note is undefined) for exactly this reason -- see
 * task-6-report.md. A real file avoids the trap.
 */
function realSourceFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'norma-src-'));
  const p = join(dir, 'source.mp4');
  writeFileSync(p, 'fake-video-bytes');
  return p;
}

/**
 * A genuinely decodable video, unlike realSourceFile() above (which only
 * needs to EXIST for the existsSync gate). The one test that trims for
 * real needs ffmpeg to actually be able to decode the input, or trim()
 * fails for the wrong reason and the test would prove nothing.
 */
async function realTestVideo(seconds = 6): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'norma-vid-'));
  return makeTestVideo(join(dir, 'source.mp4'), seconds);
}

const ok = (over: Record<string, unknown> = {}) => ({
  status: 'ok', filePath: realSourceFile(), platform: 'youtube', title: 'T',
  duration: 100, resolvedBy: 'ytdlp', captions: { manual: null, auto: null },
  languageHint: null, rangeApplied: false,
  metadata: {
    title: 'T', creator: 'C', duration: 100,
    chapters: [{ start: 0, end: 12, title: 'Intro' }],
    description: 'z'.repeat(400), uploadDate: null, viewCount: 9, commentCount: 3,
  },
  ...over,
});

describe('resolveVideoTool', () => {
  it('does not fetch media by default (spec §2.1)', async () => {
    // Mutation 1: media fetched by default rather than only on request.
    // Kills any implementation that hardcodes returnVideo:true downstream,
    // or that defaults args.returnVideo to true.
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v' }] });
    expect(resolveMock.mock.calls[0]![1]).toMatchObject({ returnVideo: false });
    expect(r.videos[0]!.videoPath).toBeUndefined();
  });

  it('copies rather than moves when the source is the caller\'s own file, not a working-directory temp (Fix 1: data-loss regression)', async () => {
    // resolve()'s bare-local-path branch (src/resolve/index.ts:29-37) returns
    // the CALLER's own path verbatim as r.filePath -- not a workDir temp.
    // realSourceFile() builds its source in its OWN mkdtemp, structurally
    // outside both resolveVideoTool's workDir and destinationPath -- exactly
    // the arrangement the pre-fix suite lacked (every prior fixture's source
    // happened to be safely renameable, so a naive renameSync never visibly
    // broke anything). No start/end here: this must reproduce with the
    // plainest possible returnVideo:true call, which is exactly what the
    // brief's own repro used.
    const source = realSourceFile();
    const before = readFileSync(source);
    resolveMock.mockResolvedValue(ok({ filePath: source, platform: 'local', resolvedBy: 'direct' }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: source, returnVideo: true }] });
    expect(r.videos[0]!.status).toBe('ok');
    expect(r.videos[0]!.videoPath).toBeDefined();
    expect(existsSync(r.videos[0]!.videoPath!)).toBe(true);
    // The regression: the source must survive at its own path, untouched --
    // not just "some file exists there", but the SAME bytes, non-empty.
    expect(existsSync(source)).toBe(true);
    expect(statSync(source).size).toBeGreaterThan(0);
    expect(readFileSync(source)).toEqual(before);
  });

  it('tells the agent both ways forward when it withheld the media', async () => {
    // Mutation 2 (direction A): nextSteps missing when the media WAS withheld.
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v' }] });
    expect(r.videos[0]!.nextSteps).toMatch(/returnVideo/);
    expect(r.videos[0]!.nextSteps).toMatch(/analyze_video/);
  });

  it('omits next-steps guidance once the media has been fetched', async () => {
    // Mutation 2 (direction B): nextSteps appearing even though the media WAS fetched.
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v', returnVideo: true }] });
    expect(r.videos[0]!.nextSteps).toBeUndefined();
  });

  it('surfaces title, creator, duration and chapters inline', async () => {
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v' }] });
    expect(r.videos[0]!.title).toBe('T');
    expect(r.videos[0]!.creator).toBe('C');
    expect(r.videos[0]!.duration).toBe(100);
    expect(r.videos[0]!.chapters).toEqual([{ start: 0, end: 12, title: 'Intro' }]);
  });

  it('sends only a preview inline and the full description to the file', async () => {
    // Mutation 3: the full description leaking into the inline reply.
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v' }] });
    expect(r.videos[0]!.descriptionPreview!.length).toBeLessThanOrEqual(126);
    const saved = JSON.parse(readFileSync(r.videos[0]!.metadataPath, 'utf8'));
    expect(saved.description).toHaveLength(400);
  });

  it('never returns comments inline, only their count (spec §2.1)', async () => {
    // Mutation 4: comments appearing inline rather than only in the metadata
    // file. Strengthened beyond the brief's version: the brief's own `ok()`
    // fixture never populates metadata.comments, so JSON.stringify(r) could
    // never contain "comments" either way -- even a mutant that spreads
    // `comments: r.metadata?.comments` inline would stringify to nothing
    // (JSON.stringify drops undefined-valued keys), so that version of the
    // test cannot discriminate. Giving the fixture REAL comment content
    // closes that gap in both directions: absent inline, present in the file.
    const richComments = [
      { id: '1', text: 'nice video, thanks!' },
      { id: '2', text: 'great content, subscribed' },
    ];
    resolveMock.mockResolvedValue(ok({
      metadata: {
        title: 'T', creator: 'C', duration: 100,
        chapters: [{ start: 0, end: 12, title: 'Intro' }],
        description: 'z'.repeat(400), uploadDate: null, viewCount: 9, commentCount: 3,
        comments: richComments,
      },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v', comments: true }] });
    expect(r.videos[0]!.commentCount).toBe(3);
    expect(JSON.stringify(r.videos[0])).not.toContain('nice video');
    expect(JSON.stringify(r.videos[0])).not.toContain('"comments"');
    const saved = JSON.parse(readFileSync(r.videos[0]!.metadataPath, 'utf8'));
    expect(saved.comments).toEqual(richComments);
  });

  it('warns that a clipped file starts at zero (spec §5.1)', async () => {
    // Mutation 5 (direction A): the note missing when a range WAS applied.
    // Also confirms the video is actually saved under the range-encoded
    // filename (spec §7), not just that a truthy string exists.
    // rangeApplied:true is required alongside clipStart/clipEnd: the real
    // resolver contract only ever populates the latter when the former is
    // true (Task 4's fix), and since the Finding-1 local-trim fallback
    // below now genuinely inspects rangeApplied, an inconsistent fixture
    // (clipStart/clipEnd set, rangeApplied left false) would wrongly
    // trigger a real trim attempt against this fixture's non-decodable
    // stand-in file.
    resolveMock.mockResolvedValue(ok({ rangeApplied: true, clipStart: 724, clipEnd: 1200 }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({
      destinationPath: dir, videos: [{ url: 'https://x/v', returnVideo: true, start: 724, end: 1200 }],
    });
    expect(r.videos[0]!.note).toMatch(/starts at 0|begins at zero/i);
    expect(r.videos[0]!.note).toContain('724');
    expect(r.videos[0]!.videoPath).toBeDefined();
    expect(existsSync(r.videos[0]!.videoPath!)).toBe(true);
    expect(basename(r.videos[0]!.videoPath!)).toBe('source_s724_e1200.mp4');
  });

  it('keys the clip fields, filename and note off the range genuinely applied, never the range requested (spec §5.1)', async () => {
    // Mutation 5 (both forms) -- the one the brief's own test 7 cannot
    // catch, since its args and r.clipStart happen to agree. This uses the
    // realistic source of disagreement design §18 documents: yt-dlp cuts
    // snap to keyframes, so the range actually applied (700-1150) can
    // differ slightly from the range requested (724-1200). rangeApplied is
    // true here, so the Finding-1 local-trim fallback correctly does NOT
    // fire (nothing further needs trimming) -- this isolates the
    // note/clip-field/filename gating logic specifically.
    // Two independent things must both key off r.clipStart/r.clipEnd, not
    // args.start/args.end: the note's content, AND mediaFileName's
    // arguments (an implementation that names the file via args.start/
    // args.end would produce "source_s724_e1200.mp4" for a file that was
    // actually saved as 700-1150 -- precisely the §7 collision the design
    // calls out, since a later request for the true 700-1150 clip would
    // then collide with this wrongly-named one).
    resolveMock.mockResolvedValue(ok({ rangeApplied: true, clipStart: 700, clipEnd: 1150 }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({
      destinationPath: dir, videos: [{ url: 'https://x/v', returnVideo: true, start: 724, end: 1200 }],
    });
    expect(r.videos[0]!.clipStart).toBe(700);
    expect(r.videos[0]!.clipEnd).toBe(1150);
    expect(r.videos[0]!.note).toContain('700');
    expect(r.videos[0]!.note).not.toContain('724');
    expect(r.videos[0]!.videoPath).toBeDefined();
    expect(basename(r.videos[0]!.videoPath!)).toBe('source_s700_e1150.mp4');
  });

  it('reports the clip duration, not the original video duration, when a range was applied (Fix 5, clipped shape)', async () => {
    // Pre-fix, duration always came from `r.metadata?.duration ?? r.duration`
    // -- the ORIGINAL video's duration -- even once a clip was genuinely
    // produced. ok()'s fixture has metadata.duration:100 and top-level
    // duration:100 (a 100s source); requesting start:1,end:4 with the range
    // genuinely applied must report duration:3 (4-1), matching the saved
    // file's real length and the reply's own "starts at 0" note -- not 100,
    // which would contradict both.
    resolveMock.mockResolvedValue(ok({ rangeApplied: true, clipStart: 1, clipEnd: 4 }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({
      destinationPath: dir, videos: [{ url: 'https://x/v', returnVideo: true, start: 1, end: 4 }],
    });
    expect(r.videos[0]!.status).toBe('ok');
    expect(r.videos[0]!.clipStart).toBe(1);
    expect(r.videos[0]!.clipEnd).toBe(4);
    expect(r.videos[0]!.duration).toBe(3);
  });

  it('still reports the original video duration when returnVideo is true but no range was requested (Fix 5, unclipped shape)', async () => {
    // The companion shape: an unclipped fetch must be unaffected by Fix 5 --
    // clipDuration stays undefined (clipped is false with no start/end), so
    // duration falls through to the original video's duration exactly as
    // before.
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v', returnVideo: true }] });
    expect(r.videos[0]!.clipStart).toBeUndefined();
    expect(r.videos[0]!.duration).toBe(100);
  });

  it('omits the clip-offset note and clip fields when returnVideo is false, even if a range is requested', async () => {
    // Complementary "not applied" case: Finding 1's local-trim fallback is
    // itself gated on returnVideo (there is no media to trim when none was
    // fetched), so with returnVideo left false the result must still look
    // exactly like an ordinary metadata-only reply -- no note, no clip
    // fields, no videoPath -- even though start/end were supplied.
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({
      destinationPath: dir, videos: [{ url: 'https://x/v', start: 724, end: 1200 }],
    });
    expect(r.videos[0]!.note).toBeUndefined();
    expect(r.videos[0]!.clipStart).toBeUndefined();
    expect(r.videos[0]!.clipEnd).toBeUndefined();
    expect(r.videos[0]!.videoPath).toBeUndefined();
  });

  it('returns a failure shape without throwing', async () => {
    // Mutation 6: a failure status throwing instead of returning a
    // structured result. Also checks nextSteps stays absent on failure --
    // telling the agent to retry with returnVideo:true after a DRM failure
    // would be actively misleading.
    resolveMock.mockResolvedValue({ status: 'unsupported', reason: 'drm_protected', message: 'DRM-protected media' });
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v' }] });
    expect(r.videos[0]!.status).toBe('unsupported');
    expect(r.videos[0]!.videoPath).toBeUndefined();
    expect(r.videos[0]!.nextSteps).toBeUndefined();
  });

  it('surfaces the categorical failure reason and records the url alongside it', async () => {
    // Documents a deliberate, small deviation from the brief's reference
    // (which set ResolveToolResult.reason to r.message, discarding r.reason
    // entirely): fold r.reason first, matching the precedent already set at
    // analyze.ts:86 (`typeof res.reason === 'string' ? res.reason : res.message`),
    // and include the url in the failure metadata file since ResolveFailure
    // itself carries no url to correlate the failure record back to it.
    resolveMock.mockResolvedValue({ status: 'unsupported', reason: 'drm_protected', message: 'DRM-protected media' });
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v' }] });
    expect(r.videos[0]!.reason).toBe('drm_protected');
    const saved = JSON.parse(readFileSync(r.videos[0]!.metadataPath, 'utf8'));
    expect(saved.url).toBe('https://x/v');
  });

  it('writes metadata even on the metadata-only path', async () => {
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v' }] });
    expect(existsSync(r.videos[0]!.metadataPath)).toBe(true);
  });

  it('forwards start/end to resolve() only when fetching, never on a metadata-only call', async () => {
    // Minor gap: forwarding was correct but untested -- a mutant that
    // forwards args.start/args.end unconditionally (dropping the
    // `returnVideo ? args.start : undefined` ternary) survived all 11
    // prior tests, since none of them inspected the resolve() call args on
    // a metadata-only request.
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v', start: 30, end: 60 }] });
    expect(resolveMock.mock.calls[0]![1].start).toBeUndefined();
    expect(resolveMock.mock.calls[0]![1].end).toBeUndefined();
  });

  it('trims locally when the resolver could not apply the range itself (spec §5, direct/WeChat sources)', async () => {
    // src/resolve/direct.ts and src/resolve/wechat.ts never read
    // opts.start/opts.end at all and always leave rangeApplied false --
    // verified directly by reading both files. A mocked 'direct' result
    // with no clipStart/clipEnd, rangeApplied:false, stands in for that
    // real shape; a genuinely decodable source file lets this test prove a
    // REAL trim happened, not just that the naming/note logic ran.
    const video = await realTestVideo(6);
    resolveMock.mockResolvedValue(ok({
      filePath: video, platform: 'direct', resolvedBy: 'direct', rangeApplied: false,
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({
      destinationPath: dir, videos: [{ url: 'https://x/direct.mp4', returnVideo: true, start: 1, end: 3 }],
    });
    expect(r.videos[0]!.status).toBe('ok');
    expect(r.videos[0]!.videoPath).toBeDefined();
    expect(basename(r.videos[0]!.videoPath!)).toBe('source_s1_e3.mp4');
    expect(r.videos[0]!.clipStart).toBe(1);
    expect(r.videos[0]!.clipEnd).toBe(3);
    expect(r.videos[0]!.note).toMatch(/starts at 0|begins at zero/i);
    expect(r.videos[0]!.note).toContain('1');
    // Not just correctly named -- genuinely shorter: proves ffmpeg actually
    // trimmed the file rather than the full 6s file being renamed under a
    // clip-shaped name.
    const trimmed = await probe(r.videos[0]!.videoPath!);
    expect(trimmed.duration).toBeLessThan(4);
    const saved = JSON.parse(readFileSync(r.videos[0]!.metadataPath, 'utf8'));
    expect(saved.clipStart).toBe(1);
    expect(saved.clipEnd).toBe(3);
    // Fix 5, the OTHER clipped sub-case (local trim rather than a
    // resolver-native range): the fixture's metadata.duration is 100 (the
    // ok() default), so this also proves the reply's duration comes from
    // the applied range (3-1=2), not the original video's duration.
    expect(r.videos[0]!.duration).toBe(2);
  });

  it('surfaces a local trim failure as a structured failure instead of throwing', async () => {
    // realSourceFile()'s bytes are not a decodable video, so ffmpeg's
    // trim() genuinely fails here (not simulated) -- proving the
    // deliberately-uncaught trim() call in the implementation really does
    // reach resolveVideoTool's outer exception boundary rather than
    // crashing the whole call.
    resolveMock.mockResolvedValue(ok({ platform: 'direct', resolvedBy: 'direct', rangeApplied: false }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({
      destinationPath: dir, videos: [{ url: 'https://x/direct.mp4', returnVideo: true, start: 1, end: 3 }],
    });
    expect(r.videos[0]!.status).not.toBe('ok');
    expect(r.videos[0]!.videoPath).toBeUndefined();
  });

  it('returns a structured failure instead of throwing when destinationPath exists as a file (EEXIST)', async () => {
    // Reproduced by the reviewer: an ordinary caller mistake (confusing a
    // file path with a directory path, or reusing a stale one) throws
    // EEXIST from mkdirSync before resolve() is ever called -- previously
    // an uncaught rejection, breaking the "returns a result, never throws"
    // contract every other failure path in this module honours.
    resolveMock.mockResolvedValue(ok());
    const parent = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const notADir = join(parent, 'blocked');
    writeFileSync(notADir, 'i am a file, not a directory');
    const r = await resolveVideoTool({ destinationPath: notADir, videos: [{ url: 'https://x/v' }] });
    expect(r.videos[0]!.status).not.toBe('ok');
    expect(typeof r.videos[0]!.metadataPath).toBe('string');
    expect(r.videos[0]!.videoPath).toBeUndefined();
  });

  it('omits duration when the resolver has no metadata layer and no media was fetched (design: absent, not zero)', async () => {
    // direct.ts/wechat.ts return duration:0 as a required-by-type
    // placeholder when they skip the transfer -- resolveTool.ts must not
    // let that reach the agent looking like a real zero-length video.
    resolveMock.mockResolvedValue(ok({ metadata: undefined, duration: 0 }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v' }] });
    expect(r.videos[0]!.duration).toBeUndefined();
    expect(JSON.stringify(r.videos[0])).not.toContain('"duration"');
  });

  it('still surfaces duration when the resolver metadata provides it, even though media was not fetched', async () => {
    // yt-dlp's metadata-only path DOES have a real duration (from the info
    // dict) -- this must not be swept up by the same guard.
    resolveMock.mockResolvedValue(ok()); // default metadata.duration: 100
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v' }] });
    expect(r.videos[0]!.duration).toBe(100);
  });

  it('still surfaces duration from a real probe when media WAS fetched, even with no metadata layer', async () => {
    // direct.ts/wechat.ts with returnVideo:true: no r.metadata, but
    // r.duration IS a genuine probed value this time and must come through.
    resolveMock.mockResolvedValue(ok({ metadata: undefined, duration: 42 }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v', returnVideo: true }] });
    expect(r.videos[0]!.duration).toBe(42);
  });

  it('omits duration when yt-dlp metadata itself has no duration -- a live stream or premiere (Fix B)', async () => {
    // Distinct from "omits duration when the resolver has no metadata layer"
    // above: here r.metadata IS present (a genuine yt-dlp source), but its
    // OWN duration is null -- exactly what toVideoMetadata now reports when
    // meta.duration itself is absent (src/resolve/ytdlp.ts). The pre-fix
    // guard (`r.metadata?.duration !== undefined`) is TRUE for null, so it
    // would have let this through, and the `?? r.duration` fallback below
    // would then have coalesced the null right back into resolve()'s own
    // required-by-type duration placeholder (0 in this fixture) --
    // laundering "unknown" into a fake zero. Assert ABSENCE, not falsiness:
    // toBe(0) and toBeFalsy() both pass against the unfixed code.
    resolveMock.mockResolvedValue(ok({
      metadata: {
        title: 'T', creator: 'C', duration: null,
        chapters: [], description: null, uploadDate: null, viewCount: null, commentCount: null,
      },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v' }] });
    expect('duration' in r.videos[0]!).toBe(false);
  });

  it('falls through a null metadata.duration to the real probed duration when returnVideo is true (Fix B)', async () => {
    // The OTHER side of the `r.metadata?.duration ?? r.duration` fallback:
    // durationKnown is true here via the returnVideo arm (not the metadata
    // arm, since metadata.duration is null), so null must not survive
    // through `??` and mask the real probed value that DID come back.
    resolveMock.mockResolvedValue(ok({
      metadata: {
        title: 'T', creator: 'C', duration: null,
        chapters: [], description: null, uploadDate: null, viewCount: null, commentCount: null,
      },
      duration: 42,
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/v', returnVideo: true }] });
    expect(r.videos[0]!.duration).toBe(42);
  });

  it('surfaces a locally-probed duration on a metadata-only call for a local source, even though there is no metadata layer (Fix 7)', async () => {
    // resolve()'s bare-local-path branch (src/resolve/index.ts:29-37) probes
    // the file UNCONDITIONALLY, even when returnVideo is left false -- unlike
    // direct.ts/wechat.ts, which only probe when a real transfer happens.
    // r.duration is a genuine measurement here, not a required-by-type
    // placeholder, and the pre-fix guard discarded it because neither
    // r.metadata nor returnVideo was true.
    resolveMock.mockResolvedValue(ok({
      platform: 'local', resolvedBy: 'direct', metadata: undefined, duration: 6,
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: '/some/local/video.mp4' }] });
    expect(r.videos[0]!.duration).toBe(6);
  });

  it('omits duration for a local file ffprobe could not measure, rather than reporting 0 as a fact', async () => {
    // ffprobe reads some containers (raw .h264 and other bare bitstreams)
    // without reporting a format duration, and resolve()'s local branch then
    // leaves r.duration at its required-by-type 0. Trusting r.platform ===
    // 'local' on its own republished that 0 as a measurement -- reinstating,
    // for local files, the exact laundering Fix B removed for yt-dlp.
    // Assert ABSENCE, not falsiness: toBe(0) and toBeFalsy() both pass
    // against the unfixed guard.
    resolveMock.mockResolvedValue(ok({
      platform: 'local', resolvedBy: 'direct', metadata: undefined, duration: 0,
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: '/some/bare/stream.h264' }] });
    expect(r.videos[0]!.status).toBe('ok');
    expect('duration' in r.videos[0]!).toBe(false);
  });

  it('still omits duration for a real direct-URL source on a metadata-only call (Fix 7 stays scoped to local only)', async () => {
    // The explicit non-goal from the brief: direct.ts/wechat.ts have no
    // cheap metadata layer at all, and omitting duration rather than
    // inventing one is the honest, deliberate behaviour there -- only
    // r.platform === 'local' (resolve()'s bare-local-path branch, set
    // nowhere else) should ever widen durationKnown. A mutant that widened
    // the guard beyond that one platform would incorrectly let this through.
    resolveMock.mockResolvedValue(ok({
      platform: 'direct', resolvedBy: 'direct', metadata: undefined, duration: 0,
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [{ url: 'https://x/direct.mp4' }] });
    expect(r.videos[0]!.duration).toBeUndefined();
    expect(JSON.stringify(r.videos[0])).not.toContain('"duration"');
  });
});

describe('batching (spec §3-§5)', () => {
  it('N=2 writes each item into its own subdir -- metadata files do not collide', async () => {
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-batch-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [
      { url: 'https://x.test/a' }, { url: 'https://x.test/b' },
    ]});
    expect(r.videos).toHaveLength(2);
    expect(r.videos[0]!.metadataPath).toBe(join(dir, 'video-1', 'metadata.json'));
    expect(r.videos[1]!.metadataPath).toBe(join(dir, 'video-2', 'metadata.json'));
    expect(existsSync(r.videos[0]!.metadataPath)).toBe(true);
    expect(existsSync(r.videos[1]!.metadataPath)).toBe(true);
  });

  it('partial failure: item statuses are independent, the call resolves', async () => {
    // mock resolve(): ok for /a, not_found for /dead
    resolveMock.mockImplementation(async (url: string) => (
      url.endsWith('/dead') ? { status: 'not_found', message: 'no such video' } : ok()
    ));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-batch-pf-'));
    const r = await resolveVideoTool({ destinationPath: dir, videos: [
      { url: 'https://x.test/a' }, { url: 'https://x.test/dead' },
    ]});
    expect(r.videos[0]!.status).toBe('ok');
    expect(r.videos[1]!.status).toBe('not_found');
    expect(r.videos[1]!.metadataPath).toBe(join(dir, 'video-2', 'metadata.json'));
  });

  it('onItemDone fires per item as ITS OWN promise settles, not after the whole batch (final review, Important 2)', async () => {
    // Same mandate and discriminating shape as analyzeVideoTool's own
    // pinning test (tests/analyzeTool.test.ts): item 0 ('/slow') is
    // delayed well past item 1 ('/fast'). A correct implementation (hook
    // attached to each item's OWN promise, inside Promise.all's map) fires
    // index 1 first, in real settlement order; a Promise.all-gated bug can
    // only ever fire in array order (0 then 1) regardless of which item
    // actually finished first.
    resolveMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/slow')) await new Promise((res) => setTimeout(res, 30));
      return ok();
    });
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-itemdone-'));
    const done: Array<[number, string]> = [];

    await resolveVideoTool(
      { destinationPath: dir, videos: [{ url: 'https://x.test/slow' }, { url: 'https://x.test/fast' }] },
      { onItemDone: (i, status) => done.push([i, status]) },
    );

    expect(done).toEqual([[1, 'ok'], [0, 'ok']]);
  });
});
