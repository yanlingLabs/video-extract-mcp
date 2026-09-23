import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { descriptionPreview, mediaFileName, writeMetadata, writeTranscript, writeManifest, PREVIEW_CHARS } from '../src/agent/artifacts.js';

describe('descriptionPreview', () => {
  it('returns null for a null description', () => {
    expect(descriptionPreview(null)).toBeNull();
  });
  it('returns a short description unchanged and unmarked', () => {
    expect(descriptionPreview('short')).toBe('short');
  });
  it('truncates a long description to the preview budget', () => {
    const p = descriptionPreview('y'.repeat(400))!;
    expect(p.length).toBeLessThanOrEqual(PREVIEW_CHARS + 1);
  });
  it('marks a truncated preview so the agent knows more exists', () => {
    expect(descriptionPreview('y'.repeat(400))!.endsWith('…')).toBe(true);
  });
  it('collapses newlines so the preview stays one line', () => {
    expect(descriptionPreview('a\n\nb')).toBe('a b');
  });
});

describe('mediaFileName (spec §7: range is part of identity)', () => {
  it('names a full fetch distinctly from a clip', () => {
    expect(mediaFileName()).not.toBe(mediaFileName(12, 20));
  });
  it('gives the same name for the same range, so a repeat overwrites', () => {
    expect(mediaFileName(12, 20)).toBe(mediaFileName(12, 20));
  });
  it('gives different names for different ranges, so both can coexist', () => {
    expect(mediaFileName(12, 20)).not.toBe(mediaFileName(12, 30));
  });
  it('produces no path separators', () => {
    expect(mediaFileName(1.5, 2.5)).not.toContain('/');
  });

  describe('half-open ranges (Finding 1: distinct from full and from each other)', () => {
    it('names a start-only range distinctly from a full fetch', () => {
      expect(mediaFileName(12, undefined)).not.toBe(mediaFileName());
    });
    it('names an end-only range distinctly from a full fetch', () => {
      expect(mediaFileName(undefined, 20)).not.toBe(mediaFileName());
    });
    it('names a start-only range distinctly from both-bounds', () => {
      expect(mediaFileName(12, undefined)).not.toBe(mediaFileName(12, 20));
    });
    it('names an end-only range distinctly from both-bounds', () => {
      expect(mediaFileName(undefined, 20)).not.toBe(mediaFileName(12, 20));
    });
    it('names two different start-only ranges distinctly', () => {
      expect(mediaFileName(12, undefined)).not.toBe(mediaFileName(15, undefined));
    });
    it('names two different end-only ranges distinctly', () => {
      expect(mediaFileName(undefined, 20)).not.toBe(mediaFileName(undefined, 30));
    });
    it('names a start-only range distinctly from an end-only range', () => {
      expect(mediaFileName(12, undefined)).not.toBe(mediaFileName(undefined, 12));
    });
    it('repeat start-only calls return the same filename', () => {
      expect(mediaFileName(12, undefined)).toBe(mediaFileName(12, undefined));
    });
    it('repeat end-only calls return the same filename', () => {
      expect(mediaFileName(undefined, 20)).toBe(mediaFileName(undefined, 20));
    });
  });

  describe('negative ranges (verify no regression)', () => {
    it('names negative-start ranges distinctly', () => {
      expect(mediaFileName(-12, 20)).not.toBe(mediaFileName(12, 20));
    });
    it('names negative-end ranges distinctly', () => {
      expect(mediaFileName(12, -20)).not.toBe(mediaFileName(12, 20));
    });
    it('repeat negative calls return the same filename', () => {
      expect(mediaFileName(-12, 20)).toBe(mediaFileName(-12, 20));
    });
  });

  describe('extension validation (Finding 2: no path traversal)', () => {
    it('throws on a path traversal extension', () => {
      expect(() => mediaFileName(1, 2, '../../../etc/cron.d/evil')).toThrow();
    });
    it('throws on an extension containing a slash', () => {
      expect(() => mediaFileName(1, 2, 'mp4/foo')).toThrow();
    });
    it('throws on an extension containing a dot', () => {
      expect(() => mediaFileName(1, 2, 'mp4.backup')).toThrow();
    });
    it('accepts a normal alphanumeric extension', () => {
      expect(() => mediaFileName(1, 2, 'mp4')).not.toThrow();
    });
  });

  describe('numeric validation (Finding 3: reject non-finite, document rounding)', () => {
    it('throws on NaN as start', () => {
      expect(() => mediaFileName(NaN, 20)).toThrow();
    });
    it('throws on NaN as end', () => {
      expect(() => mediaFileName(12, NaN)).toThrow();
    });
    it('throws on Infinity as start', () => {
      expect(() => mediaFileName(Infinity, 20)).toThrow();
    });
    it('throws on Infinity as end', () => {
      expect(() => mediaFileName(12, Infinity)).toThrow();
    });
    it('throws on -Infinity as start', () => {
      expect(() => mediaFileName(-Infinity, 20)).toThrow();
    });
    it('throws on -Infinity as end', () => {
      expect(() => mediaFileName(12, -Infinity)).toThrow();
    });
    it('rounds sub-centisecond ranges (0.001 and 0.002 both round to 0.00)', () => {
      // This test documents the precision limitation; both inputs round to the same value
      const name1 = mediaFileName(0, 0.001);
      const name2 = mediaFileName(0, 0.002);
      expect(name1).toBe(name2);
    });
  });

  describe('extreme magnitude overflow (Item 2: reject overflow-inducing values)', () => {
    it('throws on extreme-magnitude end that overflows tag rounding', () => {
      expect(() => mediaFileName(12, 1.8e306)).toThrow();
    });
    it('throws on extreme-magnitude end that is larger than overflow threshold', () => {
      expect(() => mediaFileName(12, 1.9e306)).toThrow();
    });
    it('accepts a large finite value below overflow threshold', () => {
      expect(() => mediaFileName(12, 1e306)).not.toThrow();
    });
  });
});

describe('writeMetadata', () => {
  it('replaces an existing metadata file rather than duplicating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-art-'));
    const p1 = writeMetadata(dir, { a: 1 });
    const p2 = writeMetadata(dir, { a: 2 });
    expect(p2).toBe(p1);
    expect(JSON.parse(readFileSync(p1, 'utf8')).a).toBe(2);
  });
  it('creates the directory when it does not exist', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'norma-art-')), 'nested', 'deep');
    const p = writeMetadata(dir, { a: 1 });
    expect(existsSync(p)).toBe(true);
  });
});

describe('writeTranscript (minor finding: coverage)', () => {
  it('writes to the correct literal filename (transcript.json)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-art-'));
    const t = { language: 'en', source: 'manual' as const, segments: [] };
    const p = writeTranscript(dir, t);
    const expectedPath = join(dir, 'transcript.json');
    expect(p).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
  });
  it('replaces an existing transcript file rather than duplicating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-art-'));
    const t1 = { language: 'en', source: 'manual' as const, segments: [] };
    const t2 = { language: 'es', source: 'auto' as const, segments: [] };
    const p1 = writeTranscript(dir, t1);
    const p2 = writeTranscript(dir, t2);
    expect(p2).toBe(p1);
    const written = JSON.parse(readFileSync(p1, 'utf8'));
    expect(written.language).toBe('es');
  });
  it('creates the directory when it does not exist', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'norma-art-')), 'nested', 'deep');
    const t = { language: 'en', source: 'manual' as const, segments: [] };
    const p = writeTranscript(dir, t);
    expect(existsSync(p)).toBe(true);
  });
});

describe('writeManifest (minor finding: coverage)', () => {
  it('writes to the correct literal filename (manifest.json)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-art-'));
    const m = {
      source: { url: 'test', platform: 'test', title: 'test', duration: 1, resolvedBy: 'test', status: 'ok' as const, cookies: 'none' as const },
      transcript: null,
      frames: [],
      processing: { selectedFrames: 0, candidateFrames: 0, peakRssMb: 1, selectorVersion: '1', frameMode: 'key' as const, warnings: [] },
    };
    const p = writeManifest(dir, m);
    const expectedPath = join(dir, 'manifest.json');
    expect(p).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
  });
  it('replaces an existing manifest file rather than duplicating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-art-'));
    const m1 = {
      source: { url: 'a', platform: 'test', title: 'a', duration: 1, resolvedBy: 'test', status: 'ok' as const, cookies: 'none' as const },
      transcript: null,
      frames: [],
      processing: { selectedFrames: 0, candidateFrames: 0, peakRssMb: 1, selectorVersion: '1', frameMode: 'key' as const, warnings: [] },
    };
    const m2 = {
      source: { url: 'b', platform: 'test', title: 'b', duration: 2, resolvedBy: 'test', status: 'ok' as const, cookies: 'none' as const },
      transcript: null,
      frames: [],
      processing: { selectedFrames: 0, candidateFrames: 0, peakRssMb: 1, selectorVersion: '1', frameMode: 'key' as const, warnings: [] },
    };
    const p1 = writeManifest(dir, m1);
    const p2 = writeManifest(dir, m2);
    expect(p2).toBe(p1);
    const written = JSON.parse(readFileSync(p1, 'utf8'));
    expect(written.source.url).toBe('b');
  });
  it('creates the directory when it does not exist', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'norma-art-')), 'nested', 'deep');
    const m = {
      source: { url: 'test', platform: 'test', title: 'test', duration: 1, resolvedBy: 'test', status: 'ok' as const, cookies: 'none' as const },
      transcript: null,
      frames: [],
      processing: { selectedFrames: 0, candidateFrames: 0, peakRssMb: 1, selectorVersion: '1', frameMode: 'key' as const, warnings: [] },
    };
    const p = writeManifest(dir, m);
    expect(existsSync(p)).toBe(true);
  });
});
