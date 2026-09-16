import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join } from 'node:path';
import sharp from 'sharp';
import { fetchToFile } from '../util/download.js';
import { sweepModelFetchLitter } from '../transcript/fetchModels.js';

/**
 * SigLIP image embeddings on onnxruntime-web (WebAssembly), for machines where
 * the native onnxruntime cannot load.
 *
 * @huggingface/transformers' Node build imports onnxruntime-node statically,
 * so a missing or unloadable native binary takes the whole module down before
 * any backend can be chosen. That is not hypothetical: onnxruntime-node 1.24+
 * ships no Intel Mac binary at all, and its macOS 12 builds reference libc++
 * symbols that only exist from macOS 13 (reported in PR #5). Nothing here
 * touches transformers: the preprocessing is re-implemented below, and
 * tests/embedWasm.test.ts pins it pixel-for-pixel against transformers' own.
 *
 * Measured against the native path on the same images (2026-09-16, Apple
 * Silicon): cosine >= 0.995 per image, pairwise similarity within 0.01,
 * ~186 ms per image vs ~28 ms, ~630 MB peak RSS. Slower but equivalent, so
 * it is a fallback with a processing.warnings entry, never the default.
 */

export const SIGLIP_MODEL_ID = 'Xenova/siglip-base-patch16-224';
/** The dtype 'q8' file transformers loads for the native path. */
const MODEL_FILE = 'onnx/vision_model_quantized.onnx';
const HUB = 'https://huggingface.co';
const MODEL_FETCH_TIMEOUT_MS = 15 * 60_000;
/** SiglipImageProcessor for this model: 224x224, rescale 1/255, mean 0.5, std 0.5, bicubic. */
const SIZE = 224;

export interface PixelValues { data: Float32Array; dims: [1, 3, number, number] }

/**
 * The same sharp steps transformers' Node build performs: decode with EXIF
 * rotation, drop alpha without compositing, bicubic affine to 224x224 (skipped
 * when already that size), then rescale+normalize into CHW float32.
 */
export async function siglipPixelValues(path: string): Promise<PixelValues> {
  const decoded = await sharp(path).rotate().removeAlpha().toColourspace('srgb').raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = decoded.info;
  const { data, info } = width === SIZE && height === SIZE
    ? decoded
    : await sharp(decoded.data, { raw: { width, height, channels } })
      .affine([SIZE / width, 0, 0, SIZE / height], { interpolator: 'bicubic' })
      .raw().toBuffer({ resolveWithObject: true });
  if (info.width !== SIZE || info.height !== SIZE || info.channels !== 3) {
    throw new Error(`preprocessing produced ${info.width}x${info.height}x${info.channels}, expected ${SIZE}x${SIZE}x3`);
  }

  const plane = SIZE * SIZE;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = (data[i * 3 + c]! / 255 - 0.5) / 0.5;
  }
  return { data: out, dims: [1, 3, SIZE, SIZE] };
}

let counter = 0;

/**
 * Returns the local path of the quantized vision model, downloading it first
 * if needed. Uses transformers' own cache layout, so a machine that has run
 * the native path once already has the file, and vice versa. Downloaded under
 * a `.part-<pid>-<n>` name and renamed into place, the same convention as
 * src/transcript/fetchModels.ts, whose sweep also clears a dead process's
 * leftovers here.
 */
export async function ensureSiglipModel(cacheDir: string, hub: string = HUB): Promise<string> {
  // A relative directory would land in whatever cwd the server was started
  // from -- a 95 MB file in someone's project folder.
  if (!isAbsolute(cacheDir)) throw new Error(`model cache directory must be absolute, got '${cacheDir}'`);
  const target = join(cacheDir, SIGLIP_MODEL_ID, MODEL_FILE);
  if (existsSync(target)) return target;

  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  sweepModelFetchLitter(dir);
  // stderr, never stdout: the worker's stdout is its JSON result.
  process.stderr.write(`[video-extract] fetching the SigLIP vision model into ${dir}\n`);
  const part = join(dir, `.part-${process.pid}-${++counter}.${basename(MODEL_FILE)}`);
  try {
    const r = await fetchToFile(`${hub}/${SIGLIP_MODEL_ID}/resolve/main/${MODEL_FILE}`, part, { timeoutMs: MODEL_FETCH_TIMEOUT_MS });
    if (!r.ok) throw new Error(`downloading ${SIGLIP_MODEL_ID}/${MODEL_FILE} failed: HTTP ${r.status}`);
    renameSync(part, target);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  return target;
}

/**
 * transformers' own default cache directory (`<package root>/.cache`),
 * located WITHOUT importing the package -- importing it is exactly what fails
 * on the machines this module exists for.
 */
export function siglipCacheDir(): string {
  const entry = createRequire(import.meta.url).resolve('@huggingface/transformers');
  return join(dirname(dirname(entry)), '.cache');
}

/** Scales a vector to unit length: select.ts's cosine() is a plain dot product. */
export function l2normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/**
 * Pooled SigLIP embeddings for each path, in order. An image that fails gets
 * `[]` in its slot rather than being dropped, the same contract as the native
 * worker (see src/vision/embed.ts).
 */
export async function embedWithWasm(paths: string[], modelPath: string): Promise<number[][]> {
  // Loaded here, not at the top: the native path never needs it.
  const ort = await import('onnxruntime-web');
  const session = await ort.InferenceSession.create(readFileSync(modelPath), { executionProviders: ['wasm'] });
  try {
    const out: number[][] = [];
    for (const p of paths) {
      try {
        const { data, dims } = await siglipPixelValues(p);
        const res = await session.run({ pixel_values: new ort.Tensor('float32', data, dims) });
        const pooled = res['pooler_output'];
        if (!pooled) throw new Error('model returned no pooler_output');
        out.push(l2normalize(Array.from(pooled.data as Float32Array)));
      } catch {
        out.push([]);
      }
    }
    return out;
  } finally {
    await session.release();
  }
}
