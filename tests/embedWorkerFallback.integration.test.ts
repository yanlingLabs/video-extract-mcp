import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as nodeModule from 'node:module';
import sharp from 'sharp';

/**
 * The embed worker's WebAssembly fallback, driven through the real compiled
 * worker. tests/fixtures/no-native-onnxruntime.mjs makes onnxruntime-node's
 * native binding unresolvable -- the failure an Intel Mac gets from
 * onnxruntime-node 1.24+ -- so the fallback is exercised on a machine whose
 * native runtime would otherwise load. Without the fixture the same worker
 * must stay on the native path and say so.
 */

// The fixture needs module.registerHooks (Node 22.15+); the supported floor is 22.12.
const ready = existsSync('dist/vision/embedWorker.js') && existsSync('dist/vision/embed.js')
  && typeof nodeModule.registerHooks === 'function';
// A file URL, not a path: NODE_OPTIONS splits on spaces, and this repo's path has them.
const BLOCK_NATIVE = `--import=${pathToFileURL(resolve('tests/fixtures/no-native-onnxruntime.mjs')).href}`;
let red: string, blue: string, missing: string;

beforeAll(async () => {
  const d = mkdtempSync(join(tmpdir(), 'vem-fallback-'));
  red = join(d, 'red.jpg'); blue = join(d, 'blue.jpg'); missing = join(d, 'missing.jpg');
  await sharp({ create: { width: 320, height: 200, channels: 3, background: '#cc2222' } }).jpeg().toFile(red);
  await sharp({ create: { width: 320, height: 200, channels: 3, background: '#2222cc' } }).jpeg().toFile(blue);
});

function runWorker(paths: string[], nodeArgs: string[]): { code: number | null; out: { vectors: number[][]; fallback: string | null } | null; stderr: string } {
  const list = join(mkdtempSync(join(tmpdir(), 'vem-fallback-list-')), 'paths.json');
  writeFileSync(list, JSON.stringify(paths));
  const r = spawnSync(process.execPath, [...nodeArgs, 'dist/vision/embedWorker.js', list], { encoding: 'utf8', timeout: 600_000 });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* reported via code/stderr */ }
  return { code: r.status, out, stderr: r.stderr };
}

describe.skipIf(!ready)('embed worker runtime selection (integration)', () => {
  it('falls back to WebAssembly when the native binding cannot load, and says why', () => {
    const r = runWorker([red, missing, blue], [BLOCK_NATIVE]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.out!.fallback).toContain("Cannot find module '../bin/napi-v6/");
    expect(r.out!.fallback).not.toContain('\n');
    expect(r.out!.vectors).toHaveLength(3);
    expect(r.out!.vectors[0]).toHaveLength(768);
    expect(r.out!.vectors[1]).toEqual([]);
    expect(r.out!.vectors[2]).toHaveLength(768);
  }, 600_000);

  it('stays on the native runtime when it loads', () => {
    const r = runWorker([red], []);
    expect(r.code, r.stderr).toBe(0);
    expect(r.out!.fallback).toBeNull();
    expect(r.out!.vectors[0]).toHaveLength(768);
  }, 600_000);
});

describe.skipIf(!ready)('embedImages reports the fallback as a processing warning (integration)', () => {
  const prev = process.env['NODE_OPTIONS'];
  afterEach(() => {
    if (prev === undefined) delete process.env['NODE_OPTIONS']; else process.env['NODE_OPTIONS'] = prev;
  });

  it('adds one warning naming WebAssembly and the load error', async () => {
    process.env['NODE_OPTIONS'] = BLOCK_NATIVE;
    const { embedImages } = await import('../dist/vision/embed.js');
    const warnings: string[] = [];
    const vectors = await embedImages([red, blue], warnings);
    expect(vectors.map((v: number[]) => v.length)).toEqual([768, 768]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('WebAssembly');
    expect(warnings[0]).toContain('onnxruntime_binding.node');
  }, 600_000);

  it('adds nothing when the native runtime was used', async () => {
    delete process.env['NODE_OPTIONS'];
    const { embedImages } = await import('../dist/vision/embed.js');
    const warnings: string[] = [];
    await embedImages([red], warnings);
    expect(warnings).toEqual([]);
  }, 600_000);
});
