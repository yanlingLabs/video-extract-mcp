import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyYtDlpError, pickResolver } from '../src/resolve/index.js';
import { DirectMediaResolver } from '../src/resolve/direct.js';
import { YtDlpResolver } from '../src/resolve/ytdlp.js';
import {
  WeChatHeadlessResolver, parseShareLink, classifyBusinessError, businessFailure,
} from '../src/resolve/wechat.js';
import { makeTestVideo, probe } from '../src/media/ffmpeg.js';
import { run } from '../src/util/run.js';
import { fetchToFile } from '../src/util/download.js';

// Passthrough by default (vi.fn wrapping the real implementation) so every
// other suite in this file -- and makeTestVideo's own ffmpeg calls -- keep
// running real subprocesses; the yt-dlp caption suite overrides it per-test
// to fake ONLY the yt-dlp binary.
vi.mock('../src/util/run.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/util/run.js')>();
  return { ...real, run: vi.fn(real.run) };
});
const realRun = (await vi.importActual<typeof import('../src/util/run.js')>('../src/util/run.js')).run;

// Same passthrough convention as run.js above, for the metadata-only
// (returnVideo:false) no-transfer tests: DirectMediaResolver and
// WeChatHeadlessResolver both call fetchToFile for the actual media bytes.
vi.mock('../src/util/download.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/util/download.js')>();
  return { ...real, fetchToFile: vi.fn(real.fetchToFile) };
});
const realFetchToFile = (await vi.importActual<typeof import('../src/util/download.js')>('../src/util/download.js')).fetchToFile;

describe('classifyYtDlpError', () => {
  it('maps DRM messages to unsupported/drm_protected', () => {
    const f = classifyYtDlpError('ERROR: This video is DRM protected');
    expect(f.status).toBe('unsupported');
    expect(f.reason).toBe('drm_protected');
  });
  it('maps login walls to auth_required', () => {
    expect(classifyYtDlpError('ERROR: Sign in to confirm your age').status).toBe('auth_required');
    expect(classifyYtDlpError('ERROR: Private video. Please sign in').status).toBe('auth_required');
  });
  it('maps removed videos to not_found', () => {
    expect(classifyYtDlpError('ERROR: Video unavailable').status).toBe('not_found');
  });
  it('maps unsupported-URL/no-extractor messages to unsupported/extractor_unsupported', () => {
    // Distinct branch from the DRM case: a mapping that collapsed every non-auth/not_found
    // error into a single status (e.g. always extractor_failed) would fail this.
    const f = classifyYtDlpError('ERROR: Unsupported URL: https://example.com/weird');
    expect(f.status).toBe('unsupported');
    expect(f.reason).toBe('extractor_unsupported');
  });
  it('defaults to extractor_failed', () => {
    expect(classifyYtDlpError('ERROR: some new breakage').status).toBe('extractor_failed');
  });

  it('keeps the message readable when --verbose fills stderr with debug noise', () => {
    // --verbose is added for ranged downloads so ffmpeg's errors are visible;
    // without filtering, its Python traceback fills the reported tail and
    // buries the actual failure.
    const stderr = [
      'ERROR: something went genuinely wrong',
      ...Array.from({ length: 40 }, (_, i) => `[debug] noise line ${i} ${'x'.repeat(40)}`),
      '  File "/opt/homebrew/.../YoutubeDL.py", line 1166, in report_error',
      '    self.trouble(message)',
    ].join('\n');
    expect(classifyYtDlpError(stderr).message).toContain('something went genuinely wrong');
  });

  // Every stderr below is a REAL string this tool produced against YouTube,
  // not an invented one -- the whole point of this group is that the previous
  // classification handed an agent "ffmpeg exited with code 8" and expected it
  // to know what to do.
  describe('a platform that refuses the media transfer', () => {
    it('reports rate_limited, not extractor_failed, for a plain 403', () => {
      // Observed verbatim from resolve_video with returnVideo: true.
      const f = classifyYtDlpError('ERROR: unable to download video data: HTTP Error 403: Forbidden');
      expect(f.status).toBe('rate_limited');
      // The status is the machine-readable half; the message must carry the
      // one fact that makes it actionable.
      expect(f.message).toMatch(/temporar/i);
      expect(f.message).toMatch(/retry/i);
    });

    it('finds the 403 even when ffmpeg\'s exit code is all that reaches the tail', () => {
      // The ranged case, and the reason this matches the WHOLE stderr rather
      // than the last 300 characters it reports as its message: with
      // --download-sections the fetch is ffmpeg's, so yt-dlp's closing line is
      // the exit code and the informative line sits far above it. Padded past
      // 300 chars deliberately -- a tail-only match classifies this as a
      // generic failure and this assertion is what catches that.
      const stderr = [
        '[youtube] SHhWCS5AKzw: Downloading webpage',
        '[info] SHhWCS5AKzw: Downloading 1 format(s): 396+251',
        '[download] Destination: source.f396.mp4',
        "Server returned 403 Forbidden (access denied)",
        ...Array.from({ length: 12 }, (_, i) => `[download] retry ${i} of 10 padding padding padding padding`),
        'ERROR: ffmpeg exited with code 8',
      ].join('\n');
      expect(stderr.slice(-300)).not.toMatch(/403/);   // the tail really is uninformative
      expect(classifyYtDlpError(stderr).status).toBe('rate_limited');
    });

    it('maps 429 and too-many-requests the same way', () => {
      expect(classifyYtDlpError('ERROR: HTTP Error 429: Too Many Requests').status).toBe('rate_limited');
      expect(classifyYtDlpError('ERROR: Too Many Requests, slow down').status).toBe('rate_limited');
    });

    it('still prefers auth_required when the platform asks for sign-in', () => {
      // YouTube's bot check is throttling too, but cookies genuinely fix it,
      // so it must keep the status whose message says so. Pins the ordering:
      // moving the rate-limit branch above the auth one fails this.
      const f = classifyYtDlpError(
        "ERROR: Sign in to confirm you're not a bot. Use --cookies-from-browser. HTTP Error 403: Forbidden",
      );
      expect(f.status).toBe('auth_required');
    });

    it('sees the 403 ffmpeg hides on a RANGED request', () => {
      // A ranged download is fetched by ffmpeg, and yt-dlp does not forward
      // ffmpeg's stderr unless verbose -- so the same refusal a whole-video
      // request reports as "HTTP Error 403" arrived as nothing but "ffmpeg
      // exited with code 8". Identical circumstances, two different statuses,
      // and the ranged one never reached the cookie retry.
      const stderr = [
        '[debug] Command-line config: [...]',
        '[info] t7XDdXdap4w: Downloading 1 format(s): 399+251',
        '[https @ 0x0] HTTP error 403 Forbidden',
        'Error opening input: Server returned 403 Forbidden (access denied)',
        'ERROR: ffmpeg exited with code 8',
      ].join('\n');
      expect(classifyYtDlpError(stderr).status).toBe('rate_limited');
    });

    it('does NOT claim rate limiting for an ffmpeg failure with no 403 anywhere', () => {
      // The honesty boundary. Without a 403/429 in stderr there is no evidence
      // it was throttling, so the status stays extractor_failed -- but the
      // message must still beat a bare exit code, and must keep the raw text.
      const f = classifyYtDlpError('ERROR: ffmpeg exited with code 8');
      expect(f.status).toBe('extractor_failed');
      expect(f.status).not.toBe('rate_limited');
      expect(f.message).toContain('exit 8');
      expect(f.message).toMatch(/ranged|range/i);
      expect(f.message).toContain('ffmpeg exited with code 8');   // raw text preserved
    });
  });
});

describe('pickResolver dispatch order (spec §6)', () => {
  it('routes a bare .mp4 URL to the direct resolver', () => {
    expect(pickResolver('https://example.com/a/b.mp4')?.name).toBe('direct');
  });
  it('routes an HLS manifest to the direct resolver', () => {
    expect(pickResolver('https://example.com/stream.m3u8')?.name).toBe('direct');
  });
  it('routes a WeChat share link to the wechat resolver', () => {
    expect(pickResolver('https://weixin.qq.com/sph/Axv548mzBF')?.name).toBe('wechat');
  });
  it('routes everything else to yt-dlp', () => {
    expect(pickResolver('https://www.youtube.com/watch?v=abc')?.name).toBe('ytdlp');
    expect(pickResolver('https://www.tiktok.com/@x/video/123')?.name).toBe('ytdlp');
    expect(pickResolver('https://some-unknown-site.example/watch/9')?.name).toBe('ytdlp');
  });
});

describe('resolver canResolve predicates', () => {
  it('direct only claims media-ish URLs', () => {
    const d = new DirectMediaResolver();
    expect(d.canResolve('https://x.com/v.mp4')).toBe(true);
    expect(d.canResolve('https://youtube.com/watch?v=1')).toBe(false);
  });
  it('wechat claims weixin/channels hosts', () => {
    const w = new WeChatHeadlessResolver();
    expect(w.canResolve('https://weixin.qq.com/sph/abc')).toBe(true);
    expect(w.canResolve('https://channels.weixin.qq.com/web/pages/feed?x=1')).toBe(true);
    expect(w.canResolve('https://youtube.com/watch?v=1')).toBe(false);
  });
  it('ytdlp claims any http(s) URL as the catch-all', () => {
    expect(new YtDlpResolver().canResolve('https://anything.example/x')).toBe(true);
  });
});

describe('WeChatHeadlessResolver without credentials', () => {
  // Hermetic regardless of the ambient shell: without this, a developer machine or CI runner
  // that happens to export NORMA_WECHAT_COOKIE (e.g. for manual testing) would make this suite
  // silently start issuing real requests to yuanbao.tencent.com.
  beforeEach(() => { vi.stubEnv('NORMA_WECHAT_COOKIE', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('returns auth_required rather than throwing', async () => {
    const w = new WeChatHeadlessResolver();
    const r = await w.resolve('https://weixin.qq.com/sph/abc', { workDir: '/tmp' });
    expect(r.status).toBe('auth_required');
  });
  it('rejects a non-WeChat URL as unsupported without ever reaching the credential check', async () => {
    // If the internal host guard were deleted, this would fall through to the same
    // auth_required path as every other WeChat URL, and this test would fail.
    const w = new WeChatHeadlessResolver();
    const r = await w.resolve('https://youtube.com/watch?v=1', { workDir: '/tmp' });
    expect(r.status).toBe('unsupported');
  });
});

describe('WeChat credential never leaks into a failure message', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('does not leak an embedded-newline-corrupted cookie into the returned failure message', async () => {
    // Synthetic, fake credential only -- NEVER a real one. A cookie corrupted by an ordinary
    // copy-paste (e.g. a multi-header clipboard block, or a .env value with an embedded
    // newline) is invalid as an HTTP header value. Node's fetch throws a TypeError whose
    // .message embeds the raw offending header value verbatim (reproduced locally against
    // Headers construction: `Headers.append: "<value>" is an invalid header value.`). That
    // message must never reach a returned ResolveFailure: src/types.ts's Manifest.source.reason
    // persists it to disk, and callers may log it.
    const marker = 'X-Evil-Injected-Header-MARKER';
    vi.stubEnv('NORMA_WECHAT_COOKIE', `sessionid=abc123\n${marker}: leaked`);
    const w = new WeChatHeadlessResolver();
    const r = await w.resolve('https://weixin.qq.com/sph/abc', { workDir: '/tmp' });
    expect(r.status).toBe('auth_required');
    if (r.status === 'ok') throw new Error('expected a failure, got ok');
    expect(r.message).not.toContain(marker);
    expect(r.message).not.toContain('sessionid=abc123');
  });
});

describe('WeChat helpers ported from the clean-room resolver (pure logic, no network)', () => {
  it('parseShareLink extracts the share id from a /sph/<id> link', () => {
    const p = parseShareLink('https://weixin.qq.com/sph/Azf0g96b4P');
    expect(p?.shareId).toBe('Azf0g96b4P');
  });
  it('parseShareLink rejects a non-WeChat URL', () => {
    expect(parseShareLink('https://youtube.com/watch?v=x')).toBeNull();
  });
  it('classifyBusinessError maps HTTP 401 to auth', () => {
    expect(classifyBusinessError({}, 401)).toBe('auth');
  });
  it('classifyBusinessError does not misclassify a success response as an error', () => {
    // Catches a classifier collapsed to "any message present => auth" (verified by mutation:
    // dropping the keyword-regex checks makes this and the not_found case below both return
    // 'auth' instead of null/'not_found').
    expect(classifyBusinessError({ code: 0, msg: 'success', data: {} }, 200)).toBeNull();
  });
  it('classifyBusinessError maps a not-found-shaped message to not_found', () => {
    expect(classifyBusinessError({ msg: '视频不存在' }, 200)).toBe('not_found');
  });
});

describe('businessFailure (pure logic, no network)', () => {
  // Direct, minimal-surface coverage of the exact mutation class flagged in review: swapping
  // the 'auth' and 'not_found' branch bodies. Each of these two assertions independently fails
  // under that swap (verified -- see task-5-report.md's mutation-proof section).
  it('maps auth to auth_expired', () => {
    expect(businessFailure('auth')?.status).toBe('auth_expired');
  });
  it('maps not_found to not_found', () => {
    expect(businessFailure('not_found')?.status).toBe('not_found');
  });
  it('maps unsupported to unsupported/unsupported_link', () => {
    const f = businessFailure('unsupported');
    expect(f?.status).toBe('unsupported');
    expect(f?.reason).toBe('unsupported_link');
  });
  it('maps null (no business error) to null', () => {
    // Catches a bug where the "no error" case is accidentally treated as a failure somewhere
    // (e.g. a fall-through default branch), which would make every successful stage 2/3 call
    // in resolve() incorrectly short-circuit into a failure.
    expect(businessFailure(null)).toBeNull();
  });
});

describe('YtDlpResolver caption acquisition against a faked yt-dlp (hermetic, no live calls)', () => {
  // Fakes ONLY the yt-dlp subprocess; ffprobe (and any other binary) runs for
  // real, so the media file yt-dlp "produced" is genuinely probed. The faked
  // stdout JSON mirrors what the installed yt-dlp 2026.7.4 actually prints
  // (verified against its source): `--print-json` emits the sanitized info
  // dict BEFORE _write_subtitles runs, so `requested_subtitles` carries
  // ext/url but NO filepath, and subtitle files land as `source.<lang>.<ext>`
  // -- there is no `.auto.` filename infix, ever.
  let fixtureVideo: string;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-ytdlp-fixture-'));
    fixtureVideo = await makeTestVideo(join(dir, 'fixture.mp4'), 3);
  }, 30_000);

  let workDir: string;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'norma-ytdlp-work-')); });
  afterEach(() => { vi.mocked(run).mockImplementation(realRun); vi.unstubAllGlobals(); });

  const VTT_BODY = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello from captions\n';

  /** Fake a yt-dlp invocation: writes the media + given subtitle files into
   *  workDir and prints the given info-dict JSON, exactly like the real
   *  binary's --print-json --no-simulate flow. */
  function fakeYtDlp(subFiles: string[], meta: Record<string, unknown>) {
    vi.mocked(run).mockImplementation(async (cmd, args, opts) => {
      if (cmd !== 'yt-dlp') return realRun(cmd, args, opts);
      copyFileSync(fixtureVideo, join(workDir, 'source.mp4'));
      for (const f of subFiles) writeFileSync(join(workDir, f), VTT_BODY);
      return { stdout: `${JSON.stringify(meta)}\n`, stderr: '', code: 0 };
    });
  }

  it('classifies an auto-captions-only video as AUTO, never manual (the accuracy-bias inversion)', async () => {
    // Real yt-dlp behaviour for a video with only auto captions under the
    // OLD invocation (--write-subs --write-auto-subs --sub-langs all):
    // the auto track is written as source.en.vtt -- no infix -- and the old
    // filename-based findCaption classified it as MANUAL, so accurate mode
    // used it directly and stamped transcript.source: "manual".
    fakeYtDlp(['source.en.vtt'], {
      title: 'T', extractor: 'youtube', language: 'en',
      subtitles: {},
      automatic_captions: { en: [{ ext: 'vtt', data: VTT_BODY, name: 'English' }] },
      requested_subtitles: null,
      http_headers: { 'User-Agent': 'test-agent' },
    });
    const r = await new YtDlpResolver().resolve('https://www.youtube.com/watch?v=abc', { workDir });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.captions.manual).toBeNull();
    expect(r.captions.auto).not.toBeNull();
    expect(readFileSync(r.captions.auto!.path, 'utf8')).toBe(VTT_BODY);
  });

  it('selects the caption language deliberately: English beats readdir-order Arabic when no preference is given', async () => {
    // Old behaviour: files.find over readdir order -- source.ar.vtt sorts
    // before source.en.vtt, so the Arabic track won.
    fakeYtDlp(['source.ar.vtt', 'source.en.vtt'], {
      title: 'T', extractor: 'youtube', language: null,
      subtitles: { ar: [{ ext: 'vtt', url: 'https://x/ar' }], en: [{ ext: 'vtt', url: 'https://x/en' }] },
      automatic_captions: {},
      requested_subtitles: { ar: { ext: 'vtt' }, en: { ext: 'vtt' } },
    });
    const r = await new YtDlpResolver().resolve('https://www.youtube.com/watch?v=abc', { workDir });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.captions.manual).not.toBeNull();
    expect(r.captions.manual!.path.endsWith('source.en.vtt')).toBe(true);
    expect(r.captions.manual!.language).toBe('en');
  });

  it('honours preferredLanguage over English for manual caption choice', async () => {
    fakeYtDlp(['source.en.vtt', 'source.ja.vtt'], {
      title: 'T', extractor: 'youtube', language: 'en',
      subtitles: { en: [{ ext: 'vtt', url: 'https://x/en' }], ja: [{ ext: 'vtt', url: 'https://x/ja' }] },
      automatic_captions: {},
      requested_subtitles: { en: { ext: 'vtt' }, ja: { ext: 'vtt' } },
    });
    const r = await new YtDlpResolver().resolve('https://www.youtube.com/watch?v=abc', { workDir, preferredLanguage: 'ja' });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.captions.manual!.path.endsWith('source.ja.vtt')).toBe(true);
    expect(r.captions.manual!.language).toBe('ja');
  });

  it('fetches the chosen auto track by URL (bounded) when the metadata carries no inline data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(VTT_BODY, { status: 200 })));
    fakeYtDlp([], {
      title: 'T', extractor: 'youtube', language: 'fr',
      subtitles: {},
      automatic_captions: {
        ar: [{ ext: 'vtt', url: 'https://captions.example/ar.vtt' }],
        'fr-orig': [{ ext: 'vtt', url: 'https://captions.example/fr.vtt' }],
      },
      requested_subtitles: null,
    });
    const r = await new YtDlpResolver().resolve('https://www.youtube.com/watch?v=abc', { workDir });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.captions.manual).toBeNull();
    // language hint 'fr' must beat readdir/metadata order 'ar'
    expect(r.captions.auto!.language).toBe('fr');
    expect(readFileSync(r.captions.auto!.path, 'utf8')).toBe(VTT_BODY);
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledWith('https://captions.example/fr.vtt', expect.anything());
  });

  it('leaves clipStart/clipEnd undefined when a range was requested but not applied by yt-dlp', async () => {
    // Spec §5.1: range download is an optimization, never a guarantee. If
    // yt-dlp ignores --download-sections, rangeApplied is false and the file
    // is complete, so clipStart/clipEnd must stay undefined (or a later layer
    // would misread "this is the full file, sized for the full video" as "this
    // is a clipped file from second 100 to 200").
    vi.spyOn(await import('../src/media/ffmpeg.js'), 'probe').mockResolvedValueOnce({
      duration: 1000, width: 1920, height: 1080, fps: 30,
    }); // Duration doesn't match the 200-100=100 range
    fakeYtDlp([], {
      title: 'T', extractor: 'youtube',
      subtitles: {}, automatic_captions: {}, requested_subtitles: null,
    });
    const r = await new YtDlpResolver().resolve('https://www.youtube.com/watch?v=abc', {
      workDir, start: 100, end: 200,
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.rangeApplied).toBe(false);
    expect(r.clipStart).toBeUndefined();
    expect(r.clipEnd).toBeUndefined();
  });

  it('does not request a download-sections range when only one bound is given (Fix 4b / deferred #20: half-specified range must be genuinely ignored)', async () => {
    // ytdlp.ts:241's wantsRange gate requires BOTH opts.start and opts.end.
    // Every OTHER range test in this file (and in resolveTool.test.ts)
    // passes both bounds together, so an accidental `&&` -> `||` widening of
    // that gate would survive all of them silently -- this is the one test
    // that actually supplies just one bound to a download that is genuinely
    // happening (returnVideo not false), which is what the gate exists to
    // catch.
    let captured: string[] = [];
    vi.mocked(run).mockImplementation(async (cmd, args, opts) => {
      if (cmd !== 'yt-dlp') return realRun(cmd, args, opts);
      captured = args;
      copyFileSync(fixtureVideo, join(workDir, 'source.mp4'));
      return {
        stdout: `${JSON.stringify({
          title: 'T', extractor: 'youtube',
          subtitles: {}, automatic_captions: {}, requested_subtitles: null,
        })}\n`,
        stderr: '', code: 0,
      };
    });
    const r = await new YtDlpResolver().resolve('https://www.youtube.com/watch?v=abc', {
      workDir, start: 100, // end deliberately omitted
    });
    expect(captured).not.toContain('--download-sections');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.rangeApplied).toBe(false);
    expect(r.clipStart).toBeUndefined();
    expect(r.clipEnd).toBeUndefined();
  });
});

describe('WeChatHeadlessResolver.resolve() against a stubbed network (hermetic, no live calls)', () => {
  type FetchRoute = { test: (url: string) => boolean; respond: (init?: RequestInit) => Response };

  function stubFetchRoutes(routes: FetchRoute[]) {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      const route = routes.find((r) => r.test(url));
      if (!route) throw new Error(`Unexpected stubbed fetch call: ${url}`);
      return route.respond(init);
    }));
  }
  const okUserInfo: FetchRoute = {
    test: (u) => u.includes('/api/getuserinfo'),
    respond: () => new Response('{}', { status: 200 }),
  };

  // A real, tiny, ffmpeg-generated MP4 -- NOT a fabricated/mocked probe() result. The success
  // test below downloads this through the real streamed-pipeline code path and hands it to the
  // real ffprobe binary via probe(), exactly like a genuine WeChat download would be validated.
  let fixtureVideo: Buffer;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-wechat-fixture-'));
    const videoPath = await makeTestVideo(join(dir, 'fixture.mp4'), 3);
    fixtureVideo = readFileSync(videoPath);
  }, 30_000);

  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'norma-wechat-work-'));
    vi.stubEnv('NORMA_WECHAT_COOKIE', 'sessionid=test-fixture-cookie');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('classifies an auth-rejected parse response as auth_expired (classifyBusinessError -> businessFailure wiring)', async () => {
    // Catches a bug where classifyBusinessError's result is computed but not actually threaded
    // into businessFailure at the resolve() call site (e.g. the return value is discarded, or
    // the wrong variable is passed).
    stubFetchRoutes([
      okUserInfo,
      { test: (u) => u.includes('/api/weixin/get_parse_result'),
        respond: () => new Response(JSON.stringify({ error: { message: 'get token err' } }), { status: 401 }) },
    ]);
    const r = await new WeChatHeadlessResolver().resolve('https://weixin.qq.com/sph/abc', { workDir });
    expect(r.status).toBe('auth_expired');
  });

  it('maps an empty wx_export_id to not_found', async () => {
    // Catches extractParsedExport treating an empty string as a present export id, or the
    // !parsedExport branch in resolve() being deleted or misrouted to a different status.
    stubFetchRoutes([
      okUserInfo,
      { test: (u) => u.includes('/api/weixin/get_parse_result'),
        respond: () => new Response(JSON.stringify({ code: 0, msg: 'success', data: { wx_export_id: '' } }), { status: 200 }) },
    ]);
    const r = await new WeChatHeadlessResolver().resolve('https://weixin.qq.com/sph/abc', { workDir });
    expect(r.status).toBe('not_found');
  });

  it('resolves end-to-end and sends step 2\'s wx_export_id back as the singular exportId in step 3', async () => {
    let capturedObjectUrlBody: unknown = null;
    stubFetchRoutes([
      okUserInfo,
      { test: (u) => u.includes('/api/weixin/get_parse_result'),
        respond: () => new Response(JSON.stringify({
          code: 0, msg: 'success', data: { wx_export_id: 'export/ABC123', author: 'Tester', desc: '' },
        }), { status: 200 }) },
      { test: (u) => u.includes('/api/findergetobjecturl'),
        respond: (init) => {
          capturedObjectUrlBody = init?.body ? JSON.parse(init.body as string) : null;
          return new Response(JSON.stringify({ videoUrl: 'https://finder.video.qq.com/x/stodownload?token=t' }), { status: 200 });
        } },
      { test: (u) => u.startsWith('https://finder.video.qq.com/'),
        respond: () => new Response(new Uint8Array(fixtureVideo), { status: 200, headers: { 'Content-Type': 'video/mp4' } }) },
    ]);

    // An abandoned partial from an earlier crashed run, old enough to be
    // collectable: WeChat's entry sweep is the third such call site and was
    // the one with no coverage -- it could be deleted outright with the
    // whole suite green.
    const staleOrphan = join(workDir, 'source.mp4.4242-9.part');
    writeFileSync(staleOrphan, Buffer.alloc(4096));
    const longAgo = new Date(Date.now() - 24 * 60 * 60_000);
    utimesSync(staleOrphan, longAgo, longAgo);

    const result = await new WeChatHeadlessResolver().resolve('https://weixin.qq.com/sph/abc', { workDir });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(existsSync(result.filePath)).toBe(true);
    expect(existsSync(staleOrphan)).toBe(false);
    expect(result.resolvedBy).toBe('wechat');
    expect(result.title).toBe('Tester');
    // Documented platform prior (see download() in src/resolve/wechat.ts):
    // without it the hint was null and the wechat->SenseVoice ASR route
    // could never trigger via the resolver alone.
    expect(result.languageHint).toBe('zh');
    // The data handoff the two-step flow depends on: step 2's wx_export_id must be echoed back
    // as the SINGULAR `exportId` string in step 3 -- the {exportIds:[...]} array form is a
    // documented, previously-hit real bug (business-code 500 from findergetobjecturl).
    expect(capturedObjectUrlBody).toEqual({ exportId: 'export/ABC123' });
  });
});

describe('DirectMediaResolver metadata-only mode (returnVideo:false, spec §2.1)', () => {
  // A real, tiny, ffmpeg-generated MP4 for the one regression test that
  // needs the transfer to genuinely succeed end-to-end.
  let fixtureVideo: string;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-direct-fixture-'));
    fixtureVideo = await makeTestVideo(join(dir, 'fixture.mp4'), 3);
  }, 30_000);

  // run/fetchToFile are module-level mocks shared across this whole file
  // (set up once by the vi.mock calls at the top) -- their .mock.calls
  // history is NOT reset between tests or describe blocks by vitest's
  // defaults (this project sets neither clearMocks nor restoreMocks), so
  // without an explicit clear here, calls from EARLIER suites in this file
  // (real ffmpeg/yt-dlp/WeChat fixture and end-to-end calls) accumulate
  // into these call-count assertions. Caught empirically: the first run
  // showed "not.toHaveBeenCalled()" failing with 13 pre-existing calls,
  // and the returnVideo:true regression test seeing 2 calls instead of 1
  // (the extra one left over from the WeChat end-to-end test earlier in
  // this same file).
  beforeEach(() => {
    vi.mocked(run).mockClear();
    vi.mocked(fetchToFile).mockClear();
  });
  afterEach(() => {
    vi.mocked(run).mockImplementation(realRun);
    vi.mocked(fetchToFile).mockImplementation(realFetchToFile);
  });

  it('performs NO network or subprocess transfer for a direct file URL when returnVideo is false', async () => {
    // Decisive test, not a proxy like "videoPath is undefined": both mocks
    // THROW if the download-invoking code is ever reached, so a regression
    // that removes or bypasses the early return fails loudly here, rather
    // than merely producing a slightly-wrong result shape.
    vi.mocked(run).mockImplementation(async () => { throw new Error('run() must not be called when returnVideo is false'); });
    vi.mocked(fetchToFile).mockImplementation(async () => { throw new Error('fetchToFile() must not be called when returnVideo is false'); });
    const d = new DirectMediaResolver();
    const workDir = mkdtempSync(join(tmpdir(), 'norma-direct-meta-'));
    const r = await d.resolve('https://example.com/videos/clip.mp4', { workDir, returnVideo: false });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.title).toBe('clip.mp4');
    expect(vi.mocked(fetchToFile)).not.toHaveBeenCalled();
    expect(vi.mocked(run)).not.toHaveBeenCalled();
  });

  it('performs NO network or subprocess transfer for an HLS URL when returnVideo is false', async () => {
    // The HLS/DASH branch uses run('ffmpeg', ...) instead of fetchToFile --
    // both must stay unreached, not just the one this URL shape would
    // normally take.
    vi.mocked(run).mockImplementation(async () => { throw new Error('run() must not be called when returnVideo is false'); });
    vi.mocked(fetchToFile).mockImplementation(async () => { throw new Error('fetchToFile() must not be called when returnVideo is false'); });
    const d = new DirectMediaResolver();
    const workDir = mkdtempSync(join(tmpdir(), 'norma-direct-meta-'));
    const r = await d.resolve('https://example.com/stream.m3u8', { workDir, returnVideo: false });
    expect(r.status).toBe('ok');
    expect(vi.mocked(run)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchToFile)).not.toHaveBeenCalled();
  });

  it('still performs the real transfer when returnVideo is true (regression: opt-out must not become the default)', async () => {
    vi.mocked(fetchToFile).mockImplementation(async (_url, out) => {
      copyFileSync(fixtureVideo, out);
      return { ok: true, status: 200 };
    });
    const d = new DirectMediaResolver();
    const workDir = mkdtempSync(join(tmpdir(), 'norma-direct-meta-'));
    const r = await d.resolve('https://example.com/videos/clip.mp4', { workDir, returnVideo: true });
    expect(vi.mocked(fetchToFile)).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(existsSync(r.filePath)).toBe(true);
  });

  it('returns duration:0 and filePath:\'\' as type-satisfying placeholders, not measurements, when returnVideo is false', async () => {
    // Documents the internal contract resolveVideoTool.ts relies on:
    // ResolvedMedia.duration/filePath are non-optional, so the resolver
    // cannot return "unknown" directly here -- it returns a placeholder,
    // and the agent-facing layer (covered separately in
    // resolveTool.test.ts) is what turns this into a genuinely absent
    // field rather than surfacing a fabricated zero.
    const d = new DirectMediaResolver();
    const workDir = mkdtempSync(join(tmpdir(), 'norma-direct-meta-'));
    const r = await d.resolve('https://example.com/videos/clip.mp4', { workDir, returnVideo: false });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.duration).toBe(0);
    expect(r.filePath).toBe('');
  });
});

describe('YtDlpResolver metadata-only mode (returnVideo:false, spec §2.1)', () => {
  let workDir: string;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'norma-ytdlp-meta-')); });
  afterEach(() => { vi.mocked(run).mockImplementation(realRun); vi.unstubAllGlobals(); });

  const VTT_BODY = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello from captions\n';

  it('passes --skip-download when returnVideo is false -- the actual mechanism, verified against the installed yt-dlp source, that gates the real download branch', async () => {
    let captured: string[] = [];
    vi.mocked(run).mockImplementation(async (cmd, args, opts) => {
      if (cmd !== 'yt-dlp') return realRun(cmd, args, opts);
      captured = args;
      // Deliberately writes NO video file -- --skip-download genuinely
      // does not produce one (verified against the installed yt-dlp's own
      // source: the download branch is never entered when it is set).
      return {
        stdout: `${JSON.stringify({
          title: 'T', extractor: 'youtube', duration: 754,
          subtitles: {}, automatic_captions: {}, requested_subtitles: null,
        })}\n`,
        stderr: '', code: 0,
      };
    });
    const r = await new YtDlpResolver().resolve('https://www.youtube.com/watch?v=abc', { workDir, returnVideo: false });
    expect(captured).toContain('--skip-download');
    expect(r.status).toBe('ok');
  });

  it('omits --skip-download when returnVideo is true or omitted (regression: opt-out must not become the default)', async () => {
    let captured: string[] = [];
    vi.mocked(run).mockImplementation(async (cmd, args, opts) => {
      if (cmd !== 'yt-dlp') return realRun(cmd, args, opts);
      captured = args;
      return {
        stdout: `${JSON.stringify({ title: 'T', extractor: 'youtube', subtitles: {}, automatic_captions: {}, requested_subtitles: null })}\n`,
        stderr: '', code: 0,
      };
    });
    // This fake writes no video file either, so omitting returnVideo here
    // surfaces as an honest 'yt-dlp produced no media file' failure -- the
    // assertion under test is purely about the FLAG, not this fake's
    // fidelity to a real download.
    await new YtDlpResolver().resolve('https://www.youtube.com/watch?v=abc', { workDir });
    expect(captured).not.toContain('--skip-download');
  });

  it('returns metadata using the info dict duration, without requiring any produced media file, when returnVideo is false', async () => {
    // Decisive: if the !wantsDownload branch were removed or bypassed,
    // this falls through to the readdirSync/produced-file check further
    // down, which finds nothing (this fake writes no video file) and
    // returns extractor_failed instead of ok.
    vi.mocked(run).mockImplementation(async (cmd, args, opts) => {
      if (cmd !== 'yt-dlp') return realRun(cmd, args, opts);
      return {
        stdout: `${JSON.stringify({
          title: 'Metadata Only', extractor: 'youtube', duration: 754,
          subtitles: {}, automatic_captions: {}, requested_subtitles: null,
        })}\n`,
        stderr: '', code: 0,
      };
    });
    const r = await new YtDlpResolver().resolve('https://www.youtube.com/watch?v=abc', { workDir, returnVideo: false });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.duration).toBe(754);
    expect(r.metadata?.duration).toBe(754);
    expect(r.filePath).toBe('');
  });

  it('still returns real, honest captions when returnVideo is false (subtitle files ARE written even with --skip-download, verified against yt-dlp source)', async () => {
    vi.mocked(run).mockImplementation(async (cmd, args, opts) => {
      if (cmd !== 'yt-dlp') return realRun(cmd, args, opts);
      writeFileSync(join(workDir, 'source.en.vtt'), VTT_BODY);
      return {
        stdout: `${JSON.stringify({
          title: 'T', extractor: 'youtube', language: 'en', duration: 42,
          subtitles: { en: [{ ext: 'vtt', url: 'https://x/en' }] },
          automatic_captions: {}, requested_subtitles: { en: { ext: 'vtt' } },
        })}\n`,
        stderr: '', code: 0,
      };
    });
    const r = await new YtDlpResolver().resolve('https://www.youtube.com/watch?v=abc', { workDir, returnVideo: false });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.captions.manual).not.toBeNull();
    expect(r.captions.manual!.language).toBe('en');
    expect(readFileSync(r.captions.manual!.path, 'utf8')).toBe(VTT_BODY);
  });

  it('does not request a download-sections range when returnVideo is false, even if start/end are both given directly', async () => {
    let captured: string[] = [];
    vi.mocked(run).mockImplementation(async (cmd, args, opts) => {
      if (cmd !== 'yt-dlp') return realRun(cmd, args, opts);
      captured = args;
      return {
        stdout: `${JSON.stringify({
          title: 'T', extractor: 'youtube', duration: 500,
          subtitles: {}, automatic_captions: {}, requested_subtitles: null,
        })}\n`,
        stderr: '', code: 0,
      };
    });
    await new YtDlpResolver().resolve('https://www.youtube.com/watch?v=abc', {
      workDir, returnVideo: false, start: 10, end: 20,
    });
    expect(captured).not.toContain('--download-sections');
  });
});

describe('WeChatHeadlessResolver metadata-only mode (returnVideo:false, spec §2.1)', () => {
  beforeEach(() => { vi.stubEnv('NORMA_WECHAT_COOKIE', 'sessionid=test-fixture-cookie'); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('performs NO network activity at all when returnVideo is false, even with a valid credential present', async () => {
    // Decisive: fetch THROWS if called at all, so any of the three staged
    // API calls (getuserinfo/parse/object-url) being reached fails this
    // loudly -- not just the final media download, which is the ONLY step
    // direct.ts's sibling case has to worry about.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch() must not be called when returnVideo is false'); }));
    const w = new WeChatHeadlessResolver();
    const r = await w.resolve('https://weixin.qq.com/sph/Axv548mzBF', { workDir: '/tmp', returnVideo: false });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.title).toBe('WeChat video Axv548mzBF');
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('still requires a credential even when returnVideo is false (a free, URL/env-only check, not gated on downloading)', async () => {
    vi.stubEnv('NORMA_WECHAT_COOKIE', '');
    const w = new WeChatHeadlessResolver();
    const r = await w.resolve('https://weixin.qq.com/sph/abc', { workDir: '/tmp', returnVideo: false });
    expect(r.status).toBe('auth_required');
  });

  it('returns duration:0, filePath:\'\' and rangeApplied:false as placeholders when returnVideo is false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch() must not be called'); }));
    const w = new WeChatHeadlessResolver();
    const r = await w.resolve('https://weixin.qq.com/sph/abc', { workDir: '/tmp', returnVideo: false });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.duration).toBe(0);
    expect(r.filePath).toBe('');
    expect(r.rangeApplied).toBe(false);
    // Documented platform prior -- costs nothing to keep, unlike duration.
    expect(r.languageHint).toBe('zh');
  });

  it('still performs real network calls when returnVideo is true (regression: opt-out must not become the default)', async () => {
    let fetchCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      fetchCalls += 1;
      const url = input.toString();
      if (url.includes('/api/getuserinfo')) return new Response('{}', { status: 200 });
      if (url.includes('/api/weixin/get_parse_result')) {
        return new Response(JSON.stringify({ code: 0, msg: 'success', data: { wx_export_id: 'x1' } }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }));
    const w = new WeChatHeadlessResolver();
    await w.resolve('https://weixin.qq.com/sph/abc', { workDir: '/tmp', returnVideo: true });
    expect(fetchCalls).toBeGreaterThan(0);
  });
});

describe('a ranged download asks yt-dlp to show ffmpeg\'s errors', () => {
  afterEach(() => { vi.mocked(run).mockImplementation(realRun); });

  /** Captures the argv yt-dlp is invoked with, without running anything. */
  function captureArgs(): { args: string[][] } {
    const seen: string[][] = [];
    vi.mocked(run).mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd !== 'yt-dlp') return realRun(cmd, args);
      seen.push(args);
      return { code: 1, stdout: '', stderr: 'ERROR: stopped' };
    });
    return { args: seen };
  }

  it('passes --verbose when a range is requested', async () => {
    // Without it, ffmpeg does the fetching and yt-dlp swallows its stderr, so
    // a 403 arrives as nothing but "ffmpeg exited with code 8" -- unreadable,
    // and invisible to the rate-limit classification that would have made the
    // cookie retry fire.
    const c = captureArgs();
    await new YtDlpResolver().resolve('https://example.invalid/v', {
      workDir: mkdtempSync(join(tmpdir(), 'vem-rngv-')), returnVideo: true, start: 0, end: 20,
    });
    expect(c.args[0]).toContain('--download-sections');
    expect(c.args[0]).toContain('--verbose');
  }, 30_000);

  it('does NOT pass --verbose otherwise, keeping ordinary stderr small', async () => {
    const c = captureArgs();
    await new YtDlpResolver().resolve('https://example.invalid/v', {
      workDir: mkdtempSync(join(tmpdir(), 'vem-rngv2-')), returnVideo: true,
    });
    expect(c.args[0]).not.toContain('--verbose');
  }, 30_000);
});
