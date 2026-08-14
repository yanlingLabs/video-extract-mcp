#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalyzeOptions } from './types.js';
import { analyzeVideo } from './analyze.js';
import { runStatusCli } from './status/statusCli.js';
import { runCookiesCli } from './util/cookiesCli.js';
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
    // Final whole-branch review, Critical 1: process.exit() right after the
    // last console.log() raced stdout's own drain -- writes to a PIPE are
    // asynchronous in Node (unlike a file fd, which is synchronous), so the
    // process could exit having flushed only the first ~64KB (one pipe
    // buffer) of a larger payload, silently truncating it into invalid
    // JSON at exit code 0. The registry's own 500-item cap means an
    // at-capacity server's --json payload reliably exceeds 64KB on its own,
    // and the README sells --json for scripting, i.e. piping.
    //
    // Setting process.exitCode instead lets Node exit NATURALLY once every
    // queued write (stdout, and console.log's own) has actually drained --
    // Node will not end the process while output is still pending on a
    // stream. Nothing else in this command keeps the event loop open by the
    // time runStatusCli's returned promise settles: the non-watch path
    // (the only path that ever reaches here, since main() never returns
    // from the watch loop below) awaits a single renderOnce() and returns,
    // with no server, timer or socket left behind for this process to wait
    // on -- verified empirically against the compiled CLI with a payload
    // several times larger than one pipe buffer, piped (not redirected to a
    // file): the fixed process exits promptly with the complete payload
    // intact, not hung waiting on some other lingering handle.
    process.exitCode = await runStatusCli(process.argv.slice(3), (l) => console.log(l));
    return;
  }
  // Same subcommand treatment as 'status' above, and for the same reason: it
  // is not a url/path positional and must not reach parseArgs. Synchronous
  // and tiny (one file read at most), so the stdout-drain reasoning above
  // does not apply -- but exitCode is still set rather than process.exit()d,
  // to keep both subcommands exiting the same way.
  if (process.argv[2] === 'cookies') {
    process.exitCode = runCookiesCli(process.argv.slice(3), (l) => console.log(l));
    return;
  }
  const { url, opts } = parseArgs(process.argv.slice(2));
  if (!url) {
    console.error(
      'usage: video-extract <url|path> [--start S --end E] [--frames key|even|none]\n'
      + '                     [--max-frames N] [--lang zh] [--no-transcript] [--out DIR]\n\n'
      + '  --frames key   (default) the most informative frames, deduplicated\n'
      + '  --frames even  uniform sampling across the range; --max-frames sets density\n'
      + '  --frames none  no frames at all (transcript only)\n\n'
      + '  one exact frame:  --start 7 --end 7 --frames even --max-frames 1 --no-transcript\n\n'
      + 'subcommands:\n'
      + '  video-extract status    what this machine\'s servers are working on\n'
      + '  video-extract cookies   which domains your configured cookie jar covers',
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
