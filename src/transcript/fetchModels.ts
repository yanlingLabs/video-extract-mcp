import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AsrEngine } from './routing.js';
import { fetchToFile } from '../util/download.js';
import { run } from '../util/run.js';

/**
 * Fetches the speech models on demand, the first time a video actually needs
 * local transcription.
 *
 * They were manual before: ~1.5 GB is too much to bundle, so an uncaptioned
 * video simply degraded to "asr failed" until someone ran a shell script.
 * That is a poor first experience, and the failure named a missing file
 * rather than a missing step.
 *
 * ## Only the engine that was chosen
 *
 * Whisper is 1.3 GB and SenseVoice is 233 MB, and a given call uses exactly
 * one of them (`chooseAsrEngine`). Fetching both would quintuple the download
 * for a Chinese video that will never touch Whisper.
 *
 * ## Presence is a SENTINEL FILE, never a directory
 *
 * The failure that prompted all of this reported a missing `small-tokens.txt`
 * inside a directory that existed. A half-extracted model directory is the
 * normal shape of an interrupted download, so "the directory is there" is
 * exactly the wrong question -- it reads a broken install as a finished one
 * and skips the repair. Every check here, before and after extracting, is
 * against the specific files the recognizer will open.
 *
 * ## Atomicity, following src/util/partials.ts
 *
 * The archive lands under a `.part` name and extracts into a private
 * `.extract-<pid>-<n>` directory; only after the sentinel is confirmed inside
 * it does one rename put it in place. `tar` exiting 0 on a truncated bzip2
 * stream is not something to rely on, and this ordering means a killed fetch
 * can never leave something under the final name that later runs will trust.
 */

const DEFAULT_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';

export const SENSEVOICE_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09';
export const WHISPER_DIR = 'sherpa-onnx-whisper-small';
const VAD_FILE = 'silero_vad.onnx';

/** Files the recognizer actually opens -- the only honest presence check. */
const SENTINELS: Record<AsrEngine, string[]> = {
  whisper: [
    join(WHISPER_DIR, 'small-tokens.txt'),
    join(WHISPER_DIR, 'small-encoder.int8.onnx'),
    join(WHISPER_DIR, 'small-decoder.int8.onnx'),
  ],
  sensevoice: [
    join(SENSEVOICE_DIR, 'tokens.txt'),
    join(SENSEVOICE_DIR, 'model.int8.onnx'),
  ],
};

const ARCHIVE_DIR: Record<AsrEngine, string> = {
  whisper: WHISPER_DIR,
  sensevoice: SENSEVOICE_DIR,
};

/** ~35 minutes: Whisper is 1.3 GB, and a slow connection is not a failure. */
const MODEL_FETCH_TIMEOUT_MS = 35 * 60_000;

const TEMP_RE = /^\.(?:part|extract)-(\d+)-\d+(?:\..*)?$/;
let counter = 0;

function baseUrl(env: NodeJS.ProcessEnv): string {
  return env['VIDEO_EXTRACT_MODELS_BASE_URL']?.trim() || DEFAULT_BASE;
}

/** Opt-out, for anyone who would rather pre-fetch or stay offline. */
export function autoFetchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env['VIDEO_EXTRACT_AUTO_FETCH_MODELS']?.trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no';
}

/** True when every file this engine will open is already on disk. */
export function modelsPresent(engine: AsrEngine, modelsDir: string): boolean {
  return [...SENTINELS[engine], VAD_FILE].every((rel) => existsSync(join(modelsDir, rel)));
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Removes archive and extraction litter from fetches whose process is gone.
 * Same instrument as src/agent/workdir.ts and for the same reason: these
 * names are minted by one call and held by nobody else, so a dead owner is a
 * complete answer and no age gate is needed. A live pid is always left alone.
 */
export function sweepModelFetchLitter(modelsDir: string): number {
  let removed = 0;
  let entries: string[];
  try { entries = readdirSync(modelsDir); } catch { return 0; }
  for (const name of entries) {
    const m = TEMP_RE.exec(name);
    if (!m || isAlive(Number(m[1]))) continue;
    try { rmSync(join(modelsDir, name), { recursive: true, force: true }); removed++; } catch { /* gone */ }
  }
  return removed;
}

/**
 * In-flight fetches, keyed by `modelsDir\0engine`.
 *
 * Up to VIDEO_EXTRACT_MAX_CONCURRENCY analyses share one process, and two of
 * them hitting an uncaptioned video at once must not both pull 1.3 GB. Across
 * SEPARATE processes duplication is accepted rather than locked against: a
 * lock file introduces a stale-lock problem of exactly the kind
 * src/util/partials.ts exists to avoid, and the cost here is bounded --
 * unique temp names mean the two downloads cannot corrupt each other, and the
 * loser's rename simply lands on identical content.
 */
const inFlight = new Map<string, Promise<void>>();

export async function ensureAsrModels(
  engine: AsrEngine, modelsDir: string, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (modelsPresent(engine, modelsDir)) return;
  if (!autoFetchEnabled(env)) {
    throw new Error(
      `speech models for '${engine}' are not installed in ${modelsDir}, and automatic fetching is `
      + 'disabled (VIDEO_EXTRACT_AUTO_FETCH_MODELS). Run scripts/fetch-models.sh, or set '
      + 'VIDEO_EXTRACT_MODELS_DIR to a directory that has them.',
    );
  }
  const key = `${modelsDir}\0${engine}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const p = (async () => {
    mkdirSync(modelsDir, { recursive: true });
    sweepModelFetchLitter(modelsDir);
    // stderr, never stdout: this process may be speaking JSON-RPC over stdio,
    // and a 1.3 GB download with no sign of life reads as a hang.
    process.stderr.write(
      `[video-extract] fetching ${engine} speech model into ${modelsDir} (first uncaptioned video only)\n`,
    );
    if (!existsSync(join(modelsDir, VAD_FILE))) {
      await fetchOne(`${baseUrl(env)}/${VAD_FILE}`, modelsDir, VAD_FILE);
    }
    if (!SENTINELS[engine].every((rel) => existsSync(join(modelsDir, rel)))) {
      await fetchArchive(engine, modelsDir, env);
    }
    if (!modelsPresent(engine, modelsDir)) {
      throw new Error(`speech model fetch completed but ${modelsDir} is still missing required files`);
    }
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, p);
  return p;
}

/** A single loose file: download beside its target, then rename into place. */
async function fetchOne(url: string, modelsDir: string, finalName: string): Promise<void> {
  const part = join(modelsDir, `.part-${process.pid}-${++counter}.${finalName}`);
  const r = await fetchToFile(url, part, { timeoutMs: MODEL_FETCH_TIMEOUT_MS });
  if (!r.ok) {
    rmSync(part, { force: true });
    throw new Error(`downloading ${finalName} failed: HTTP ${r.status}`);
  }
  renameSync(part, join(modelsDir, finalName));
}

/** A tar.bz2 model directory: download, extract privately, verify, then rename. */
async function fetchArchive(engine: AsrEngine, modelsDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const dirName = ARCHIVE_DIR[engine];
  const n = ++counter;
  const part = join(modelsDir, `.part-${process.pid}-${n}.${dirName}.tar.bz2`);
  const stage = join(modelsDir, `.extract-${process.pid}-${n}`);

  try {
    const r = await fetchToFile(`${baseUrl(env)}/${dirName}.tar.bz2`, part, { timeoutMs: MODEL_FETCH_TIMEOUT_MS });
    if (!r.ok) throw new Error(`downloading ${dirName} failed: HTTP ${r.status}`);

    mkdirSync(stage, { recursive: true });
    // Extracted through `tar` rather than a JS library: bzip2 has no decoder
    // in Node's standard library, and tar is already a hard requirement of
    // every platform this runs on. -C keeps the working directory out of it.
    const t = await run('tar', ['xjf', part, '-C', stage], { timeoutMs: MODEL_FETCH_TIMEOUT_MS });
    if (t.code !== 0) throw new Error(`extracting ${dirName} failed: ${t.stderr.slice(-200).trim()}`);

    // Verified INSIDE the staging directory, before anything is published
    // under the final name. This is the check that a truncated archive fails
    // even when tar exits 0.
    const extracted = join(stage, dirName);
    const missing = SENTINELS[engine]
      .map((rel) => rel.slice(dirName.length + 1))
      .filter((f) => !existsSync(join(extracted, f)));
    if (missing.length > 0) {
      throw new Error(`extracted ${dirName} is incomplete; missing ${missing.join(', ')}`);
    }

    const final = join(modelsDir, dirName);
    // Yield only to a COMPLETE directory, never merely an existing one.
    //
    // A concurrent process may genuinely have finished first, and its content
    // is identical, so discarding ours is the courteous move -- but the same
    // path is also what a half-installed model looks like, which is the exact
    // state this feature exists to repair (the failure that prompted it was a
    // missing small-tokens.txt inside a directory that existed). Keying on
    // existence made the repair skip itself; a test caught it on the first
    // run.
    if (SENTINELS[engine].every((rel) => existsSync(join(modelsDir, rel)))) return;
    rmSync(final, { recursive: true, force: true });
    renameSync(extracted, final);
  } finally {
    rmSync(part, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
}
