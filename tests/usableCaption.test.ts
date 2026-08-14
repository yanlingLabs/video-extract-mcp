import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usableCaption } from '../src/analyze.js';

/**
 * usableCaption is the SINGLE decision "will this run transcribe from
 * captions, or does it need audio?" -- asked once at stage 1 to decide
 * whether to download the media at all, and again in the transcript stage.
 * Those two answers agreeing is what makes skipping the download safe, so
 * the contract is pinned here directly.
 *
 * Directly, because the pipeline cannot currently produce the interesting
 * input: the resolvers only ever report tracks they have already written, so
 * a phantom track never reaches analyze.ts through a real resolve. An
 * integration test therefore cannot distinguish this check being present
 * from it being absent -- only a unit test can.
 */
function realTrack(name: string): { path: string; language: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vem-cap-'));
  const path = join(dir, name);
  writeFileSync(path, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n');
  return { path, language: 'en' };
}

describe('usableCaption', () => {
  it('prefers a manual track over an automatic one', () => {
    const manual = realTrack('source.en.vtt');
    const auto = realTrack('auto.en.vtt');
    const got = usableCaption({ manual, auto });
    expect(got?.tier).toBe('manual');
    expect(got?.track.path).toBe(manual.path);
  });

  it('falls back to an automatic track when there is no manual one', () => {
    const auto = realTrack('auto.fr.vtt');
    const got = usableCaption({ manual: null, auto });
    expect(got?.tier).toBe('auto');
    expect(got?.track.path).toBe(auto.path);
  });

  it('returns null when the video has no captions at all', () => {
    expect(usableCaption({ manual: null, auto: null })).toBeNull();
  });

  it('returns null for an announced track whose file is not on disk', () => {
    // The case the whole download-skip rests on. If this returned a track,
    // stage 1 would skip the media while the transcript stage read a file
    // that is not there -- turning "no captions, use ASR" into a hard
    // extractor_failed. Both a manual and an automatic phantom, since the
    // tier branch picks a different object for each.
    const phantom = { path: join(tmpdir(), 'vem-does-not-exist-4f2a', 'source.en.vtt'), language: 'en' };
    expect(usableCaption({ manual: phantom, auto: null })).toBeNull();
    expect(usableCaption({ manual: null, auto: phantom })).toBeNull();
  });

  it('falls through to null rather than to the auto track when the manual one is a phantom', () => {
    // chooseCaptionTier picks 'manual' on presence alone, so a phantom
    // manual track SHADOWS a perfectly good automatic one. Pinned as the
    // deliberate reading: this returns null (ASR), it does not silently
    // promote the automatic track. Whichever way this behaves it must be a
    // choice, not an accident -- ASR is the honest answer, since a manual
    // track that vanished mid-run is a broken run, not a tier decision.
    const auto = realTrack('auto.en.vtt');
    const phantom = { path: join(tmpdir(), 'vem-does-not-exist-9c31', 'source.en.vtt'), language: 'en' };
    expect(usableCaption({ manual: phantom, auto })).toBeNull();
  });
});
