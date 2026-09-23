import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isMainModule } from '../src/util/entry.js';

const pexec = promisify(execFile);

export interface BinaryStatus {
  name: string;
  present: boolean;
  version: string | null;
  ok: boolean;
  note?: string;
}

export interface ParsedVersion {
  version: string | null;
  matched: boolean;
}

export function parseVersion(raw: string): ParsedVersion {
  const m = raw.match(/\d+(?:\.\d+)+/);
  return m ? { version: m[0], matched: true } : { version: null, matched: false };
}

export async function checkBinary(
  name: string,
  versionArg = '--version'
): Promise<BinaryStatus> {
  try {
    const { stdout } = await pexec(name, [versionArg]);
    const parsed = parseVersion(stdout);
    return { name, present: true, version: parsed.version, ok: parsed.matched };
  } catch (err: unknown) {
    // Some binaries (like ffmpeg) output version to stderr, not stdout.
    // Check if we have stderr content from the error.
    if (
      err &&
      typeof err === 'object' &&
      'stderr' in err &&
      typeof err.stderr === 'string' &&
      err.stderr.length > 0
    ) {
      const parsed = parseVersion(err.stderr);
      // Binary was found and ran (produced stderr), but mark ok only if version pattern matched
      return { name, present: true, version: parsed.version, ok: parsed.matched, note: parsed.matched ? undefined : 'found but broken or incompatible' };
    }
    return { name, present: false, version: null, ok: false, note: 'not found on PATH' };
  }
}

const REQUIRED = ['ffmpeg', 'ffprobe', 'yt-dlp', 'tesseract'];

export async function main(): Promise<void> {
  const results = await Promise.all(REQUIRED.map((b) => checkBinary(b)));
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'MISS'} ${r.name} ${r.version ?? ''}`);

  // yt-dlp staleness: releases are date-versioned; anything older than ~3 months
  // routinely fails on current YouTube.
  const ytdlp = results.find((r) => r.name === 'yt-dlp');
  if (ytdlp?.version && ytdlp.version < '2026.06.00') {
    const upgrade = process.platform === 'darwin' ? 'brew upgrade yt-dlp'
      : process.platform === 'win32' ? 'winget upgrade yt-dlp.yt-dlp' : 'yt-dlp -U';
    console.warn(`\nyt-dlp ${ytdlp.version} is stale -> run: ${upgrade}`);
  }

  const { stdout: langs } = await pexec('tesseract', ['--list-langs']).catch(() => ({
    stdout: '',
  }));
  if (!langs.includes('chi_sim')) {
    const add = process.platform === 'darwin' ? 'run: brew install tesseract-lang'
      : 'see INSTALL.md for your platform';
    console.warn(`tesseract lacks chi_sim (needed for WeChat OCR) -> ${add}`);
  }

  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

// isMainModule realpaths both sides -- robust to the percent-encoded space
// in this repo's own path AND to symlinked invocation paths (see
// src/util/entry.ts).
if (isMainModule(import.meta.url)) void main();
