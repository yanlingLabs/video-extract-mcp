import { openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sherpa from 'sherpa-onnx-node';
import type { Vad } from 'sherpa-onnx-node';
import type { Transcript, TranscriptSegment } from '../types.js';
import { pickSenseVoiceLanguage, pickWhisperLanguage } from './routing.js';

const SENSEVOICE_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09';
const WHISPER_DIR = 'sherpa-onnx-whisper-small';

function buildRecognizer(engine: string, modelsDir: string) {
  if (engine === 'sensevoice') {
    return new sherpa.OfflineRecognizer({
      modelConfig: {
        senseVoice: { model: join(modelsDir, SENSEVOICE_DIR, 'model.int8.onnx'), useInverseTextNormalization: 1 },
        tokens: join(modelsDir, SENSEVOICE_DIR, 'tokens.txt'),
        numThreads: 2, provider: 'cpu', debug: 0,
      },
    });
  }
  return new sherpa.OfflineRecognizer({
    modelConfig: {
      whisper: {
        encoder: join(modelsDir, WHISPER_DIR, 'small-encoder.int8.onnx'),
        decoder: join(modelsDir, WHISPER_DIR, 'small-decoder.int8.onnx'),
      },
      tokens: join(modelsDir, WHISPER_DIR, 'small-tokens.txt'),
      numThreads: 2, provider: 'cpu', debug: 0,
    },
  });
}

export interface VadSegment { start: number; samples: Float32Array; }

/**
 * Feeds `samples` into `vad` in fixed-size windows, draining every detected
 * speech segment along the way, then flushes and drains whatever segment is
 * still buffered at end-of-stream. Exported so tests can exercise the exact
 * chunking behavior main() uses without a full ASR decode.
 *
 * Tail fix, two parts (see task-11-report.md addendum for the full empirical
 * derivation):
 *
 * 1. The loop bound is `i < samples.length` (not the previous
 *    `i + window < samples.length`), so the final window is always fed --
 *    Float32Array#subarray clamps an out-of-range `end` to the array's true
 *    length, so on the last iteration `samples.subarray(i, i + window)`
 *    returns exactly whatever real audio remains, never an out-of-bounds
 *    slice. This alone fully recovers the case where `samples.length` is an
 *    exact multiple of `window`: previously the entire last window (512
 *    samples / 32ms) was silently dropped, because vad.flush() only
 *    finalizes state already ingested via acceptWaveform -- it cannot
 *    retroactively accept samples that were never pushed to it.
 *
 * 2. When the final chunk is SHORTER than `window` (the more common case --
 *    samples.length not a multiple of window), it is zero-padded up to a
 *    full window before being fed. This is necessary in addition to (1):
 *    empirically, feeding a genuinely short last chunk on its own changes
 *    nothing versus not feeding it at all -- the native Silero addon only
 *    classifies/emits complete `window`-sized frames, and flush() does not
 *    force a partial buffered fragment through classification. Padding with
 *    zeros gives the classifier a complete frame to decide on; the real
 *    content in it (a majority of the frame, for anything but the very
 *    shortest remainders) still reads as speech, so the segment now legitimately
 *    extends into what would otherwise be a permanently-unclassifiable
 *    fragment. This is a design addition beyond the two options originally
 *    suggested (change the loop bound / submit the remainder after the
 *    loop) -- both of those alone still lose this case; see the report.
 *    The trailing zero-padding this can add to a segment's `.samples` is
 *    harmless to the recognizer (silence at the end of an utterance), but
 *    callers must not report it as real audio duration -- main() clamps
 *    each segment's reported `end` to the true wave length below.
 */
export function runVad(vad: Vad, samples: Float32Array, window: number): VadSegment[] {
  const out: VadSegment[] = [];
  streamVad(vad, [samples], window, (seg) => out.push(seg));
  return out;
}

/**
 * runVad over audio that arrives in pieces, handing each speech segment to
 * `onSegment` the moment VAD emits it. This is what main() uses, so that
 * neither the whole decoded waveform nor the whole list of segments is ever
 * resident: holding both cost ~128 KB per second of audio -- ~0.9 GB extra
 * on a two-hour video, measured as +166 MB going from 4.4 to 26 minutes. The
 * windowing, the zero-padded final window and the flush are runVad's exactly
 * (runVad is this function over a single piece); pieces of any size are
 * re-cut into the same `window`-sized frames.
 */
export function streamVad(
  vad: Vad, pieces: Iterable<Float32Array>, window: number, onSegment: (seg: VadSegment) => void,
): void {
  const drain = (): void => {
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      onSegment({ start: seg.start, samples: seg.samples });
    }
  };
  let carry = new Float32Array(0);
  for (const piece of pieces) {
    let buf = piece;
    if (carry.length > 0) {
      buf = new Float32Array(carry.length + piece.length);
      buf.set(carry);
      buf.set(piece, carry.length);
    }
    let i = 0;
    for (; i + window <= buf.length; i += window) {
      vad.acceptWaveform(buf.subarray(i, i + window));
      drain();
    }
    carry = buf.slice(i);
  }
  if (carry.length > 0) {
    const padded = new Float32Array(window); // zero-filled remainder
    padded.set(carry);
    vad.acceptWaveform(padded);
    drain();
  }
  vad.flush();
  drain();
}

/**
 * Reads a 16-bit PCM WAV (what extractAudio writes) in pieces, as float
 * samples. Returns null for any other layout, and the caller falls back to
 * sherpa.readWave -- which loads the whole file at once.
 */
export function openPcm16Wav(path: string, pieceSamples = 1 << 20):
  { sampleRate: number; totalSamples: number; pieces: () => Generator<Float32Array> } | null {
  const fd = openSync(path, 'r');
  const head = Buffer.alloc(12);
  if (readSync(fd, head, 0, 12, 0) < 12 || head.toString('ascii', 0, 4) !== 'RIFF'
    || head.toString('ascii', 8, 12) !== 'WAVE') { closeSync(fd); return null; }
  let pos = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | null = null;
  const hdr = Buffer.alloc(8);
  while (readSync(fd, hdr, 0, 8, pos) === 8) {
    const id = hdr.toString('ascii', 0, 4);
    const size = hdr.readUInt32LE(4);
    if (id === 'fmt ') {
      const f = Buffer.alloc(16);
      readSync(fd, f, 0, 16, pos + 8);
      fmt = { format: f.readUInt16LE(0), channels: f.readUInt16LE(2), sampleRate: f.readUInt32LE(4), bits: f.readUInt16LE(14) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16) { closeSync(fd); return null; }
      const dataStart = pos + 8;
      const totalSamples = Math.floor(size / 2);
      return {
        sampleRate: fmt.sampleRate,
        totalSamples,
        pieces: function* () {
          const bytes = Buffer.alloc(pieceSamples * 2);
          try {
            for (let done = 0; done < totalSamples;) {
              const want = Math.min(pieceSamples, totalSamples - done) * 2;
              const got = readSync(fd, bytes, 0, want, dataStart + done * 2);
              if (got < 2) break;
              const n = got >> 1;
              const out = new Float32Array(n);
              for (let k = 0; k < n; k++) out[k] = bytes.readInt16LE(k * 2) / 32768;
              done += n;
              yield out;
            }
          } finally {
            closeSync(fd);
          }
        },
      };
    }
    pos += 8 + size + (size & 1);
  }
  closeSync(fd);
  return null;
}

async function main(): Promise<void> {
  const [wav, engine = 'whisper', modelsDir = 'models', preferredLanguage] = process.argv.slice(2);
  if (!wav) throw new Error('usage: asrWorker <wav> <engine> <modelsDir> [preferredLanguage]');

  // Streamed from disk when it is the PCM16 file extractAudio writes (always,
  // in practice); anything else is loaded whole, as before.
  const streamed = openPcm16Wav(wav);
  const whole = streamed ? null : sherpa.readWave(wav);
  const sampleRate = streamed?.sampleRate ?? whole!.sampleRate;
  const totalSamples = streamed?.totalSamples ?? whole!.samples.length;
  const vad = new sherpa.Vad({
    sileroVad: {
      model: join(modelsDir, 'silero_vad.onnx'),
      threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20,
    },
    sampleRate, numThreads: 1, debug: 0,
  }, 60);

  const recognizer = buildRecognizer(engine, modelsDir);
  const window = 512;

  // VAD first: only speech regions reach ASR (spec §9/report §10). Each
  // segment is decoded as soon as VAD emits it and then dropped.
  const segments: TranscriptSegment[] = [];
  const rawLangs: Array<string | null | undefined> = [];
  const decode = (seg: VadSegment): void => {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: seg.samples, sampleRate });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    const text = result.text.trim();
    if (text) {
      const start = seg.start / sampleRate;
      // streamVad's tail fix can zero-pad a segment's final window (see
      // runVad's doc comment), so the raw end sample can slightly overrun the
      // true wave length. Clamp so a reported segment never claims audio
      // duration that doesn't exist in the source file.
      const endSample = Math.min(seg.start + seg.samples.length, totalSamples);
      segments.push({ start, end: endSample / sampleRate, text });
      // Captured at zero extra cost (getResult already ran) for the
      // language vote below.
      rawLangs.push(result.lang);
    }
  };
  streamVad(vad, streamed ? streamed.pieces() : [whole!.samples], window, decode);

  // Each engine's per-segment .lang, majority-voted. Whisper's is genuine
  // detection; SenseVoice's usually is not on this library version -- see
  // pickSenseVoiceLanguage's doc comment for why, and what it falls back to.
  const language = engine === 'sensevoice'
    ? pickSenseVoiceLanguage(rawLangs, preferredLanguage)
    : pickWhisperLanguage(rawLangs, preferredLanguage);

  const transcript: Transcript = {
    language,
    source: 'asr',
    segments,
  };
  process.stdout.write(JSON.stringify(transcript));
}

// ESM "is this the entry module" guard: only auto-run main() when this file
// is executed directly as `node asrWorker.js <wav> <engine> <modelsDir>`
// (the worker CLI contract asr.ts's transcribeAudio() spawns) -- not when it
// is imported as a module, e.g. by tests exercising runVad/pickSenseVoiceLanguage
// in isolation. Without this guard, importing the compiled file would
// immediately run main() against the importer's own process.argv and, on
// the resulting "usage" error, call process.exit(1) -- killing whatever
// process did the importing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
}
