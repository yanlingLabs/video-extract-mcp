import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, utimesSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STALE_PARTIAL_AGE_MS, partialPathFor, promotePartial, discardPartial, sweepStalePartials,
} from '../src/util/partials.js';

/** Writes a file and back-dates its mtime by `ageMs`. */
function aged(dir: string, name: string, ageMs: number): string {
  const p = join(dir, name);
  writeFileSync(p, 'x');
  const when = new Date(Date.now() - ageMs);
  utimesSync(p, when, when);
  return p;
}
const ANCIENT = STALE_PARTIAL_AGE_MS * 10;

describe('partial naming', () => {
  it('is unique per call, so two concurrent downloads never share a partial', () => {
    // Sharing one is what let a slow call delete the file a fast call had
    // already promoted and returned to its caller as a success.
    const out = join(mkdtempSync(join(tmpdir(), 'vem-uniq-')), 'source.mp4');
    const a = partialPathFor(out);
    const b = partialPathFor(out);
    expect(a).not.toBe(b);
    expect(a.endsWith('.part')).toBe(true);
    expect(a.startsWith(`${out}.`)).toBe(true);
  });

  it('promotes to the final name and leaves nothing behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vem-promote-'));
    const out = join(dir, 'source.mp4');
    const partial = partialPathFor(out);
    writeFileSync(partial, 'bytes');
    promotePartial(partial, out);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(partial)).toBe(false);
    expect(readdirSync(dir)).toEqual(['source.mp4']);
  });
});

describe('sweepStalePartials', () => {
  it('NEVER removes a file the caller owns -- including a foreign .part', () => {
    // '.part' is a shared convention: Firefox and a user's own yt-dlp run
    // both produce them. Matching a bare suffix inside the caller's own
    // directory would delete their downloads.
    const dir = mkdtempSync(join(tmpdir(), 'vem-foreign-'));
    const foreign = [
      'lecture.mp4.part',            // someone else's paused download
      'Firefox-download.mkv.part',
      'manifest.json', 'transcript.json', 'metadata.json',
      'source.mp4', 'source_s10_e20.mp4', 'source.en.vtt', 'auto.en.vtt',
      'work.mp4', 'work.wav', 'clip.mp4', 'frame_0001.jpg',
    ].map((n) => aged(dir, n, ANCIENT));
    aged(dir, 'source.mp4.1234-1.part', ANCIENT);

    expect(sweepStalePartials(dir)).toBe(1);
    for (const f of foreign) expect(existsSync(f)).toBe(true);
  });

  it('collects the litter a killed yt-dlp actually leaves', () => {
    // Fragmented downloads (every HLS/DASH platform path) leave more than a
    // plain .part: matching only '.part' misses the bytes that dominate.
    const dir = mkdtempSync(join(tmpdir(), 'vem-frag-'));
    aged(dir, 'source.f137.mp4.part', ANCIENT);
    aged(dir, 'source.f137.mp4.part-Frag12', ANCIENT);
    aged(dir, 'source.f137.mp4.ytdl', ANCIENT);
    expect(sweepStalePartials(dir)).toBe(3);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('never touches a live download in the same directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vem-live-'));
    const live = aged(dir, 'source.mp4.999-1.part', 60_000);   // a minute old: in flight
    const dead = aged(dir, 'source.mp4.111-1.part', ANCIENT);
    expect(sweepStalePartials(dir)).toBe(1);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(dead)).toBe(false);
  });

  it('exposes no way to lower the age gate', () => {
    // Enforced by the signature, not by an assertion: an earlier draft took
    // a maxAgeMs override, a caller passed 0 meaning "clean up after
    // myself", and it deleted a concurrent download's live bytes. A test
    // asserting the old override was safe was itself flaky, because it
    // wasn't. sweepStalePartials now takes exactly one argument.
    expect(sweepStalePartials.length).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), 'vem-noblind-'));
    const fresh = join(dir, 'source.mp4.1-1.part');
    writeFileSync(fresh, 'live bytes');
    expect(sweepStalePartials(dir)).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  it('collects the litter a killed MERGE leaves -- media extensions and all', () => {
    // yt-dlp downloads video and audio separately then muxes. Killed
    // mid-merge it leaves per-format files and a truncated source.temp.mp4
    // -- bytes under an ordinary media extension, which is precisely the
    // shape this module exists to keep out of a caller's directory.
    const dir = mkdtempSync(join(tmpdir(), 'vem-merge-'));
    aged(dir, 'source.f137.mp4', ANCIENT);
    aged(dir, 'source.f140.m4a', ANCIENT);
    aged(dir, 'source.temp.mp4', ANCIENT);
    const keep = aged(dir, 'source.mp4', ANCIENT);   // the finished article
    expect(sweepStalePartials(dir)).toBe(3);
    expect(existsSync(keep)).toBe(true);
    expect(readdirSync(dir)).toEqual(['source.mp4']);
  });

  it('is not recursive, so per-item video-N/ subdirectories are untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vem-norec-'));
    mkdirSync(join(dir, 'video-1'));
    const nested = aged(join(dir, 'video-1'), 'source.mp4.7-1.part', ANCIENT);
    expect(sweepStalePartials(dir)).toBe(0);
    expect(existsSync(nested)).toBe(true);
  });

  it('returns 0 rather than throwing for a directory that does not exist', () => {
    expect(sweepStalePartials(join(tmpdir(), 'vem-absent-dir-xyz'))).toBe(0);
  });
});

describe('discardPartial', () => {
  it('removes one exact path and tolerates it already being gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vem-discard-'));
    const p = join(dir, 'source.mp4.4-1.part');
    writeFileSync(p, 'x');
    discardPartial(p);
    expect(existsSync(p)).toBe(false);
    expect(() => discardPartial(p)).not.toThrow();
  });
});
