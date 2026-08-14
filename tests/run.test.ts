import { describe, it, expect } from 'vitest';
import { basename } from 'node:path';
import { run } from '../src/util/run.js';
import { runWithStatus } from '../src/status/context.js';

describe('run', () => {
  it('captures stdout and a zero exit code', async () => {
    const r = await run('echo', ['hello']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('hello');
  });
  it('does not throw on non-zero exit; reports the code', async () => {
    const r = await run('sh', ['-c', 'exit 3']);
    expect(r.code).toBe(3);
  });
  it('rejects on spawn error when binary does not exist', async () => {
    await expect(run('definitely-not-a-real-binary-xyz', [])).rejects.toThrow();
  });
  it('handles multi-byte UTF-8 correctly across chunk boundaries', async () => {
    // Emit 120,000 bytes of CJK text to force chunk boundaries at exactly 65,536 bytes.
    // At this size, data arrives as 2 chunks with the split landing mid-character.
    // This payload will produce U+FFFD replacement characters if decoded as separate chunks.
    const cjkText = '你好世界'.repeat(10000);
    const r = await run('echo', [cjkText]);
    expect(r.code).toBe(0);
    // Verify no replacement characters from botched UTF-8 decoding
    expect(r.stdout).not.toContain('�');
    // Verify the output contains the expected text (accounting for echo adding newline)
    expect(r.stdout.trim()).toBe(cjkText);
  });

  it('reports a caller-supplied label via onSpawn instead of the raw command (final review, Minor 5)', async () => {
    // README:255's sample render shows `· asrWorker pid 4122`, but
    // src/transcript/asr.ts and src/vision/embed.ts both spawn via
    // run(process.execPath, [worker, ...]) -- without this, the reported
    // command is the node binary path, not a worker name the README (or
    // anyone reading /status) can recognize. opts.label lets a call site
    // report a semantic name while still spawning the real executable.
    const events: string[] = [];
    await runWithStatus(
      { onSpawn: (_pid, cmd) => events.push(cmd) },
      () => run(process.execPath, ['-e', '""'], { label: 'asrWorker' }),
    );
    expect(events).toEqual(['asrWorker']);
  });

  it('basenames an absolute-path command when no label is given, so a full interpreter/binary path never leaks into status', async () => {
    // Every OTHER run() call site in this codebase already passes a bare
    // command name (yt-dlp, ffmpeg, ffprobe, tesseract) that spawn()
    // resolves via PATH -- basename() is a no-op for those. This is the
    // general fallback for any call site (present or future) that, like
    // asr.ts/embed.ts before their own label was added, passes an absolute
    // path without a label.
    const events: string[] = [];
    await runWithStatus(
      { onSpawn: (_pid, cmd) => events.push(cmd) },
      () => run(process.execPath, ['-e', '""']),
    );
    expect(events).toEqual([basename(process.execPath)]);
  });
});
