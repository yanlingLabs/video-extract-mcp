import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../util/run.js';

export async function embedImages(paths: string[]): Promise<number[][]> {
  // Nothing to embed: return before touching the filesystem or spawning the
  // worker (tests/embed.test.ts asserts spawn() is never called for this case).
  if (paths.length === 0) return [];
  const here = dirname(fileURLToPath(import.meta.url));
  // Resolved relative to the RUNNING module, so this only exists once the
  // project is compiled: from dist/ the sibling is embedWorker.js, but from
  // src/ under tsx the sibling is embedWorker.ts and this lookup misses.
  // Any entry point must therefore run the compiled output -- `npm run cli`
  // builds first for exactly this reason. Getting it wrong is quiet rather
  // than loud: the spawn fails MODULE_NOT_FOUND, the stage degrades, and the
  // only trace is a processing.warnings entry, so the run still "succeeds"
  // with every embedding missing.
  const worker = join(here, 'embedWorker.js');
  const dir = mkdtempSync(join(tmpdir(), 'norma-embed-'));
  try {
    const listFile = join(dir, 'paths.json');
    writeFileSync(listFile, JSON.stringify(paths));

    // Separate process so the SigLIP model's memory is fully released on exit,
    // the same staged-worker strategy as src/transcript/asr.ts (spec §4): this
    // file must never import @huggingface/transformers directly.
    // label: final whole-branch review, Minor finding 5 -- see asr.ts's
    // identical comment.
    const r = await run(process.execPath, [worker, listFile], { timeoutMs: 20 * 60_000, label: 'embedWorker' });
    if (r.code !== 0) throw new Error(`embed worker failed: ${r.stderr.slice(-400)}`);
    return JSON.parse(r.stdout) as number[][];
  } finally {
    // Same convention as src/vision/ocr.ts's ocrBuffer(): clean up in a
    // finally so a non-zero worker exit or a JSON.parse throw above still
    // removes the temp directory -- those are exactly the paths that used to
    // leak it, since nothing after the throw would otherwise run.
    rmSync(dir, { recursive: true, force: true });
  }
}
