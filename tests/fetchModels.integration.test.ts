import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  ensureAsrModels, modelsPresent, autoFetchEnabled, sweepModelFetchLitter,
  WHISPER_DIR, SENSEVOICE_DIR,
} from '../src/transcript/fetchModels.js';

/**
 * The speech models are fetched on demand, the first time a video actually
 * needs local transcription.
 *
 * Served here by a local fake of the release host, so these tests never touch
 * the network and never move 1.5 GB. What they assert is the shape that
 * matters: WHICH archive was requested, that a broken one is never published
 * under its final name, and that an already-installed set costs nothing.
 */

let server: Server | null = null;
let requested: string[] = [];
const prevEnv: Record<string, string | undefined> = {};

afterEach(() => {
  server?.close(); server = null; requested = [];
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
    delete prevEnv[k];
  }
});

function setEnv(k: string, v: string | undefined): void {
  if (!(k in prevEnv)) prevEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}

/** A real .tar.bz2 containing the files that engine's recognizer opens. */
function makeArchive(dirName: string, files: string[], truncate = false): Buffer {
  const build = mkdtempSync(join(tmpdir(), 'vem-arc-'));
  mkdirSync(join(build, dirName), { recursive: true });
  for (const f of files) writeFileSync(join(build, dirName, f), `contents of ${f}\n`);
  const out = join(build, 'a.tar.bz2');
  execFileSync('tar', ['cjf', out, '-C', build, dirName]);
  const buf = readFileSync(out);
  return truncate ? buf.subarray(0, Math.floor(buf.length / 2)) : buf;
}

const WHISPER_FILES = ['small-tokens.txt', 'small-encoder.int8.onnx', 'small-decoder.int8.onnx'];
const SENSEVOICE_FILES = ['tokens.txt', 'model.int8.onnx'];

/** Stands in for the release host; records every path it is asked for. */
async function fakeRelease(opts: { truncate?: boolean; omit?: string } = {}): Promise<string> {
  const whisperFiles = opts.omit ? WHISPER_FILES.filter((f) => f !== opts.omit) : WHISPER_FILES;
  const whisper = makeArchive(WHISPER_DIR, whisperFiles, opts.truncate);
  const sense = makeArchive(SENSEVOICE_DIR, SENSEVOICE_FILES, opts.truncate);
  server = createServer((req, res) => {
    const url = req.url ?? '';
    requested.push(url);
    const body = url.includes(WHISPER_DIR) ? whisper
      : url.includes(SENSEVOICE_DIR) ? sense
        : url.endsWith('silero_vad.onnx') ? Buffer.from('vad-model-bytes')
          : null;
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const a = server!.address();
      const base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
      setEnv('VIDEO_EXTRACT_MODELS_BASE_URL', base);
      resolve(base);
    });
  });
}

const freshDir = (): string => join(mkdtempSync(join(tmpdir(), 'vem-models-')), 'models');

describe('fetching on demand', () => {
  it('downloads the models a machine does not have, then reports them present', async () => {
    await fakeRelease();
    const dir = freshDir();
    expect(modelsPresent('whisper', dir)).toBe(false);

    await ensureAsrModels('whisper', dir);

    expect(modelsPresent('whisper', dir)).toBe(true);
    for (const f of WHISPER_FILES) expect(existsSync(join(dir, WHISPER_DIR, f))).toBe(true);
    expect(existsSync(join(dir, 'silero_vad.onnx'))).toBe(true);
  }, 60_000);

  it('fetches ONLY the engine that was chosen', async () => {
    // Whisper is 1.3 GB and SenseVoice 233 MB; a Chinese video must never pay
    // for a model it will not load.
    await fakeRelease();
    const dir = freshDir();
    await ensureAsrModels('sensevoice', dir);

    expect(requested.some((u) => u.includes(SENSEVOICE_DIR))).toBe(true);
    expect(requested.some((u) => u.includes(WHISPER_DIR))).toBe(false);
    expect(existsSync(join(dir, WHISPER_DIR))).toBe(false);
  }, 60_000);

  it('costs nothing when the models are already installed', async () => {
    await fakeRelease();
    const dir = freshDir();
    await ensureAsrModels('sensevoice', dir);
    const afterFirst = requested.length;
    expect(afterFirst).toBeGreaterThan(0);

    await ensureAsrModels('sensevoice', dir);

    // Not one further request: this runs on every uncaptioned video.
    expect(requested.length).toBe(afterFirst);
  }, 60_000);

  it('does not re-fetch just because a directory exists -- it checks the FILES', async () => {
    // The failure that prompted this feature was a missing small-tokens.txt
    // inside a directory that existed. A directory-presence check reads a
    // half-installed model as finished and skips the repair.
    await fakeRelease();
    const dir = freshDir();
    mkdirSync(join(dir, WHISPER_DIR), { recursive: true });
    writeFileSync(join(dir, WHISPER_DIR, 'small-encoder.int8.onnx'), 'partial');

    expect(modelsPresent('whisper', dir)).toBe(false);
    await ensureAsrModels('whisper', dir);
    expect(modelsPresent('whisper', dir)).toBe(true);
  }, 60_000);
});

describe('a fetch that goes wrong', () => {
  it('never publishes a truncated archive under the final name', async () => {
    await fakeRelease({ truncate: true });
    const dir = freshDir();

    await expect(ensureAsrModels('whisper', dir)).rejects.toThrow();

    // The model directory must be ABSENT, not present-and-broken: a later run
    // has to be able to tell it never arrived.
    expect(existsSync(join(dir, WHISPER_DIR))).toBe(false);
    expect(modelsPresent('whisper', dir)).toBe(false);
  }, 60_000);

  it('rejects an archive that extracts CLEANLY but is missing a model file', async () => {
    // The truncated case is caught by tar exiting non-zero, so it does not
    // exercise the check that matters most: a well-formed archive whose
    // contents are wrong. That is the shape a re-packaged or partially
    // uploaded release takes, and the shape the original failure had -- a
    // directory present, small-tokens.txt absent.
    await fakeRelease({ omit: 'small-tokens.txt' });
    const dir = freshDir();

    await expect(ensureAsrModels('whisper', dir)).rejects.toThrow(/incomplete|missing/i);

    // Nothing may be published under the final name, or the next run trusts it.
    expect(existsSync(join(dir, WHISPER_DIR))).toBe(false);
    expect(modelsPresent('whisper', dir)).toBe(false);
  }, 60_000);

  it('leaves no archive or extraction litter behind', async () => {
    await fakeRelease({ truncate: true });
    const dir = freshDir();
    await ensureAsrModels('whisper', dir).catch(() => {});
    expect(readdirSync(dir).filter((n) => n.startsWith('.part') || n.startsWith('.extract'))).toEqual([]);
  }, 60_000);

  it('fails with an actionable message when auto-fetch is switched off', async () => {
    setEnv('VIDEO_EXTRACT_AUTO_FETCH_MODELS', '0');
    expect(autoFetchEnabled(process.env)).toBe(false);
    const dir = freshDir();
    await expect(ensureAsrModels('whisper', dir)).rejects.toThrow(/VIDEO_EXTRACT_AUTO_FETCH_MODELS/);
  }, 30_000);
});

describe('two analyses needing the same model at once', () => {
  it('downloads it once, not once per caller', async () => {
    // Up to VIDEO_EXTRACT_MAX_CONCURRENCY analyses share one process. Without
    // the in-flight memo, two uncaptioned videos starting together each pull
    // the full model -- 2.6 GB for one 1.3 GB result.
    await fakeRelease();
    const dir = freshDir();

    await Promise.all([
      ensureAsrModels('whisper', dir),
      ensureAsrModels('whisper', dir),
      ensureAsrModels('whisper', dir),
    ]);

    expect(requested.filter((u) => u.includes(WHISPER_DIR)).length).toBe(1);
    expect(modelsPresent('whisper', dir)).toBe(true);
  }, 60_000);
});

describe('litter from a killed fetch', () => {
  it('is swept when its process is gone, and spared while it lives', async () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid!;

    const abandoned = join(dir, `.extract-${dead}-1`);
    const abandonedPart = join(dir, `.part-${dead}-2.thing.tar.bz2`);
    const live = join(dir, `.extract-${process.pid}-1`);
    const notOurs = join(dir, 'models-backup');
    mkdirSync(abandoned, { recursive: true });
    writeFileSync(abandonedPart, 'x');
    mkdirSync(live, { recursive: true });
    mkdirSync(notOurs, { recursive: true });

    expect(sweepModelFetchLitter(dir)).toBe(2);
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(abandonedPart)).toBe(false);
    // A live owner's staging directory is another fetch in flight.
    expect(existsSync(live)).toBe(true);
    expect(existsSync(notOurs)).toBe(true);
  }, 30_000);
});

describe('the pipeline actually asks for the models', () => {
  it('surfaces the fetch failure as the ASR warning, not sherpa\'s missing-file error', async () => {
    // Proves the wiring, cheaply and without downloading anything: with
    // auto-fetch off, ensureAsrModels refuses immediately, and that refusal
    // must be what reaches processing.warnings. Remove the call from
    // analyze.ts and the warning reverts to sherpa's "tokens ... does not
    // exist", which names a file instead of the missing step.
    const { analyzeVideo } = await import('../src/analyze.js');
    const { makeTestVideo } = await import('../src/media/ffmpeg.js');

    setEnv('VIDEO_EXTRACT_AUTO_FETCH_MODELS', '0');
    setEnv('VIDEO_EXTRACT_MODELS_DIR', freshDir());

    // A local file has no captions, so the transcript stage must fall to ASR.
    const src = mkdtempSync(join(tmpdir(), 'vem-wire-'));
    const video = await makeTestVideo(join(src, 'v.mp4'), 1);

    const m = await analyzeVideo(video, { frames: 'none', outDir: mkdtempSync(join(tmpdir(), 'vem-wireout-')) });

    expect(m.source.status).toBe('ok');            // degrades, never fails the call
    expect(m.transcript).toBeNull();
    const asr = m.processing.warnings.find((w) => w.startsWith('asr failed'));
    expect(asr).toBeDefined();
    expect(asr).toMatch(/VIDEO_EXTRACT_AUTO_FETCH_MODELS/);
  }, 120_000);
});
