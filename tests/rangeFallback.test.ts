import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YtDlpResolver } from '../src/resolve/ytdlp.js';
import { rangePastEnd } from '../src/util/range.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';

/**
 * The shape of the first live acceptance-matrix run's range failure: yt-dlp
 * prints the info dict, then ffmpeg's direct fetch of the section is refused
 * with 403 -- and with --print-json that 403 line lands on STDOUT, while
 * stderr says only "ffmpeg exited with code 8". A whole-video download of the
 * same video works.
 */
let fixture: string;
beforeAll(async () => {
  fixture = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-rf-src-')), 'v.mp4'), 6);
}, 60_000);

let prevPath: string | undefined;
afterEach(() => { if (prevPath !== undefined) process.env['PATH'] = prevPath; prevPath = undefined; });

function fakeYtDlp(opts: { duration: number; wholeWorks: boolean; refusal?: 'stdout' | 'stderr' }) {
  const dir = mkdtempSync(join(tmpdir(), 'vem-rf-bin-'));
  const log = join(dir, 'argv.log');
  const info = JSON.stringify({ title: 't', duration: opts.duration, extractor: 'youtube' });
  const refusal = '[https @ 0x1] HTTP error 403 Forbidden\nError opening input: Server returned 403 Forbidden (access denied)';
  writeFileSync(join(dir, 'yt-dlp'), [
    '#!/bin/sh',
    `echo "$@" >> "${log}"`,
    'out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
    `echo '${info}'`,
    'case " $* " in',
    '  *" --download-sections "*)',
    opts.refusal === 'stderr' ? `    printf '%s\\n' "${refusal}" >&2` : `    printf '%s\\n' "${refusal}"`,
    '    echo "ERROR: ffmpeg exited with code 8" >&2; exit 1 ;;',
    '  *)',
    opts.wholeWorks
      ? `    cp "${fixture}" "$(dirname "$out")/source.mp4"; exit 0 ;;`
      // The 403 on stdout ONLY, as --print-json routes ffmpeg's output.
      : `    printf '%s\\n' "${refusal}"; echo "ERROR: ffmpeg exited with code 8" >&2; exit 1 ;;`,
    'esac',
  ].join('\n'));
  chmodSync(join(dir, 'yt-dlp'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${dir}:${prevPath ?? ''}`;
  return { log, workDir: mkdtempSync(join(tmpdir(), 'vem-rf-work-')) };
}

const calls = (log: string) => readFileSync(log, 'utf8').trim().split('\n');

describe('a refused ranged fetch', () => {
  it('falls back to the whole video once, leaving the trim to the caller', async () => {
    const f = fakeYtDlp({ duration: 1203, wholeWorks: true });
    const r = await new YtDlpResolver().resolve('https://example.invalid/v', { workDir: f.workDir, start: 23, end: 60 });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    // Not applied: the file is the whole video, so analyze.ts / resolveTool.ts trim it.
    expect(r.rangeApplied).toBe(false);
    const argv = calls(f.log);
    expect(argv.length).toBe(2);
    expect(argv[0]).toContain('--download-sections *23-60');
    expect(argv[1]).not.toContain('--download-sections');
    expect(argv[1]).not.toContain('--force-keyframes-at-cuts');
    expect(argv[1]).not.toContain('--verbose');
  }, 60_000);

  it('is classified from the 403 yt-dlp prints on stdout under --print-json', async () => {
    // Both the ranged and the whole fetch refused: the answer must be the
    // temporary rate_limited, not a terminal-sounding extractor_failed.
    const f = fakeYtDlp({ duration: 1203, wholeWorks: false });
    const r = await new YtDlpResolver().resolve('https://example.invalid/v', { workDir: f.workDir, start: 23, end: 60 });
    expect(r.status).toBe('rate_limited');
  }, 60_000);

  it('says the range is past the end instead of blaming the platform, and fetches nothing more', async () => {
    const f = fakeYtDlp({ duration: 19, wholeWorks: true });
    const r = await new YtDlpResolver().resolve('https://example.invalid/v', { workDir: f.workDir, start: 23, end: 60 });
    expect(r.status).toBe('extractor_failed');
    expect((r as { message: string }).message).toMatch(/starts at 23s, but the video is only 19s long/);
    expect(calls(f.log).length).toBe(1);
  }, 60_000);

  it('never mistakes the video\'s own description for an error', async () => {
    // A title saying "Sign in" and "403" sits in the info-dict JSON on stdout;
    // the whole fetch then fails for an unrelated reason.
    const dir = mkdtempSync(join(tmpdir(), 'vem-rf-bin-'));
    writeFileSync(join(dir, 'yt-dlp'), [
      '#!/bin/sh',
      `echo '${JSON.stringify({ title: 'Sign in to see my 403 cookies', duration: 50 })}'`,
      'echo "ERROR: Video unavailable" >&2; exit 1',
    ].join('\n'));
    chmodSync(join(dir, 'yt-dlp'), 0o755);
    prevPath = process.env['PATH'];
    process.env['PATH'] = `${dir}:${prevPath ?? ''}`;
    const r = await new YtDlpResolver().resolve('https://example.invalid/v', {
      workDir: mkdtempSync(join(tmpdir(), 'vem-rf-work-')), returnVideo: false,
    });
    expect(r.status).toBe('not_found');
  }, 60_000);
});

describe('rangePastEnd', () => {
  it('only objects when the start is at or past the end of a known duration', () => {
    expect(rangePastEnd(23, 19)).toMatch(/starts at 23s, but the video is only 19s long/);
    expect(rangePastEnd(19, 19)).not.toBeNull();
    expect(rangePastEnd(10, 19)).toBeNull();
    expect(rangePastEnd(23, 0)).toBeNull();      // unknown duration: not our call to make
    expect(rangePastEnd(23, undefined)).toBeNull();
    expect(rangePastEnd(undefined, 19)).toBeNull();
  });
});

describe('analyze_video: a range past the end of a local video', () => {
  it('says so, instead of failing inside the trim', async () => {
    const { analyzeVideo } = await import('../src/analyze.js');
    const m = await analyzeVideo(fixture, { start: 23, end: 60, frames: 'none', transcript: false });
    expect(m.source.status).toBe('extractor_failed');
    expect(m.source.reason).toMatch(/starts at 23s, but the video is only 6s long/);
  }, 60_000);
});
