import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only the speech model is replaced: what is under test is analyze.ts's
// decision about WHY local recognition ran, not the recognizer. The resolver,
// run(), the stdout streaming and the caption HTTP fetches are all real.
vi.mock('../src/transcript/asr.js', () => ({
  transcribeAudio: vi.fn(async () => ({
    language: 'pt', source: 'asr', segments: [{ start: 0, end: 1, text: 'from local speech recognition' }],
  })),
}));
vi.mock('../src/transcript/fetchModels.js', () => ({ ensureAsrModels: vi.fn(async () => undefined) }));

const { analyzeVideo } = await import('../src/analyze.js');
const { YtDlpResolver, fetchCaptionTrack } = await import('../src/resolve/ytdlp.js');
const { makeTestVideo } = await import('../src/media/ffmpeg.js');
const { resolveVideoTool } = await import('../src/agent/resolveTool.js');

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nfrom the platform caption track\n';

/** A real HTTP server whose response per path is scripted by the test. */
let server: Server;
let base: string;
let handler: (path: string) => { status: number; body: string; headers?: Record<string, string> };
const hits: Array<{ path: string; at: number }> = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push({ path: req.url ?? '', at: Date.now() });
    const r = handler(req.url ?? '');
    res.writeHead(r.status, r.headers ?? {});
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let video: string;
beforeAll(async () => {
  video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-capfb-')), 'v.mp4'), 3);
}, 30_000);

let prevPath: string | undefined;
afterEach(() => {
  if (prevPath !== undefined) process.env.PATH = prevPath;
  prevPath = undefined;
  hits.length = 0;
});

/**
 * Installs a fake yt-dlp on PATH. It prints `meta` as the info dict FIRST --
 * as the real binary does, before any transfer -- then takes `downloadSeconds`
 * to "download" (skipped under --skip-download). `failSubs` makes a run that
 * still has --write-subs abort the way yt-dlp does when a subtitle download
 * fails. Every invocation's argv is logged.
 */
function fakeYtDlp(meta: Record<string, unknown>, opts: { downloadSeconds?: number; failSubs?: boolean } = {}) {
  const binDir = mkdtempSync(join(tmpdir(), 'vem-capfb-bin-'));
  const log = join(binDir, 'argv.log');
  const script = [
    '#!/bin/sh',
    `echo "$@" >> "${log}"`,
    'out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
    'dir=$(dirname "$out")',
    `echo '${JSON.stringify(meta)}'`,
    opts.failSubs
      ? `case " $* " in *" --write-subs "*) echo "ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests" >&2; exit 1 ;; esac`
      : ':',
    'case " $* " in',
    '  *" --skip-download "*) ;;',
    `  *) sleep ${opts.downloadSeconds ?? 0}; cp "${video}" "$dir/source.mp4" ;;`,
    'esac',
    'exit 0',
  ].join('\n');
  writeFileSync(join(binDir, 'yt-dlp'), script);
  chmodSync(join(binDir, 'yt-dlp'), 0o755);
  prevPath = process.env.PATH;
  process.env.PATH = `${binDir}:${prevPath ?? ''}`;
  return { argv: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

const autoMeta = (path: string) => ({
  title: 'fake', duration: 3, extractor: 'youtube', language: 'pt',
  subtitles: {}, requested_subtitles: null,
  automatic_captions: { 'pt-orig': [{ ext: 'vtt', url: `${base}${path}` }] },
});

describe('fetchCaptionTrack (real HTTP)', () => {
  const choice = (path: string) => ({ lang: 'pt', format: { ext: 'vtt', url: `${base}${path}` } });

  it('retries a throttled fetch and gets the track', async () => {
    let n = 0;
    handler = () => (++n < 3 ? { status: 429, body: 'slow down', headers: { 'Retry-After': '0' } } : { status: 200, body: VTT });
    const r = await fetchCaptionTrack(choice('/t'), undefined, mkdtempSync(join(tmpdir(), 'vem-capfb-w-')), 'automatic');
    expect('track' in r && readFileSync(r.track.path, 'utf8')).toBe(VTT);
    expect(hits).toHaveLength(3);
  });

  it('says what failed and how often when throttling never clears', async () => {
    handler = () => ({ status: 429, body: '', headers: { 'Retry-After': '0' } });
    const r = await fetchCaptionTrack(choice('/t'), undefined, mkdtempSync(join(tmpdir(), 'vem-capfb-w-')), 'automatic');
    expect(r).toEqual({ error: 'automatic captions (pt) could not be retrieved: HTTP 429 (3 attempts)' });
  });

  it('does not retry a refusal that will not change', async () => {
    handler = () => ({ status: 404, body: '' });
    const r = await fetchCaptionTrack(choice('/t'), undefined, mkdtempSync(join(tmpdir(), 'vem-capfb-w-')), 'automatic');
    expect(r).toEqual({ error: 'automatic captions (pt) could not be retrieved: HTTP 404' });
    expect(hits).toHaveLength(1);
  });

  it('rejects a 200 that is not a caption file (a consent page, an empty body)', async () => {
    handler = () => ({ status: 200, body: '<html>consent</html>' });
    const r = await fetchCaptionTrack(choice('/t'), undefined, mkdtempSync(join(tmpdir(), 'vem-capfb-w-')), 'automatic');
    expect(r).toEqual({ error: 'automatic captions (pt) could not be retrieved: the response was not a caption file' });
  });
});

describe('YtDlpResolver caption acquisition (real run(), fake yt-dlp on PATH)', () => {
  it('starts the auto-caption fetch as soon as the info dict prints, not after the download', async () => {
    handler = () => ({ status: 200, body: VTT });
    fakeYtDlp(autoMeta('/early'), { downloadSeconds: 2 });
    const r = await new YtDlpResolver().resolve('https://www.youtube.com/watch?v=x', {
      workDir: mkdtempSync(join(tmpdir(), 'vem-capfb-w-')),
    });
    const done = Date.now();
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(readFileSync(r.captions.auto!.path, 'utf8')).toBe(VTT);
    // The fake "download" takes 2s after the JSON; a fetch made after the
    // run would land within milliseconds of `done`.
    expect(done - hits[0]!.at).toBeGreaterThan(1500);
  });

  it('records a caption the platform offered but that could not be fetched', async () => {
    handler = () => ({ status: 429, body: '', headers: { 'Retry-After': '0' } });
    fakeYtDlp(autoMeta('/throttled'));
    const r = await new YtDlpResolver().resolve('https://www.youtube.com/watch?v=x', {
      workDir: mkdtempSync(join(tmpdir(), 'vem-capfb-w-')),
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.captions.auto).toBeNull();
    expect(r.captions.retrievalErrors).toEqual([
      'automatic captions (pt-orig) could not be retrieved: HTTP 429 (3 attempts)',
    ]);
  });

  it('reports no retrievalErrors key at all when the video simply has no captions', async () => {
    fakeYtDlp({ title: 'fake', duration: 3, extractor: 'youtube', subtitles: {}, automatic_captions: {}, requested_subtitles: null });
    const r = await new YtDlpResolver().resolve('https://www.youtube.com/watch?v=x', {
      workDir: mkdtempSync(join(tmpdir(), 'vem-capfb-w-')),
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect('retrievalErrors' in r.captions).toBe(false);
  });

  it('survives yt-dlp aborting on a manual subtitle: reruns without subs and fetches the track itself', async () => {
    handler = () => ({ status: 200, body: VTT });
    const fake = fakeYtDlp({
      title: 'fake', duration: 3, extractor: 'youtube', language: 'en', automatic_captions: {},
      subtitles: { en: [{ ext: 'vtt', url: `${base}/manual` }] },
      requested_subtitles: { en: { ext: 'vtt' } },
    }, { failSubs: true });
    const r = await new YtDlpResolver().resolve('https://www.youtube.com/watch?v=x', {
      workDir: mkdtempSync(join(tmpdir(), 'vem-capfb-w-')),
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(readFileSync(r.captions.manual!.path, 'utf8')).toBe(VTT);
    const argv = fake.argv();
    expect(argv).toHaveLength(2);
    expect(argv[0]).toContain('--write-subs');
    expect(argv[1]).not.toContain('--write-subs');
    expect('retrievalErrors' in r.captions).toBe(false);
  });
});

describe('analyzeVideo says which of the two reasons put it on local speech recognition', () => {
  it('captions_failed, with a warning naming the cause, when the offered track could not be fetched', async () => {
    handler = () => ({ status: 429, body: '', headers: { 'Retry-After': '0' } });
    fakeYtDlp(autoMeta('/throttled'));
    const m = await analyzeVideo('https://www.youtube.com/watch?v=x', { frames: 'none' });
    expect(m.source.status).toBe('ok');
    expect(m.transcript?.source).toBe('asr');
    expect(m.transcript?.asrReason).toBe('captions_failed');
    expect(m.processing.warnings).toEqual([
      'platform captions exist but could not be retrieved, so the transcript comes from local speech '
      + 'recognition instead: automatic captions (pt-orig) could not be retrieved: HTTP 429 (3 attempts)',
    ]);
  }, 60_000);

  it('no_captions, with no warning, when the video has none', async () => {
    fakeYtDlp({ title: 'fake', duration: 3, extractor: 'youtube', subtitles: {}, automatic_captions: {}, requested_subtitles: null });
    const m = await analyzeVideo('https://www.youtube.com/watch?v=x', { frames: 'none' });
    expect(m.transcript?.source).toBe('asr');
    expect(m.transcript?.asrReason).toBe('no_captions');
    expect(m.processing.warnings).toEqual([]);
  }, 60_000);

  it('uses the platform caption and carries no asrReason when the fetch works', async () => {
    handler = () => ({ status: 200, body: VTT });
    fakeYtDlp(autoMeta('/ok'));
    const m = await analyzeVideo('https://www.youtube.com/watch?v=x', { frames: 'none' });
    expect(m.transcript?.source).toBe('auto');
    expect(m.transcript && 'asrReason' in m.transcript).toBe(false);
    expect(m.transcript?.segments.map((s) => s.text)).toEqual(['from the platform caption track']);
  }, 60_000);
});

describe('resolve_video delivers its caption file and leaves no scratch behind', () => {
  it('metadata.json points at a caption file inside destinationPath, and nothing else is left', async () => {
    handler = () => ({ status: 200, body: VTT });
    fakeYtDlp(autoMeta('/ok'));
    const dest = mkdtempSync(join(tmpdir(), 'vem-capfb-dest-'));
    const tmpBefore = readdirSync(tmpdir()).filter((f) => f.startsWith('norma-res-')).length;
    const { videos: [item] } = await resolveVideoTool({ destinationPath: dest, videos: [{ url: 'https://www.youtube.com/watch?v=x' }] });
    expect(item!.status).toBe('ok');
    const meta = JSON.parse(readFileSync(join(dest, 'metadata.json'), 'utf8')) as { captions: { auto: { path: string } } };
    expect(meta.captions.auto.path).toBe(join(dest, 'auto.pt-orig.vtt'));
    expect(readFileSync(meta.captions.auto.path, 'utf8')).toBe(VTT);
    expect(readdirSync(dest).sort()).toEqual(['auto.pt-orig.vtt', 'metadata.json']);
    expect(readdirSync(tmpdir()).filter((f) => f.startsWith('norma-res-')).length).toBe(tmpBefore);
  });
});
