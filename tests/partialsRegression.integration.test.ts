import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { DirectMediaResolver } from '../src/resolve/direct.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';

/**
 * Regressions an earlier draft of the partial-download fix introduced, each
 * caught in review AFTER a full suite passed against it. Both are the same
 * class: renaming the in-flight file changed behaviour that nothing was
 * watching.
 */
let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

describe('a .m3u8 URL still resolves', () => {
  it('muxes to a completed source.mp4 (ffmpeg cannot infer a muxer from a .part name)', async () => {
    // The in-flight file has no media extension, so ffmpeg must be told the
    // format explicitly. Without that it exits non-zero and EVERY HLS/DASH
    // URL -- a documented supported source -- fails outright.
    const dir = mkdtempSync(join(tmpdir(), 'vem-hls-'));
    const mp4 = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-hlssrc-')), 'seg.mp4'), 1);
    const seg = readFileSync(mp4);
    // One server serves BOTH the playlist and the segment it references --
    // ffmpeg fetches the segment while muxing, so it must still be up.
    server = createServer((req, res) => {
      if (req.url?.endsWith('.m3u8')) {
        const body = Buffer.from(
          `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.0,\nseg.mp4\n#EXT-X-ENDLIST\n`,
        );
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': String(body.length) });
        res.end(body);
      } else {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(seg.length) });
        res.end(seg);
      }
    });
    const url: string = await new Promise((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const a = server!.address();
        resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/stream.m3u8`);
      });
    });

    const r = await new DirectMediaResolver().resolve(url, { workDir: dir, returnVideo: true });
    expect(r.status).toBe('ok');
    expect(existsSync(join(dir, 'source.mp4'))).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([]);
  }, 60_000);
});

describe('a failing call never destroys a completed file it did not write', () => {
  it('leaves a source.mp4 from an earlier successful run intact', async () => {
    // The earlier draft unlinked `out` unconditionally in its catch, so a
    // failed download deleted a completed video from a previous call --
    // leaving that call's manifest pointing at nothing.
    const dir = mkdtempSync(join(tmpdir(), 'vem-prior-'));
    const prior = join(dir, 'source.mp4');
    const real = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-prior-src-')), 'v.mp4'), 1);
    writeFileSync(prior, readFileSync(real));
    const priorBytes = readFileSync(prior).length;

    // A transfer that dies mid-body: fetchToFile throws into the catch.
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '9000000' });
      res.write(Buffer.alloc(32_000, 1));
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const url: string = await new Promise((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const a = server!.address();
        resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/clip.mp4`);
      });
    });

    const r = await new DirectMediaResolver().resolve(url, { workDir: dir, returnVideo: true });
    expect(r.status).not.toBe('ok');                       // the new call failed
    expect(existsSync(prior)).toBe(true);                  // the old artifact survived
    expect(readFileSync(prior).length).toBe(priorBytes);   // byte-for-byte
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([]);
  }, 60_000);
});

describe('the direct resolver cleans up its own bytes', () => {
  it('discards its partial when the ffmpeg mux fails', async () => {
    // The mux failure return bypasses the catch, so it must clean up itself.
    const dir = mkdtempSync(join(tmpdir(), 'vem-muxfail-'));
    const body = Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\nnot-a-real-playlist\n');
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': String(body.length) });
      res.end(body);
    });
    const url: string = await new Promise((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const a = server!.address();
        resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/broken.m3u8`);
      });
    });
    const r = await new DirectMediaResolver().resolve(url, { workDir: dir, returnVideo: true });
    expect(r.status).not.toBe('ok');
    expect(readdirSync(dir)).toEqual([]);   // no partial, no anything
  }, 60_000);

  it('sweeps an abandoned partial on entry, before its own download', async () => {
    // The entry sweep in direct/wechat had no coverage: it could be deleted
    // outright with the whole suite green.
    const dir = mkdtempSync(join(tmpdir(), 'vem-directsweep-'));
    const orphan = join(dir, 'source.mp4.4242-9.part');
    writeFileSync(orphan, Buffer.alloc(500_000));
    const old = new Date(Date.now() - 24 * 60 * 60_000);
    utimesSync(orphan, old, old);

    const real = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-ds-src-')), 'v.mp4'), 1);
    const bytes = readFileSync(real);
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(bytes.length) });
      res.end(bytes);
    });
    const url: string = await new Promise((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const a = server!.address();
        resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/clip.mp4`);
      });
    });
    const r = await new DirectMediaResolver().resolve(url, { workDir: dir, returnVideo: true });
    expect(r.status).toBe('ok');
    expect(existsSync(orphan)).toBe(false);
    expect(readdirSync(dir)).toEqual(['source.mp4']);
  }, 60_000);
});
