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

/**
 * Deterministic noise: high-frequency content makes any preprocessing drift
 * (kernel, channel order) visible pixel-for-pixel, and a fixed seed makes a
 * failure reproducible -- sharp's own `noise` option is reseeded every run.
 */
function noise(width: number, height: number, channels: 3 | 4, seed: number): ReturnType<typeof sharp> {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) & 0xff; };
  const data = Buffer.alloc(width * height * channels);
  for (let i = 0; i < data.length; i++) data[i] = next();
  return sharp(data, { raw: { width, height, channels } });
}

/**
 * Picture-like scenes for the runtime-agreement test. Pure noise is the worst
 * case for comparing two runtimes (a CI run on Linux x64 saw native-vs-WASM
 * cosine swing between 0.976 and 0.99+ from one random image to the next), and
 * real frames are not noise. Shapes only: text would depend on installed fonts.
 */
const SCENES: Record<string, string> = {
  sunset: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2a6b"/><stop offset="1" stop-color="#f28c38"/></linearGradient></defs>
    <rect width="640" height="360" fill="url(#sky)"/><circle cx="420" cy="230" r="60" fill="#ffd34d"/>
    <path d="M0 280 Q160 200 320 270 T640 250 V360 H0 Z" fill="#2d3b2a"/></svg>`,
  slide: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
    <rect width="640" height="360" fill="#ffffff"/><rect x="40" y="30" width="560" height="40" fill="#20466e"/>
    <rect x="60" y="110" width="140" height="200" fill="#e0533d"/><rect x="250" y="170" width="140" height="140" fill="#3d9be0"/>
    <rect x="440" y="230" width="140" height="80" fill="#52b36b"/><line x1="40" y1="320" x2="600" y2="320" stroke="#333" stroke-width="4"/></svg>`,
  night: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">
    <rect width="320" height="240" fill="#050814"/><circle cx="240" cy="60" r="30" fill="#e8e8d0"/>
    <circle cx="60" cy="40" r="2" fill="#fff"/><circle cx="120" cy="80" r="2" fill="#fff"/><circle cx="170" cy="30" r="2" fill="#fff"/>
    <rect x="30" y="140" width="60" height="100" fill="#1d2233"/><rect x="110" y="110" width="80" height="130" fill="#262c40"/>
    <rect x="45" y="160" width="10" height="12" fill="#f5d76e"/><rect x="130" y="130" width="10" height="12" fill="#f5d76e"/></svg>`,
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vem-wasm-pre-'));
  images.landscape = join(dir, 'landscape.jpg');
  await noise(640, 360, 3, 1).jpeg().toFile(images.landscape);
  // Stored 300x500 but tagged "rotate 90": the displayed image is 500x300.
  images.exifRotated = join(dir, 'exif-rotated.jpg');
  await noise(300, 500, 3, 2).withMetadata({ orientation: 6 }).jpeg().toFile(images.exifRotated);
  images.alpha = join(dir, 'alpha.png');
  await noise(320, 240, 4, 3).png().toFile(images.alpha);
  images.grey = join(dir, 'grey.png');
  await noise(256, 256, 3, 4).greyscale().png().toFile(images.grey);
  // Already 224x224: the resize is skipped on both sides.
  images.exact = join(dir, 'exact.png');
  await noise(224, 224, 3, 5).png().toFile(images.exact);
  for (const [name, svg] of Object.entries(SCENES)) {
    images[name] = join(dir, `${name}.png`);
    await sharp(Buffer.from(svg)).png().toFile(images[name]!);
  }
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
    const names = Object.keys(SCENES);
    const paths = names.map((n) => images[n]!);
    const native: number[][] = [];
    for (const p of paths) {
      const res = await model(await processor(await tf.RawImage.read(p)));
      const v = Array.from(res.pooler_output.data as Float32Array);
      const n = Math.hypot(...v);
      native.push(v.map((x) => x / n));
    }

    const wasm = await embedWithWasm(paths, await ensureSiglipModel(siglipCacheDir()));

    const agreement = names.map((_, i) => dot(wasm[i]!, native[i]!));
    let pairGap = 0;
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        pairGap = Math.max(pairGap, Math.abs(dot(wasm[i]!, wasm[j]!) - dot(native[i]!, native[j]!)));
      }
    }
    // Printed so a CI log records what each platform actually measures.
    process.stderr.write(`native-vs-wasm (${process.platform}/${process.arch}): cosine ${agreement.map((c) => c.toFixed(4)).join(' ')}, max pairwise gap ${pairGap.toFixed(4)}\n`);

    expect(wasm).toHaveLength(names.length);
    for (let i = 0; i < names.length; i++) {
      expect(wasm[i]).toHaveLength(768);
      expect(Math.hypot(...wasm[i]!)).toBeCloseTo(1, 3);
      expect(agreement[i]).toBeGreaterThan(0.95);
    }
    // What the frame selector consumes is similarity between frames.
    expect(pairGap).toBeLessThan(0.05);
    // Different images must stay distinguishable, not collapse to one vector.
    expect(dot(wasm[0]!, wasm[1]!)).toBeLessThan(0.95);
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
