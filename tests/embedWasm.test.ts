import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import sharp from 'sharp';
import { siglipPixelValues, ensureSiglipModel, embedWithWasm, siglipCacheDir } from '../src/vision/embedWasm.js';

/**
 * The WebAssembly fallback re-implements SigLIP's image preprocessing, because
 * the only code that does it today lives in @huggingface/transformers' Node
 * build -- the very build that cannot load on a machine without a native
 * onnxruntime. So the reference here is transformers itself, run on a machine
 * where it does load: any drift (kernel, mean/std, channel order, EXIF,
 * alpha, greyscale) shows up as a pixel difference, not as a vague
 * "embeddings look a bit off" later.
 */

const MODEL_ID = 'Xenova/siglip-base-patch16-224';
let dir: string;
const images: Record<string, string> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vem-wasm-pre-'));
  const noise = (width: number, height: number, channels: 3 | 4) =>
    sharp({ create: { width, height, channels, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 70 } } });
  images.landscape = join(dir, 'landscape.jpg');
  await noise(640, 360, 3).jpeg().toFile(images.landscape);
  // Stored 300x500 but tagged "rotate 90": the displayed image is 500x300.
  images.exifRotated = join(dir, 'exif-rotated.jpg');
  await noise(300, 500, 3).withMetadata({ orientation: 6 }).jpeg().toFile(images.exifRotated);
  images.alpha = join(dir, 'alpha.png');
  await noise(320, 240, 4).png().toFile(images.alpha);
  images.grey = join(dir, 'grey.png');
  await noise(256, 256, 3).greyscale().png().toFile(images.grey);
  // Already 224x224: the resize is skipped on both sides.
  images.exact = join(dir, 'exact.png');
  await noise(224, 224, 3).png().toFile(images.exact);
}, 60_000);

describe('siglipPixelValues matches transformers\' own SigLIP preprocessing', () => {
  it.each(['landscape', 'exifRotated', 'alpha', 'grey', 'exact'])('%s', async (name) => {
    const tf = await import('@huggingface/transformers');
    const processor = await tf.AutoProcessor.from_pretrained(MODEL_ID);
    const ref = (await processor(await tf.RawImage.read(images[name]!))).pixel_values;

    const mine = await siglipPixelValues(images[name]!);

    expect(mine.dims).toEqual([1, 3, 224, 224]);
    expect(ref.dims).toEqual([1, 3, 224, 224]);
    const refData = ref.data as Float32Array;
    let maxDiff = 0;
    for (let i = 0; i < mine.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(mine.data[i]! - refData[i]!));
    expect(mine.data.length).toBe(refData.length);
    expect(maxDiff).toBeLessThan(1e-6);
  }, 600_000);
});

describe('ensureSiglipModel', () => {
  let server: Server | null = null;
  let requested: string[] = [];
  afterEach(() => { server?.close(); server = null; requested = []; });

  async function fakeHub(status = 200, body = 'fake onnx bytes'): Promise<string> {
    server = createServer((req, res) => {
      requested.push(req.url ?? '');
      res.writeHead(status).end(status === 200 ? body : 'nope');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const addr = server.address();
    return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }

  it('downloads the quantized vision model into the transformers cache layout', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'vem-wasm-cache-'));
    const hub = await fakeHub();
    const p = await ensureSiglipModel(cache, hub);
    expect(p).toBe(join(cache, 'Xenova', 'siglip-base-patch16-224', 'onnx', 'vision_model_quantized.onnx'));
    expect(readFileSync(p, 'utf8')).toBe('fake onnx bytes');
    expect(requested).toEqual(['/Xenova/siglip-base-patch16-224/resolve/main/onnx/vision_model_quantized.onnx']);
  });

  it('uses a model already on disk without touching the network', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'vem-wasm-cache-'));
    const target = join(cache, 'Xenova', 'siglip-base-patch16-224', 'onnx');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'vision_model_quantized.onnx'), 'already here');
    const hub = await fakeHub();
    const p = await ensureSiglipModel(cache, hub);
    expect(readFileSync(p, 'utf8')).toBe('already here');
    expect(requested).toEqual([]);
  });

  it('leaves neither the model nor a partial behind when the download fails', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'vem-wasm-cache-'));
    const hub = await fakeHub(404);
    await expect(ensureSiglipModel(cache, hub)).rejects.toThrow(/HTTP 404/);
    const onnxDir = join(cache, 'Xenova', 'siglip-base-patch16-224', 'onnx');
    const left = existsSync(onnxDir) ? readdirSync(onnxDir) : [];
    expect(left).toEqual([]);
  });

  it('refuses a relative cache directory instead of downloading into whatever the cwd is', async () => {
    const hub = await fakeHub();
    await expect(ensureSiglipModel('relative-cache', hub)).rejects.toThrow(/absolute/);
    expect(requested).toEqual([]);
  });

  it('removes its partial when the connection drops mid-download', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'vem-wasm-cache-'));
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': '1000000' });
      res.write(Buffer.alloc(4096, 1), () => res.destroy());
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const addr = server.address();
    const hub = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    await expect(ensureSiglipModel(cache, hub)).rejects.toThrow();
    expect(readdirSync(join(cache, 'Xenova', 'siglip-base-patch16-224', 'onnx'))).toEqual([]);
  });
});

describe('siglipCacheDir', () => {
  it('is the directory transformers itself caches models in, so both paths share one download', async () => {
    const tf = await import('@huggingface/transformers');
    expect(siglipCacheDir()).toBe(join(tf.env.cacheDir!, '.'));
  });
});

describe('embedWithWasm (real model)', () => {
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

  it('produces unit 768-dim vectors that agree with the native runtime', async () => {
    const tf = await import('@huggingface/transformers');
    const processor = await tf.AutoProcessor.from_pretrained(MODEL_ID);
    const model = await tf.SiglipVisionModel.from_pretrained(MODEL_ID, { dtype: 'q8' });
    const paths = [images.landscape!, images.alpha!, images.grey!];
    const native: number[][] = [];
    for (const p of paths) {
      const res = await model(await processor(await tf.RawImage.read(p)));
      const v = Array.from(res.pooler_output.data as Float32Array);
      const n = Math.hypot(...v);
      native.push(v.map((x) => x / n));
    }

    const wasm = await embedWithWasm(paths, await ensureSiglipModel(siglipCacheDir()));

    expect(wasm).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(wasm[i]).toHaveLength(768);
      expect(Math.hypot(...wasm[i]!)).toBeCloseTo(1, 3);
      expect(dot(wasm[i]!, native[i]!)).toBeGreaterThan(0.99);
    }
    // Different images must stay distinguishable, not collapse to one vector.
    expect(dot(wasm[0]!, wasm[2]!)).toBeLessThan(0.99);
  }, 600_000);

  it('keeps index alignment when an image in the middle cannot be read', async () => {
    const r = await embedWithWasm(
      [images.landscape!, join(dir, 'does-not-exist.jpg'), images.grey!],
      await ensureSiglipModel(siglipCacheDir()),
    );
    expect(r).toHaveLength(3);
    expect(r[0]).toHaveLength(768);
    expect(r[1]).toEqual([]);
    expect(r[2]).toHaveLength(768);
  }, 600_000);
});
