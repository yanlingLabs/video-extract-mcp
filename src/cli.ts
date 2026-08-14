#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalyzeOptions } from './types.js';
import { analyzeVideo } from './analyze.js';
import { runStatusCli } from './status/statusCli.js';
import { isMainModule } from './util/entry.js';

export function parseArgs(argv: string[]): { url: string; opts: AnalyzeOptions } {
  const url = argv[0] ?? '';
  const opts: AnalyzeOptions = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    // argv[++i] is undefined once no token remains -- distinct from a
    // deliberately-empty '' value, so a flag truncated at the end of argv
    // (a bare trailing `--start` with nothing after it) leaves the option
    // unset instead of silently coercing to 0 (Number('') === 0 is
    // indistinguishable from an explicit `--start 0`).
    const next = (): string | undefined => argv[++i];
    if (a === '--start') { const v = next(); if (v !== undefined) opts.start = Number(v); }
    else if (a === '--end') { const v = next(); if (v !== undefined) opts.end = Number(v); }
    else if (a === '--max-frames') { const v = next(); if (v !== undefined) opts.maxFrames = Number(v); }
    // Without this the CLI could never reach 'even': resolveFrameMode only
    // returns it for an explicit frames value, so a CLI limited to
    // --max-frames can produce 'key' (a budget) or 'none' (a zero budget)
    // and nothing else -- leaving uniform sampling and the single-frame
    // recipe unreachable from the command line. Validated rather than cast,
    // so a typo fails loudly instead of silently analyzing in 'key' mode.
    else if (a === '--frames') {
      const v = next();
      if (v !== undefined) {
        if (v !== 'key' && v !== 'even' && v !== 'none') {
          throw new Error(`--frames must be key, even or none (got ${JSON.stringify(v)})`);
        }
        opts.frames = v;
      }
    }
    else if (a === '--lang') { const v = next(); if (v !== undefined) opts.preferredLanguage = v; }
    else if (a === '--out') { const v = next(); if (v !== undefined) opts.outDir = v; }
    else if (a === '--no-transcript') opts.transcript = false;
  }
  return { url, opts };
}

async function main(): Promise<void> {
  // Task 6 (status-channel plan): dispatched BEFORE parseArgs -- 'status' is
  // a subcommand, not a url/path positional, and must never reach
  // parseArgs's own positional-argument handling below.
  if (process.argv[2] === 'status') {
    process.exit(await runStatusCli(process.argv.slice(3), (l) => console.log(l)));
  }
  const { url, opts } = parseArgs(process.argv.slice(2));
  if (!url) {
    console.error(
      'usage: video-extract <url|path> [--start S --end E] [--frames key|even|none]\n'
      + '                     [--max-frames N] [--lang zh] [--no-transcript] [--out DIR]\n\n'
      + '  --frames key   (default) the most informative frames, deduplicated\n'
      + '  --frames even  uniform sampling across the range; --max-frames sets density\n'
      + '  --frames none  no frames at all (transcript only)\n\n'
      + '  one exact frame:  --start 7 --end 7 --frames even --max-frames 1 --no-transcript',
    );
    process.exit(1);
  }
  const manifest = await analyzeVideo(url, opts);
  const json = JSON.stringify(manifest, null, 2);
  if (opts.outDir) writeFileSync(join(opts.outDir, 'manifest.json'), json);
  console.log(json);
}

// isMainModule realpaths BOTH sides (src/util/entry.ts): Node realpaths the
// main module while argv[1] stays as typed, so the previous pathToFileURL
// comparison -- itself a fix for percent-encoded spaces in this repo's own
// path -- still failed through any symlinked invocation path, exiting 0
// having silently done nothing. It still never fires when the test suite
// merely imports parseArgs.
if (isMainModule(import.meta.url)) void main();
