import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync, existsSync, utimesSync, chmodSync } from 'node:fs';
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

describe('partial hygiene: a child process is killed (the documented stop-a-job workflow)', () => {
  it('removes the abandoned partial as soon as the download reports failure', async () => {
    // Here the SERVER survives -- only yt-dlp died -- so our code does run,
    // and leaving the partial for six hours would be pure litter.
    const dir = mkdtempSync(join(tmpdir(), 'vem-childkill-'));
    const binDir = mkdtempSync(join(tmpdir(), 'vem-bin-'));
    const fake = join(binDir, 'yt-dlp');
    writeFileSync(fake, `#!/bin/sh\nprintf 'x' > "${dir}/source.mp4.part"\nexit 137\n`);  // 137 = SIGKILLed
    chmodSync(fake, 0o755);

    const prev = process.env.PATH;
    process.env.PATH = `${binDir}:${prev ?? ''}`;
    try {
      const r = await new YtDlpResolver().resolve('https://example.invalid/v', { workDir: dir, returnVideo: true });
      expect(r.status).not.toBe('ok');
      expect(existsSync(join(dir, 'source.mp4.part'))).toBe(false);
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
