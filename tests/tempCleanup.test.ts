import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepLegacyResolveTempDirs } from '../src/agent/workdir.js';
import { analyzeVideoTool } from '../src/agent/analyzeTool.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';

afterEach(() => { vi.unstubAllEnvs(); });

const DAY_MS = 24 * 60 * 60 * 1000;

function aged(path: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
}

describe('sweepLegacyResolveTempDirs (what resolve_video left in os.tmpdir() before 0.14.0)', () => {
  it('removes only old directories named exactly like resolve_video named them', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'vem-sweep-'));
    const mk = (name: string, ageMs: number, asFile = false) => {
      const p = join(tmp, name);
      if (asFile) writeFileSync(p, 'x');
      else { mkdirSync(p); writeFileSync(join(p, 'source.f399.mp4.part'), 'partial bytes'); }
      aged(p, ageMs);
    };
    mk('norma-res-Ab12Cd', 2 * DAY_MS);          // legacy, old: goes
    mk('norma-res-Ef34Gh', 60 * 60 * 1000);      // legacy, an hour old: an older server may still own it
    mk('norma-res-Ab12Cd7', 2 * DAY_MS);         // not mkdtemp's 6 characters
    mk('norma-res-Ij56Kl', 2 * DAY_MS, true);    // a file, not a directory
    mk('norma-engine-Mn78Op', 2 * DAY_MS);       // someone else's prefix
    mk('norma-Qr90St', 2 * DAY_MS);              // the CLI's output directory: deliberately kept (follow-ups §C)
    const removed = await sweepLegacyResolveTempDirs({ dir: tmp });
    expect(removed).toBe(1);
    expect(readdirSync(tmp).sort()).toEqual([
      'norma-Qr90St', 'norma-engine-Mn78Op', 'norma-res-Ab12Cd7', 'norma-res-Ef34Gh', 'norma-res-Ij56Kl',
    ]);
  });

  it('stops when aborted, so server shutdown never waits on it', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'vem-sweep-'));
    const p = join(tmp, 'norma-res-Ab12Cd');
    mkdirSync(p);
    aged(p, 2 * DAY_MS);
    const stop = new AbortController();
    stop.abort();
    expect(await sweepLegacyResolveTempDirs({ dir: tmp, signal: stop.signal })).toBe(0);
    expect(existsSync(p)).toBe(true);
  });
});

describe('analyze_video on a local file leaves nothing in os.tmpdir()', () => {
  it('real pipeline: no norma-* directory appears in the temp directory', async () => {
    const video = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-local-src-')), 'v.mp4'), 4);
    // os.tmpdir() reads TMPDIR on every call, so this isolates exactly what
    // this one call creates there.
    const privateTmp = mkdtempSync(join(tmpdir(), 'vem-private-tmp-'));
    vi.stubEnv('TMPDIR', privateTmp);
    const dest = mkdtempSync(join(privateTmp, 'dest-'));
    const r = await analyzeVideoTool({
      destinationPath: dest,
      videos: [{ pathOrUrl: video, frames: 'even', maxFrames: 2, transcript: false }],
    });
    expect(r.videos[0]!.status).toBe('ok');
    expect(r.videos[0]!.frameCount).toBe(2);
    expect(readdirSync(privateTmp).filter((f) => f.startsWith('norma-'))).toEqual([]);
    expect(readdirSync(dest).filter((f) => f.startsWith('.work-'))).toEqual([]);
  }, 60_000);
});
