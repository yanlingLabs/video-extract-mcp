export type AsrEngine = 'sensevoice' | 'whisper';

/** Spec §9: an explicit language set, not a vague "CJK-heavy" heuristic. */
const SENSEVOICE_LANGS = new Set(['zh', 'yue', 'ja', 'ko']);

/** Exported so asrWorker.ts can reuse the same locale-normalization rules for
 * post-hoc language labeling (see pickSenseVoiceLanguage) instead of
 * duplicating them. */
export function baseLang(tag: string | null | undefined): string | null {
  if (!tag) return null;
  return tag.toLowerCase().split(/[-_]/)[0] ?? null;
}

export function chooseAsrEngine(
  input: { preferredLanguage?: string; languageHint?: string | null },
): AsrEngine {
  const lang = baseLang(input.preferredLanguage) ?? baseLang(input.languageHint);
  return lang && SENSEVOICE_LANGS.has(lang) ? 'sensevoice' : 'whisper';
}

/**
 * sherpa-onnx-node@1.13.4's SenseVoice `OfflineRecognizerResult.lang` is
 * empirically CONSTANT ("<|yue|>") regardless of the true spoken language --
 * verified against 5 real languages (en/ja/ko/zh/yue), 7 different
 * senseVoice.language model-config values (unset, '', 'auto', 'zh', 'en',
 * 'ja', 'ko', 'yue'), and fresh OfflineRecognizer instances per call, while
 * `.text` correctly varied by script/language throughout (task-11-report.md
 * has the full raw sweep). A field that never varies with input carries no
 * information; trusting it as-is would just swap "always zh" for "always
 * yue" -- the exact bug class pickSenseVoiceLanguage exists to fix. So the
 * literal artifact value is excluded from consideration below; only a
 * DIFFERENT normalized value (e.g. a future sherpa-onnx-node build that
 * actually varies its output, or a differently-behaved model/platform)
 * counts as real signal.
 */
const SENSEVOICE_LID_ARTIFACT = 'yue';

function normalizeSenseVoiceLang(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // SenseVoice's raw lang token is wrapped like "<|ja|>"; strip the wrapper
  // before running it through the same lowercase+split normalization as
  // preferredLanguage/languageHint.
  return baseLang(raw.replace(/^<\|/, '').replace(/\|>$/, ''));
}

/**
 * Picks the transcript-level `language` for a SenseVoice run from each
 * decoded segment's raw recognizer `.lang` value. Majority vote across
 * segments that carry real signal (i.e. not the constant artifact above);
 * when none do -- the only case actually reachable on sherpa-onnx-node
 * 1.13.4 today -- falls back to the caller's explicit preferredLanguage if
 * one was given, else 'auto'. Never asserts a language nobody observed.
 */
export function pickSenseVoiceLanguage(
  rawLangs: Array<string | null | undefined>,
  preferredLanguage?: string,
): string {
  return pickDetectedLanguage(rawLangs, preferredLanguage, SENSEVOICE_LID_ARTIFACT);
}

/**
 * Whisper's counterpart. Unlike SenseVoice on this sherpa-onnx build, Whisper's
 * per-segment `.lang` is real language identification (measured: "pt" on
 * every segment of a Portuguese song), so a majority vote over it is the
 * transcript language. Before this, the Whisper path always reported 'auto',
 * even on a video whose platform metadata and speech were both plainly
 * Portuguese.
 */
export function pickWhisperLanguage(
  rawLangs: Array<string | null | undefined>,
  preferredLanguage?: string,
): string {
  return pickDetectedLanguage(rawLangs, preferredLanguage, null);
}

function pickDetectedLanguage(
  rawLangs: Array<string | null | undefined>,
  preferredLanguage: string | undefined,
  artifact: string | null,
): string {
  const counts = new Map<string, number>();
  for (const raw of rawLangs) {
    const lang = normalizeSenseVoiceLang(raw);
    if (!lang || lang === artifact) continue; // no usable signal
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [lang, count] of counts) {
    if (count > bestCount) { best = lang; bestCount = count; }
  }
  return best ?? baseLang(preferredLanguage) ?? 'auto';
}
