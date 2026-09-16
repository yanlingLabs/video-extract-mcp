import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';

// vi.mock is hoisted above these imports by vitest's transform, but the
// factory itself cannot close over a plain local `const` at that point --
// vi.hoisted runs even earlier so `spawnMock`/`runMock`/`capturedDirs` exist
// when the factories below execute.
const { spawnMock, runMock, capturedDirs } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  runMock: vi.fn(),
  capturedDirs: [] as string[],
}));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
// Only ../util/run.js is replaced -- embedImages's own fs calls (mkdtempSync,
// writeFileSync, rmSync) stay real, so the cleanup tests below exercise the
// genuine try/finally, not a mocked stand-in for it. Only the worker's
// outcome (exit code / stdout) is faked, so these run without the model or a
// build.
vi.mock('../src/util/run.js', () => ({ run: runMock }));
// Partial mock: spy on mkdtempSync's return value (to know exactly which
// directory this call created, for a race-free assertion) while every other
// node:fs export -- including the rmSync that actually deletes it -- stays
// the real implementation.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdtempSync: (...args: Parameters<typeof actual.mkdtempSync>) => {
      const dir = actual.mkdtempSync(...args);
      capturedDirs.push(dir);
      return dir;
    },
  };
});

describe('embedImages (unit -- no build or model required)', () => {
  it('returns [] for an empty input array without spawning a worker process', async () => {
    // Imports the SOURCE module directly (not dist/), so this test needs
    // neither `npm run build` nor the SigLIP model/network: embedImages([])
    // must short-circuit before ever calling run()/spawn(). A mutant that
    // deletes the `paths.length === 0` guard would reach spawn() here --
    // caught by the assertion below, not merely by "it happened not to
    // crash".
    const { embedImages } = await import('../src/vision/embed.js');
    const result = await embedImages([]);
    expect(result).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('embedImages temp-directory cleanup (unit -- real fs, mocked worker outcome)', () => {
  beforeEach(() => {
    capturedDirs.length = 0;
    runMock.mockReset();
  });

  it('removes its temp directory after a successful call', async () => {
    // Catches a deleted/missing finally block on the happy path: without it,
    // this assertion would find the directory still present.
    runMock.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ vectors: [[0.1, 0.2]], fallback: null }), stderr: '' });
    const { embedImages } = await import('../src/vision/embed.js');
    const result = await embedImages(['fake.jpg']);
    expect(result).toEqual([[0.1, 0.2]]);
    expect(capturedDirs).toHaveLength(1);
    expect(existsSync(capturedDirs[0]!)).toBe(false);
  });

  it('still removes its temp directory when the worker exits non-zero', async () => {
    // The exact leak the coordinator flagged as leaking most: a thrown Error
    // on a non-zero exit code used to skip straight past the (nonexistent)
    // cleanup code entirely.
    runMock.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'boom' });
    const { embedImages } = await import('../src/vision/embed.js');
    await expect(embedImages(['fake.jpg'])).rejects.toThrow('embed worker failed');
    expect(capturedDirs).toHaveLength(1);
    expect(existsSync(capturedDirs[0]!)).toBe(false);
  });

  it('still removes its temp directory when the worker prints malformed JSON', async () => {
    // The other leaking path the coordinator named: JSON.parse throwing on
    // r.stdout used to propagate straight out of embedImages with no cleanup.
    runMock.mockResolvedValueOnce({ code: 0, stdout: 'not valid json {{{', stderr: '' });
    const { embedImages } = await import('../src/vision/embed.js');
    await expect(embedImages(['fake.jpg'])).rejects.toThrow();
    expect(capturedDirs).toHaveLength(1);
    expect(existsSync(capturedDirs[0]!)).toBe(false);
  });
});

describe('embedImages runtime-fallback warning (unit -- mocked worker outcome)', () => {
  beforeEach(() => runMock.mockReset());

  it('records the worker\'s fallback reason as one warning and still returns its vectors', async () => {
    runMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify({ vectors: [[1, 0], []], fallback: "Cannot find module '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'" }),
      stderr: '',
    });
    const { embedImages } = await import('../src/vision/embed.js');
    const warnings: string[] = ['earlier warning'];
    const result = await embedImages(['a.jpg', 'b.jpg'], warnings);
    expect(result).toEqual([[1, 0], []]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toBe('earlier warning');
    expect(warnings[1]).toContain('WebAssembly');
    expect(warnings[1]).toContain("Cannot find module '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'");
  });

  it('records nothing when the native runtime was used', async () => {
    runMock.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ vectors: [[1, 0]], fallback: null }), stderr: '' });
    const { embedImages } = await import('../src/vision/embed.js');
    const warnings: string[] = [];
    await embedImages(['a.jpg'], warnings);
    expect(warnings).toEqual([]);
  });
});
