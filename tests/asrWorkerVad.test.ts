import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';

// Regression test for the VAD-tail bug: the pre-fix loop
// (`for (let i = 0; i + window < samples.length; i += window)`) never fed
// the final window of samples to the VAD, so trailing speech near the very
// end of a clip could be silently dropped. See asrWorker.ts's runVad() doc
// comment and task-11-report.md's addendum for the full derivation.
//
// Needs the real Silero VAD model and the real speech fixture -- this is a
// white-box mechanism-level test (asserts on VAD segment sample coverage,
// not on ASR text), which is deterministic and discriminates exactly,
// unlike relying on transcribed text possibly guessing around a dropped
// fraction of a second.
const ready = existsSync('models/silero_vad.onnx')
  && existsSync('dist/transcript/asrWorker.js')
  && existsSync('tests/fixtures/speech.wav');

const WINDOW = 512;

/** End sample index of the last emitted VAD segment -- how far into the
 * input the caller's chunking actually got real (or padded) content
 * classified and returned. */
function coverage(segments: Array<{ start: number; samples: Float32Array }>): number {
  if (segments.length === 0) return 0;
  const last = segments[segments.length - 1]!;
  return last.start + last.samples.length;
}

/**
 * Reproduces the EXACT pre-fix loop this module used to have, verbatim,
 * before this task's fix. Inlined here (not imported) because the pre-fix
 * asrWorker.ts had no exports and unconditionally called main() at import
 * time -- importing it from a test would run main() against the test
 * runner's own argv and call process.exit(1) on the resulting usage error,
 * killing the test process. This is run against a fresh Vad instance with
 * identical config to the fixed runVad(), on the identical input, to
 * empirically prove the historical bug would fail the assertions below.
 */
function preFixRunVad(
  vad: { acceptWaveform(s: Float32Array): void; isEmpty(): boolean; front(): { start: number; samples: Float32Array }; pop(): void; flush(): void },
  samples: Float32Array,
  window: number,
): Array<{ start: number; samples: Float32Array }> {
  const out: Array<{ start: number; samples: Float32Array }> = [];
  for (let i = 0; i + window < samples.length; i += window) {
    vad.acceptWaveform(samples.subarray(i, i + window));
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      out.push({ start: seg.start, samples: seg.samples });
    }
  }
  vad.flush();
  while (!vad.isEmpty()) {
    const seg = vad.front();
    vad.pop();
    out.push({ start: seg.start, samples: seg.samples });
  }
  return out;
}

describe.skipIf(!ready)('asrWorker VAD tail handling (regression for dropped trailing speech)', () => {
  it('non-multiple length (the real-world case): fixed coverage reaches the true content, pre-fix coverage falls short', async () => {
    const sherpa = (await import('sherpa-onnx-node')).default;
    const { runVad } = await import('../dist/transcript/asrWorker.js');

    const wave = sherpa.readWave('tests/fixtures/speech.wav');
    function freshVad() {
      return new sherpa.Vad({
        sileroVad: {
          model: 'models/silero_vad.onnx',
          threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20,
        },
        sampleRate: wave.sampleRate, numThreads: 1, debug: 0,
      }, 60);
    }

    // Cut deliberately NOT on a window boundary, deep inside the fixture's
    // known continuous speech run (empirically spans roughly [11360, 46592)
    // samples on this fixture) so the withheld tail is provably real speech
    // content, not trailing silence. 30108 % 512 === 412 (a genuine partial
    // final window, the common real-world case: length % window !== 0).
    const trimmedLen = 30108;
    expect(trimmedLen % WINDOW).not.toBe(0); // sanity: this is the partial-window case
    const samples = wave.samples.subarray(0, trimmedLen);

    const fixedCoverage = coverage(runVad(freshVad(), samples, WINDOW));
    const buggyCoverage = coverage(preFixRunVad(freshVad(), samples, WINDOW));

    // Observed on this fixture/model: fixedCoverage=30208, buggyCoverage=29696.
    // Fixed reaches (and, due to zero-padding the final partial window,
    // slightly exceeds) the true trimmed length -- the withheld content
    // survives. Pre-fix falls strictly short of it -- the withheld content
    // is lost. Pinning both exact observed values, not just the inequality,
    // so a regression in either direction is caught.
    expect(fixedCoverage).toBe(30208);
    expect(buggyCoverage).toBe(29696);
    expect(fixedCoverage).toBeGreaterThanOrEqual(trimmedLen);
    expect(buggyCoverage).toBeLessThan(trimmedLen);
  }, 60_000);

  it('exact-multiple-of-window length (finding\'s "exactly window samples" case): fixed recovers exactly the dropped window', async () => {
    const sherpa = (await import('sherpa-onnx-node')).default;
    const { runVad } = await import('../dist/transcript/asrWorker.js');

    const wave = sherpa.readWave('tests/fixtures/speech.wav');
    function freshVad() {
      return new sherpa.Vad({
        sileroVad: {
          model: 'models/silero_vad.onnx',
          threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20,
        },
        sampleRate: wave.sampleRate, numThreads: 1, debug: 0,
      }, 60);
    }

    // Exact multiple of the window size, same deep-inside-speech region.
    // Padding never triggers here (every chunk is a full window) -- this
    // isolates the loop-bound fix specifically, independent of padding.
    const trimmedLen = 30208;
    expect(trimmedLen % WINDOW).toBe(0); // sanity: this is the exact-multiple case
    const samples = wave.samples.subarray(0, trimmedLen);

    const fixedCoverage = coverage(runVad(freshVad(), samples, WINDOW));
    const buggyCoverage = coverage(preFixRunVad(freshVad(), samples, WINDOW));

    // Fixed reaches the true length exactly; pre-fix falls short by exactly
    // one whole window (512 samples / 32ms @16kHz) -- the entire final
    // window this fixture's speech occupies was silently dropped before.
    expect(fixedCoverage).toBe(trimmedLen);
    expect(buggyCoverage).toBe(trimmedLen - WINDOW);
  }, 60_000);
});

// The worker streams its input: the WAV is read in pieces and VAD segments
// are decoded as they are emitted, so memory no longer grows with audio
// length. These pin that streaming changes NOTHING about what VAD sees.
describe.skipIf(!ready)('asrWorker streaming input (memory independent of audio length)', () => {
  it('openPcm16Wav yields exactly the samples sherpa.readWave loads, whatever the piece size', async () => {
    const sherpa = (await import('sherpa-onnx-node')).default;
    const { openPcm16Wav } = await import('../dist/transcript/asrWorker.js');
    const { run } = await import('../dist/util/run.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    // Written exactly as extractAudio writes it -- ffmpeg adds a LIST chunk
    // before `data`, so this also exercises walking past unknown chunks.
    const wav = join(mkdtempSync(join(tmpdir(), 'vem-wav-')), 'work.wav');
    const r = await run('ffmpeg', ['-y', '-i', 'tests/fixtures/speech.wav', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    expect(r.code).toBe(0);

    const whole = sherpa.readWave(wav);
    const opened = openPcm16Wav(wav, 777)!;
    expect(opened).not.toBeNull();
    expect(opened.sampleRate).toBe(whole.sampleRate);
    expect(opened.totalSamples).toBe(whole.samples.length);
    const pieces = [...opened.pieces()];
    expect(pieces.length).toBeGreaterThan(1);
    const joined = new Float32Array(opened.totalSamples);
    let at = 0;
    for (const p of pieces) { joined.set(p, at); at += p.length; }
    expect(at).toBe(whole.samples.length);
    expect(Buffer.from(joined.buffer).equals(Buffer.from(whole.samples.buffer, whole.samples.byteOffset, whole.samples.byteLength))).toBe(true);
  });

  it('streamVad over odd-sized pieces emits the same segments as runVad over the whole input', async () => {
    const sherpa = (await import('sherpa-onnx-node')).default;
    const { runVad, streamVad } = await import('../dist/transcript/asrWorker.js');
    const wave = sherpa.readWave('tests/fixtures/speech.wav');
    const freshVad = () => new sherpa.Vad({
      sileroVad: {
        model: 'models/silero_vad.onnx',
        threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20,
      },
      sampleRate: wave.sampleRate, numThreads: 1, debug: 0,
    }, 60);
    const pieces: Float32Array[] = [];
    for (let i = 0; i < wave.samples.length; i += 1000) pieces.push(wave.samples.slice(i, i + 1000)); // 1000 % 512 != 0
    const streamed: Array<{ start: number; samples: Float32Array }> = [];
    streamVad(freshVad(), pieces, WINDOW, (s) => streamed.push(s));
    const whole = runVad(freshVad(), wave.samples, WINDOW);
    expect(whole.length).toBeGreaterThan(0);
    expect(streamed.map((s) => [s.start, s.samples.length])).toEqual(whole.map((s) => [s.start, s.samples.length]));
  });
});
