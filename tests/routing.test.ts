import { describe, it, expect } from 'vitest';
import { chooseAsrEngine, pickSenseVoiceLanguage, pickWhisperLanguage } from '../src/transcript/routing.js';

describe('chooseAsrEngine (spec §9)', () => {
  it.each(['zh', 'yue', 'ja', 'ko'])('routes %s to SenseVoice', (lang) => {
    expect(chooseAsrEngine({ preferredLanguage: lang })).toBe('sensevoice');
  });
  it('normalizes locale tags like zh-CN and ZH_hant', () => {
    expect(chooseAsrEngine({ preferredLanguage: 'zh-CN' })).toBe('sensevoice');
    expect(chooseAsrEngine({ preferredLanguage: 'ZH_hant' })).toBe('sensevoice');
  });
  it('routes English and unknown languages to Whisper', () => {
    expect(chooseAsrEngine({ preferredLanguage: 'en' })).toBe('whisper');
    expect(chooseAsrEngine({ preferredLanguage: 'sw' })).toBe('whisper');
  });
  it('defaults to Whisper when nothing is known', () => {
    expect(chooseAsrEngine({})).toBe('whisper');
  });
  it('prefers the explicit preferredLanguage over platform metadata', () => {
    expect(chooseAsrEngine({ preferredLanguage: 'en', languageHint: 'zh' })).toBe('whisper');
  });
  it('falls back to platform metadata when no preference is given', () => {
    expect(chooseAsrEngine({ languageHint: 'ja' })).toBe('sensevoice');
  });
});

// pickSenseVoiceLanguage is unit-tested with synthetic raw `.lang` values
// because the real model cannot currently produce a non-artifact value (see
// its doc comment in routing.ts and task-11-report.md's addendum for the
// empirical sweep proving sherpa-onnx-node@1.13.4's SenseVoice `.lang` is
// constant regardless of input).
describe('pickSenseVoiceLanguage', () => {
  it('majority-votes across segments that carry real (non-artifact) signal', () => {
    expect(pickSenseVoiceLanguage(['<|ja|>', '<|ja|>', '<|zh|>'])).toBe('ja');
  });
  it('excludes the known-constant "yue" artifact from the vote entirely', () => {
    // If "yue" were not excluded, plurality would wrongly pick it (2 vs 1).
    expect(pickSenseVoiceLanguage(['<|yue|>', '<|yue|>', '<|ja|>'])).toBe('ja');
  });
  it('falls back to "auto" when every segment is the artifact and no preferredLanguage was given', () => {
    expect(pickSenseVoiceLanguage(['<|yue|>', '<|yue|>'])).toBe('auto');
  });
  it('falls back to the normalized preferredLanguage when every segment is the artifact', () => {
    expect(pickSenseVoiceLanguage(['<|yue|>'], 'ko')).toBe('ko');
  });
  it('falls back to "auto" on an empty segment list with no preferredLanguage', () => {
    expect(pickSenseVoiceLanguage([])).toBe('auto');
  });
  it('normalizes a locale-tagged preferredLanguage fallback the same way chooseAsrEngine does', () => {
    expect(pickSenseVoiceLanguage([], 'ZH_hant')).toBe('zh');
  });
  it('normalizes bare (unwrapped) and case/locale-varied lang codes, not just "<|xx|>" tokens', () => {
    expect(pickSenseVoiceLanguage(['ja', 'JA', 'ja-JP'])).toBe('ja');
  });
  it('ignores null/undefined/empty entries without crashing or counting them', () => {
    expect(pickSenseVoiceLanguage([null, undefined, '', '<|ko|>', '<|ko|>'])).toBe('ko');
  });
});

describe('pickWhisperLanguage', () => {
  it('reports the language Whisper detected, by majority -- not "auto"', () => {
    // Real sherpa-onnx whisper-small output on a Portuguese song: bare codes.
    expect(pickWhisperLanguage(['pt', 'pt', 'es', 'pt'])).toBe('pt');
  });
  it('keeps "yue" as real signal, unlike SenseVoice (its artifact does not apply here)', () => {
    expect(pickWhisperLanguage(['yue', 'yue'])).toBe('yue');
  });
  it('falls back to the caller\'s language, then "auto", only when nothing was detected', () => {
    expect(pickWhisperLanguage(['', null], 'de')).toBe('de');
    expect(pickWhisperLanguage([])).toBe('auto');
  });
});
