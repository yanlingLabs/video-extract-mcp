import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PARTIAL_SUFFIX, STALE_PARTIAL_AGE_MS,
  partialPathFor, promotePartial, sweepStalePartials,
} from '../src/util/partials.js';

/** Writes a file and back-dates its mtime by `ageMs`. */
function aged(dir: string, name: string, ageMs: number): string {
  const p = join(dir, name);
  writeFileSync(p, 'x');
  const when = new Date(Date.now() - ageMs);
  utimesSync(p, when, when);
  return p;
}

describe('partial-download hygiene', () => {
  it('names in-flight downloads with the .part suffix and promotes them atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vem-part-'));
    const out = join(dir, 'source.mp4');
    expect(partialPathFor(out)).toBe(`${out}${PARTIAL_SUFFIX}`);
    writeFileSync(partialPathFor(out), 'bytes');
    promotePartial(out);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(partialPathFor(out))).toBe(false);   // no leftover
  });

  it('sweeps only .part files, and only ones older than the age gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vem-sweep-'));
    const oldPart = aged(dir, 'source.mp4.part', STALE_PARTIAL_AGE_MS + 60_000);
    const freshPart = aged(dir, 'other.mp4.part', 60_000);   // a live download
    const removed = sweepStalePartials(dir);
    expect(removed).toBe(1);
    expect(existsSync(oldPart)).toBe(false);
    expect(existsSync(freshPart)).toBe(true);               // never disturbed
  });

  it('NEVER removes a caller artifact, whatever its age', () => {
    // The whole feature rests on this: .part is ours, everything else is
    // the caller's. A sweep that touched any of these would be the
    // data-loss class this project already shipped once.
    const dir = mkdtempSync(join(tmpdir(), 'vem-artifacts-'));
    const ancient = STALE_PARTIAL_AGE_MS * 10;
    const artifacts = ['manifest.json', 'transcript.json', 'source.mp4', 'metadata.json', 'frame_0001.jpg']
      .map((n) => aged(dir, n, ancient));
    aged(dir, 'source.mp4.part', ancient);
    expect(sweepStalePartials(dir)).toBe(1);                // only the .part
    for (const a of artifacts) expect(existsSync(a)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(
      ['frame_0001.jpg', 'manifest.json', 'metadata.json', 'source.mp4', 'transcript.json'],
    );
  });

  it('an explicit zero age gate sweeps this run\'s own fresh partial', () => {
    // The failed-download path: the partial is current by definition, and
    // abandoning it is exactly what the caller asked for.
    const dir = mkdtempSync(join(tmpdir(), 'vem-zero-'));
    writeFileSync(join(dir, 'source.webm.part'), 'half');
    expect(sweepStalePartials(dir, 0)).toBe(1);
    expect(existsSync(join(dir, 'source.webm.part'))).toBe(false);
  });

  it('returns 0 rather than throwing for a directory that does not exist', () => {
    expect(sweepStalePartials(join(tmpdir(), 'vem-definitely-absent-dir'))).toBe(0);
  });
});
