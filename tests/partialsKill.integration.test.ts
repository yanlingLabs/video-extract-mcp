import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync, existsSync, utimesSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { YtDlpResolver } from '../src/resolve/ytdlp.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';

/**
 * Partial-download hygiene, against the two failure shapes that actually
 * produce orphaned bytes. Deliberately NOT tested by an in-process resolve
 * against a truncating origin: that makes fetchToFile throw, the resolver's
 * own catch runs, and the directory ends up clean either way -- such a test
 * passes identically against the pre-fix code and proves nothing.
 */
let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

/** Serves a body forever, slowly, so a download is genuinely in flight. */
function endlessOrigin(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '900000000' });
      const t = setInterval(() => { if (!res.write(Buffer.alloc(64_000, 1))) { /* backpressure */ } }, 20);
      res.on('close', () => clearInterval(t));
    });
    server.listen(0, '127.0.0.1', () => {
      const a = server!.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/clip.mp4`);
    });
  });
}

describe('partial hygiene: the process is killed mid-download', () => {
  it('leaves a recognisably-incomplete .part, never a truncated source.mp4', async () => {
    // The crash / power-loss / killed-server shape: NONE of our cleanup code
    // runs, so the only protection is the name the bytes were written under.
    // Must be a real subprocess -- killing this process would kill the test.
    const dir = mkdtempSync(join(tmpdir(), 'vem-hardkill-'));
    const url = await endlessOrigin();
    const driver = join(dir, 'driver.mjs');
    writeFileSync(driver, `
      import { DirectMediaResolver } from ${JSON.stringify(join(process.cwd(), 'dist/resolve/direct.js'))};
      await new DirectMediaResolver().resolve(${JSON.stringify(url)}, { workDir: ${JSON.stringify(dir)}, returnVideo: true });
    `);
    const dl = spawn(process.execPath, [driver], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 900));   // let real bytes land
    dl.kill('SIGKILL');
    await new Promise((r) => dl.on('exit', r));

    const left = readdirSync(dir).filter((f) => f.startsWith('source'));
    expect(left.length).toBeGreaterThan(0);                    // bytes really did land
    expect(left.every((f) => f.endsWith('.part'))).toBe(true); // and every one is marked incomplete
    expect(left).not.toContain('source.mp4');                  // never a fake finished file
  }, 30_000);
});

describe('partial hygiene: a failed yt-dlp download', () => {
  it('leaves its bytes for the age-gated sweep rather than risking a sibling\'s', async () => {
    // Deliberately NOT cleaned immediately. yt-dlp picks its own filenames,
    // so two calls into one directory produce the same names and nothing --
    // not an exact path, not a before/after snapshot -- can tell our
    // abandoned bytes from a concurrent call's live ones. An earlier draft
    // tried and destroyed 2.4MB of a running download.
    const dir = mkdtempSync(join(tmpdir(), 'vem-ytfail-'));
    const binDir = mkdtempSync(join(tmpdir(), 'vem-bin-'));
    const fake = join(binDir, 'yt-dlp');
    writeFileSync(fake, `#!/bin/sh\nprintf 'x' > "${dir}/source.mp4.part"\nexit 137\n`);
    chmodSync(fake, 0o755);
    const prev = process.env.PATH;
    process.env.PATH = `${binDir}:${prev ?? ''}`;
    try {
      const r = await new YtDlpResolver().resolve('https://example.invalid/v', { workDir: dir, returnVideo: true });
      expect(r.status).not.toBe('ok');
      // Recognisably incomplete, and nothing under a finished name.
      expect(readdirSync(dir)).toEqual(['source.mp4.part']);
    } finally { process.env.PATH = prev; }
  }, 30_000);

  it('never leaves a concurrent call\'s live partial worse off', async () => {
    // The harm an earlier draft caused, pinned so it cannot come back.
    const dir = mkdtempSync(join(tmpdir(), 'vem-sibling-'));
    const siblingLive = join(dir, 'source.mp4.99999-7.part');
    writeFileSync(siblingLive, Buffer.alloc(2_368_000));   // another call, mid-download
    const binDir = mkdtempSync(join(tmpdir(), 'vem-bin3-'));
    const fake = join(binDir, 'yt-dlp');
    writeFileSync(fake, '#!/bin/sh\nexit 137\n');
    chmodSync(fake, 0o755);
    const prev = process.env.PATH;
    process.env.PATH = `${binDir}:${prev ?? ''}`;
    try {
      await new YtDlpResolver().resolve('https://example.invalid/v', { workDir: dir, returnVideo: true });
      expect(existsSync(siblingLive)).toBe(true);
      expect(statSync(siblingLive).size).toBe(2_368_000);   // byte-for-byte
    } finally { process.env.PATH = prev; }
  }, 30_000);
});

describe('partial hygiene: an abandoned partial from a previous boot', () => {
  it('is swept by the next download into that directory, even when that download SUCCEEDS', async () => {
    // Deliberately a succeeding download. With a failing one the
    // abandon-on-failure sweep also removes the orphan, so the test would
    // pass with the pre-download sweep deleted -- proving nothing about the
    // reboot path it claims to cover.
    const dir = mkdtempSync(join(tmpdir(), 'vem-reboot-'));
    const orphan = join(dir, 'source.mp4.part');
    writeFileSync(orphan, Buffer.alloc(1_000_000));
    const old = new Date(Date.now() - 24 * 60 * 60_000);
    utimesSync(orphan, old, old);

    const realVideo = await makeTestVideo(join(mkdtempSync(join(tmpdir(), 'vem-src-')), 'v.mp4'), 2);
    const binDir = mkdtempSync(join(tmpdir(), 'vem-bin2-'));
    const fake = join(binDir, 'yt-dlp');
    writeFileSync(fake, `#!/bin/sh\ncp "${realVideo}" "${dir}/source.mp4"\necho '{"title":"t","duration":2}'\nexit 0\n`);
    chmodSync(fake, 0o755);
    const prev = process.env.PATH;
    process.env.PATH = `${binDir}:${prev ?? ''}`;
    try {
      const r = await new YtDlpResolver().resolve('https://example.invalid/v', { workDir: dir, returnVideo: true });
      expect(r.status).toBe('ok');                    // the download really did succeed
      expect(existsSync(join(dir, 'source.mp4'))).toBe(true);  // and its artifact is untouched
      expect(existsSync(orphan)).toBe(false);         // only the stale orphan went
    } finally { process.env.PATH = prev; }
  }, 60_000);
});
