import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A mux that writes bytes and THEN fails is the one shape the real-ffmpeg
// tests cannot produce: ffmpeg exiting non-zero has generally written
// nothing, and ffmpeg that writes bytes exits 0 (it skips a bad segment).
// The reachable production path is run()'s own timeout SIGKILLing a mux
// mid-write -- src/util/run.ts returns code -1 for a signal-killed child --
// which a real test could only reach after a 15-minute wait. Mocking run()
// reproduces exactly that state in milliseconds.
vi.mock('../src/util/run.js', () => ({
  run: vi.fn(async (_cmd: string, args: string[]) => {
    const out = args[args.length - 1]!;          // ffmpeg's output path
    writeFileSync(out, Buffer.alloc(26_094, 7)); // a partially-muxed file
    return { stdout: '', stderr: 'killed', code: -1 };
  }),
}));

const { DirectMediaResolver } = await import('../src/resolve/direct.js');

describe('an ffmpeg mux that writes bytes and then fails', () => {
  beforeEach(() => vi.clearAllMocks());

  it('leaves nothing behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vem-muxkill-'));
    const r = await new DirectMediaResolver().resolve(
      'http://127.0.0.1:1/stream.m3u8', { workDir: dir, returnVideo: true },
    );
    expect(r.status).toBe('extractor_failed');
    expect(readdirSync(dir)).toEqual([]);   // the partially-muxed bytes are gone
  });
});
