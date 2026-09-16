import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EmbedWorkerOutput } from './embed.js';
import { SIGLIP_MODEL_ID as MODEL_ID, embedWithWasm, ensureSiglipModel, l2normalize, siglipCacheDir } from './embedWasm.js';

async function main(): Promise<void> {
  const listFile = process.argv[2];
  if (!listFile) throw new Error('usage: embedWorker <jsonPathsFile>');
  const paths = JSON.parse(readFileSync(listFile, 'utf8')) as string[];

  // Imported dynamically so a native runtime that cannot load (no binary for
  // this platform, or one built for a newer OS) lands here instead of killing
  // the worker: @huggingface/transformers imports onnxruntime-node at the top
  // of its Node build. Only the import is guarded -- a model download or
  // inference failure on a working native runtime is not a reason to switch.
  let tf: typeof import('@huggingface/transformers');
  try {
    tf = await import('@huggingface/transformers');
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).split('\n')[0]!;
    const vectors = await embedWithWasm(paths, await ensureSiglipModel(siglipCacheDir()));
    write({ vectors, fallback: reason });
    return;
  }
  const { SiglipVisionModel, AutoProcessor, RawImage } = tf;

  const processor = await AutoProcessor.from_pretrained(MODEL_ID);
  // MUST be the vision tower read via pooler_output: pipeline('image-feature-extraction')
  // returns the UN-POOLED per-patch hidden state instead (a 14x14=196 patch
  // grid x 768 dims = 150528 values -- confirmed directly: SiglipVisionModel's
  // own res.last_hidden_state has dims [1, 196, 768]), not the pooled 768-dim
  // embedding. Similarity computed over it is dominated by low-level patch
  // statistics, not the pooled semantic representation -- a silent,
  // plausible-looking failure. See task-12-brief.md's "THE TRAP".
  // tests/embed.integration.test.ts asserts the 768-dim output specifically
  // to guard against this regression.
  const model = await SiglipVisionModel.from_pretrained(MODEL_ID, { dtype: 'q8' });

  const out: number[][] = [];
  for (const p of paths) {
    try {
      const inputs = await processor(await RawImage.read(p));
      const res = await model(inputs);
      const tensor = res.pooler_output ?? res.last_hidden_state;
      // L2-normalize: src/vision/select.ts's cosine() is a plain dot product,
      // not a true cosine -- it assumes both operands already are unit
      // vectors.
      out.push(l2normalize(Array.from(tensor.data as Float32Array)));
    } catch {
      out.push([]); // keep index alignment with the input list
    }
  }
  write({ vectors: out, fallback: null });
}

function write(result: EmbedWorkerOutput): void {
  process.stdout.write(JSON.stringify(result));
}

// ESM "is this the entry module" guard: only auto-run main() when this file
// is executed directly as `node embedWorker.js <jsonPathsFile>` (the worker
// CLI contract embed.ts's embedImages() spawns) -- not when it is imported as
// a module. Mirrors src/transcript/asrWorker.ts's identical guard, added
// there (Task 11 review, addendum A3) after its absence was found to run
// main() against the importer's own process.argv and call process.exit(1) on
// the resulting usage error, killing whatever process did the importing.
// Nothing in this codebase currently imports embedWorker.ts as a module --
// unlike asrWorker.ts's exported runVad, there is no pure helper here for a
// test to exercise in isolation -- so this guard is a defensive/consistency
// addition, not a fix for an active bug.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
}
