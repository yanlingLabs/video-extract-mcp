import { writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import type { AnalyzeOptions, Manifest, ResolveStatus } from '../src/types.js';
import { isMainModule } from '../src/util/entry.js';

// Implements spec §20 -- this IS the acceptance test for network-touching
// behaviour. Sixteen earlier tasks proved the pipeline against a synthetic
// local fixture; this script is the only thing that can prove any claim
// about real platforms (YouTube captions/ASR routing, TikTok's burned-in
// subtitles not flooding the frame budget, a DRM page failing cleanly,
// etc). Its honesty is the whole point: a row that never ran must be
// impossible to mistake for a row that passed.

export interface MatrixCase {
  name: string;
  url: string;
  opts?: AnalyzeOptions;
  expectStatus: ResolveStatus;
  proves: string;
  /** Extra env vars (beyond `url`) that must be non-blank for this case to run. */
  requiresEnv?: string[];
}

// Fill in concrete URLs before the first real run; one case per spec §20 row.
// The WeChat row additionally requires VIDEO_EXTRACT_WECHAT_COOKIE -- deliberately
// left unset until the clean-room resolver (experiments/wechat-clean-room/)
// is validated, so that row stays an honest SKIP rather than a false FAIL
// against a resolver everyone already knows isn't ready.
export const CASES: MatrixCase[] = [
  { name: 'youtube-manual-captions', url: process.env.M_YT_MANUAL ?? '', expectStatus: 'ok', proves: 'caption tier 1 + alignment' },
  { name: 'youtube-no-captions', url: process.env.M_YT_NOCAP ?? '', expectStatus: 'ok', proves: 'VAD -> Whisper ASR' },
  { name: 'tiktok-burned-in-subs', url: process.env.M_TIKTOK ?? '', expectStatus: 'ok', proves: 'subtitle-aware OCR does not over-select' },
  { name: 'facebook-reel', url: process.env.M_FACEBOOK ?? '', expectStatus: 'ok', proves: 'Facebook extraction' },
  { name: 'login-walled', url: process.env.M_AUTH ?? '', expectStatus: 'auth_required', proves: 'clean auth_required' },
  { name: 'direct-mp4', url: process.env.M_MP4 ?? '', expectStatus: 'ok', proves: 'DirectMediaResolver' },
  { name: 'generic-embed', url: process.env.M_EMBED ?? '', expectStatus: 'ok', proves: 'yt-dlp generic extraction' },
  { name: 'wechat-share', url: process.env.M_WECHAT ?? '', expectStatus: 'ok', proves: 'headless WeChat + SenseVoice', requiresEnv: ['VIDEO_EXTRACT_WECHAT_COOKIE'] },
  { name: 'chinese-video', url: process.env.M_ZH ?? '', opts: { preferredLanguage: 'zh' }, expectStatus: 'ok', proves: 'SenseVoice routing' },
  { name: 'drm-page', url: process.env.M_DRM ?? '', expectStatus: 'unsupported', proves: 'clean unsupported/drm_protected' },
  { name: 'range-23-60', url: process.env.M_YT_MANUAL ?? '', opts: { start: 23, end: 60 }, expectStatus: 'ok', proves: 'range slice + fallback' },
];

// ---------------------------------------------------------------------------
// Pure logic: skip detection, outcome classification, row/document rendering.
// Kept free of I/O and of analyzeVideo itself so all of it is unit-testable
// without a network connection (tests/matrix.test.ts).
// ---------------------------------------------------------------------------

/** Null when the case is runnable; otherwise the human-readable reason it is not. */
export function skipReason(c: MatrixCase): string | null {
  if (!c.url.trim()) return 'no URL configured';
  const missing = (c.requiresEnv ?? []).filter((k) => !(process.env[k] ?? '').trim());
  if (missing.length > 0) return `missing required env: ${missing.join(', ')}`;
  return null;
}

export type RowOutcome = 'PASS' | 'FAIL' | 'SKIP' | 'TIMEOUT';

export type CaseExecution =
  | { kind: 'skipped'; reason: string }
  | { kind: 'timeout'; ms: number }
  | { kind: 'threw'; message: string }
  | { kind: 'ran'; status: string; frames: number; candidates: number; transcriptSource: string | null; peakRssMb: number };

/**
 * The one comparison the whole matrix hinges on. Deliberately a bare
 * equality check against whatever expectStatus says -- NOT an "is it ok"
 * check -- so rows that expect a failure status (login-walled/auth_required,
 * drm-page/unsupported) pass by matching that status, exactly like every
 * other row, instead of needing special-cased logic that's easy to get
 * backwards (task-17-brief.md's own explicit warning).
 */
export function classifyOutcome(expectStatus: ResolveStatus, exec: CaseExecution): RowOutcome {
  if (exec.kind === 'skipped') return 'SKIP';
  if (exec.kind === 'timeout') return 'TIMEOUT';
  if (exec.kind === 'threw') return 'FAIL';
  return exec.status === expectStatus ? 'PASS' : 'FAIL';
}

export interface MatrixResult {
  name: string;
  proves: string;
  expectStatus: ResolveStatus;
  outcome: RowOutcome;
  status: string;
  frames: number | null;
  candidates: number | null;
  transcriptSource: string | null;
  peakRssMb: number | null;
}

/** Redacts the operator's home-directory path and OS username from free text
 * before it can reach a committed document (thrown-error messages routinely
 * embed absolute filesystem paths). Never hardcodes the literal username --
 * it is read from the OS at the time sanitize() runs, so this file itself
 * never carries anyone's username in its own committed source. Also makes
 * the text safe to interpolate into a markdown table cell: a raw '|' or line
 * break in a thrown-error message (ffmpeg/yt-dlp stderr routinely contains
 * both) corrupts the row's column count once rendered -- a GFM renderer
 * either truncates a row with more pipe-delimited cells than the header,
 * silently dropping the true trailing Pass token off the end, or splits the
 * row across two source lines at the newline, losing the Pass cell from the
 * table entirely. That is the exact ambiguous-cell failure the
 * YES/NO/SKIP/TIMEOUT redesign exists to rule out, reintroduced through a
 * different door -- found in code review, reproduced with
 * `usage: tool --a=1|--b=2 failed | exit 1\nsecond line | more pipes |||`
 * against the pre-fix code (see tests/matrix.test.ts and task-17-report.md).
 * Escaped/collapsed rather than dropped, so the diagnostic text survives. */
export function sanitize(text: string): string {
  let out = text.replace(/\/Users\/[^\s'"()]+/g, '[REDACTED_PATH]');
  const user = safeUsername();
  if (user.length > 0) out = out.split(user).join('[REDACTED_USER]');
  out = out.replace(/\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ').trim();
  out = out.replace(/\|/g, '\\|');
  return out;
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

const DETAIL_MAX = 200;

export function toMatrixResult(c: MatrixCase, exec: CaseExecution): MatrixResult {
  const outcome = classifyOutcome(c.expectStatus, exec);
  const base = { name: c.name, proves: c.proves, expectStatus: c.expectStatus, outcome };
  if (exec.kind === 'skipped') {
    return { ...base, status: `SKIPPED (${sanitize(exec.reason)})`, frames: null, candidates: null, transcriptSource: null, peakRssMb: null };
  }
  if (exec.kind === 'timeout') {
    return { ...base, status: `TIMEOUT (>${exec.ms}ms)`, frames: null, candidates: null, transcriptSource: null, peakRssMb: null };
  }
  if (exec.kind === 'threw') {
    return { ...base, status: `ERROR: ${sanitize(exec.message).slice(0, DETAIL_MAX)}`, frames: null, candidates: null, transcriptSource: null, peakRssMb: null };
  }
  return {
    ...base, status: exec.status, frames: exec.frames, candidates: exec.candidates,
    transcriptSource: exec.transcriptSource, peakRssMb: exec.peakRssMb,
  };
}

// Deliberately four distinct, non-abbreviated tokens (never '-', never blank)
// so a skipped or timed-out row can never be misread as a pass or an
// ordinary fail -- the property tests/matrix.test.ts tests most heavily.
const PASS_TOKEN: Record<RowOutcome, string> = { PASS: 'YES', FAIL: 'NO', SKIP: 'SKIP', TIMEOUT: 'TIMEOUT' };

function cell(v: number | string | null): string {
  return v === null ? '-' : String(v);
}

export function formatRow(r: MatrixResult): string {
  return `| ${r.name} | ${r.proves} | ${r.status} | ${r.expectStatus} | ${cell(r.frames)} | ${cell(r.candidates)} | ${cell(r.transcriptSource)} | ${cell(r.peakRssMb)} | ${PASS_TOKEN[r.outcome]} |`;
}

export function formatConsoleLine(r: MatrixResult): string {
  const rss = r.peakRssMb !== null ? ` (peak ${r.peakRssMb} MB)` : '';
  return `${r.outcome} ${r.name} -> ${r.status}${rss}`;
}

export interface MatrixSummary {
  total: number; executed: number; skipped: number; passed: number; failed: number; timedOut: number;
}

export function summarize(results: MatrixResult[]): MatrixSummary {
  const skipped = results.filter((r) => r.outcome === 'SKIP').length;
  const passed = results.filter((r) => r.outcome === 'PASS').length;
  const failed = results.filter((r) => r.outcome === 'FAIL').length;
  const timedOut = results.filter((r) => r.outcome === 'TIMEOUT').length;
  return { total: results.length, executed: results.length - skipped, skipped, passed, failed, timedOut };
}

export function renderDocument(results: MatrixResult[], opts: { generatedAt?: Date } = {}): string {
  const s = summarize(results);
  const generatedAt = (opts.generatedAt ?? new Date()).toISOString();

  const headerLines = [
    '# Acceptance Matrix',
    '',
    `Generated by \`npm run matrix\` at ${generatedAt}. Implements spec §20 (network-facing acceptance test).`,
    '',
    `**${s.executed} of ${s.total} rows executed; ${s.skipped} of ${s.total} skipped.**`,
  ];
  if (s.executed > 0) {
    headerLines.push(`**Of the executed rows: ${s.passed} passed, ${s.failed} failed, ${s.timedOut} timed out.**`);
  }
  if (s.executed === 0) {
    headerLines.push(
      '',
      '> **UNPROVEN.** Every row below is a SKIP: no row in this matrix has been run',
      '> against a real URL. This document proves nothing yet about the engine\'s',
      '> network-facing behaviour -- it only confirms the runner itself completes',
      '> cleanly with no configuration. Set the `M_*` environment variables (and,',
      '> for the WeChat row, `VIDEO_EXTRACT_WECHAT_COOKIE`) and re-run `npm run matrix`.',
    );
  }

  const table = [
    '| Case | Proves | Status | Expected | Frames | Cands | Transcript | Peak RSS (MB) | Pass |',
    '|---|---|---|---|---:|---:|---|---:|:--:|',
    ...results.map(formatRow),
  ];

  const footer = [
    '',
    '## Summary',
    '',
    `- Rows total: ${s.total}`,
    `- Executed: ${s.executed}`,
    `- Skipped: ${s.skipped}`,
    `- Passed: ${s.passed}`,
    `- Failed: ${s.failed}`,
    `- Timed out: ${s.timedOut}`,
    '',
    'Memory target: peak RSS should trend below 2048 MB for the complete tool (spec §4).',
    '',
  ];

  return [...headerLines, '', ...table, ...footer].join('\n');
}

// ---------------------------------------------------------------------------
// Impure: running a case for real, and the top-level driver.
// ---------------------------------------------------------------------------

export type AnalyzeFn = (url: string, opts?: AnalyzeOptions) => Promise<Manifest>;

const TIMEOUT_SENTINEL: unique symbol = Symbol('matrix-timeout');

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT_SENTINEL> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
    // Promise.race([p, timeout]) already attaches its own rejection handler
    // to `p` as part of racing it (per spec it calls p.then(resolve, reject)
    // on every promise in the list up front), so a late rejection from an
    // abandoned `p` is never actually "unhandled" here even without the line
    // below -- verified directly by temporarily deleting it and re-running
    // tests/matrix.test.ts's differential check, which passed identically
    // either way. Kept anyway as defense-in-depth: if withTimeout is ever
    // rewritten to stop racing `p` directly (e.g. manual settle-tracking
    // instead of Promise.race), this line is what would then stand between
    // one hung URL's later rejection and an unhandled-rejection crash of the
    // whole matrix run. Does not cancel the underlying work either way --
    // Node has no general promise cancellation.
    p.catch(() => {});
  }
}

// Real videos over a real network can legitimately take a couple of minutes
// (resolve + normalize + ASR + embedding, each a subprocess model load) --
// generous enough not to punish a slow-but-healthy case, short enough that
// one bad URL cannot stall the whole matrix (task-17-brief.md's own concern).
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_OUT_FILE = 'docs/acceptance-matrix.md';

let realAnalyze: AnalyzeFn | null = null;

/**
 * Lazily loads the REAL analyzeVideo from the COMPILED dist/ output, never
 * from src/. This is not a style choice: src/transcript/asr.ts and
 * src/vision/embed.ts locate their worker scripts via
 * `dirname(fileURLToPath(import.meta.url)) + 'xWorker.js'`, resolved
 * relative to wherever the importing module physically lives. Loading the
 * TS source directly (as tsx's own .js -> .ts resolution would do for a
 * plain '../src/analyze.js' specifier) points that lookup at
 * src/transcript/ and src/vision/, which hold only .ts originals -- both
 * workers then fail to spawn (ENOENT/MODULE_NOT_FOUND), and analyze.ts's
 * own `.catch(() => null / [])` swallows that, silently downgrading every
 * row to transcript:null + no embeddings while STILL reporting status:'ok'.
 * That is exactly the false-confidence failure mode this whole task exists
 * to rule out. Verified for the identical trap in
 * tests/analyze.integration.test.ts (see task-14-report.md); requires
 * `npm run build` before `npm run matrix` (see the npm script and the brief).
 *
 * Deferred (not a top-level import) so unit tests that inject their own
 * `analyze` never need dist/ to exist at all. Also never called eagerly by
 * runMatrix -- see execCase below, where the call site was moved after a
 * code-review finding.
 */
async function getRealAnalyze(): Promise<AnalyzeFn> {
  if (!realAnalyze) {
    // dist/ now ships .d.ts files (tsconfig "declaration": true), so this
    // specifier types itself directly -- no cast through the TS source needed.
    const mod = await import('../dist/analyze.js');
    realAnalyze = mod.analyzeVideo;
  }
  return realAnalyze;
}

export async function execCase(
  c: MatrixCase,
  opts: { timeoutMs: number; analyze?: AnalyzeFn; resolveAnalyze?: () => Promise<AnalyzeFn> },
): Promise<CaseExecution> {
  const reason = skipReason(c);
  if (reason) return { kind: 'skipped', reason };
  try {
    // Resolving the real analyzeVideo (a dynamic import of dist/analyze.js)
    // happens HERE -- after the skip check, inside this try/catch -- and
    // nowhere else. A code-review finding caught an earlier version that
    // resolved it unconditionally at the top of runMatrix, before any
    // per-case skip check ran: on a fresh checkout dist/ does not exist
    // (gitignored, no build/postinstall hook creates it), so that version
    // threw ERR_MODULE_NOT_FOUND and crashed the whole process before
    // writing ANY document at all -- even when every configured case would
    // have skipped anyway for want of a URL. That is precisely the "nothing
    // configured" state this task exists to handle honestly. Placing the
    // resolution here fixes both halves of that: it is never attempted for
    // a case that would skip regardless, and if it DOES fail for a case
    // that genuinely has a URL (e.g. `npm run build` was never run), the
    // failure is caught by the same catch block as any other analyze()
    // failure and surfaces as an honest FAIL row with a diagnostic message,
    // not a crash with no document at all.
    const analyze = opts.analyze ?? (await (opts.resolveAnalyze ?? getRealAnalyze)());
    // Per-case destination, keyed by case name so a re-run overwrites in
    // place rather than scattering a fresh directory (and a fresh copy of
    // every candidate/frame image) per invocation -- gitignored (/scratch/),
    // never created for a case that skips (this string is pure, and
    // analyzeVideo itself is what mkdirSync's it -- src/analyze.ts:75 --
    // only once a case actually runs). Safe to reuse across runs: unlike
    // primitives.ts's getClip (before its own fix), neither extractCandidates
    // (src/media/candidates.ts) nor sampleEven (src/vision/even.ts) build
    // their return value by readdir-scanning outDir -- both return exactly
    // what their own loop produced this call, so a stale file left over from
    // an earlier, larger-budget run cannot inflate this run's counts.
    //
    // Both AnalyzeOptions fields that name a destination are set, but only
    // one is real here: `outDir` is what analyzeVideo actually reads
    // (src/analyze.ts:74, the mkdtempSync fallback it replaces). `destinationPath`
    // is inert at this layer -- analyzeVideo never reads it, only
    // analyzeVideoTool (src/agent/analyzeTool.ts, the MCP-facing wrapper)
    // does, and this runner deliberately calls analyzeVideo directly (see
    // the header comment: this proves the pipeline, not the MCP schema
    // layer). Set anyway since it is a real, documented AnalyzeOptions field
    // and leaving it unset relies on every case implicitly agreeing to skip
    // it.
    const outDir = join('scratch', 'matrix', c.name);
    const result = await withTimeout(
      analyze(c.url, { maxFrames: 20, destinationPath: outDir, outDir, ...c.opts }),
      opts.timeoutMs,
    );
    if (result === TIMEOUT_SENTINEL) return { kind: 'timeout', ms: opts.timeoutMs };
    return {
      kind: 'ran',
      status: result.source.status,
      frames: result.processing.selectedFrames,
      candidates: result.processing.candidateFrames,
      transcriptSource: result.transcript?.source ?? 'none',
      peakRssMb: result.processing.peakRssMb,
    };
  } catch (e) {
    return { kind: 'threw', message: e instanceof Error ? e.message : String(e) };
  }
}

export async function runMatrix(
  cases: MatrixCase[] = CASES,
  opts: {
    timeoutMs?: number; outFile?: string; analyze?: AnalyzeFn; now?: () => Date;
    resolveAnalyze?: () => Promise<AnalyzeFn>;
  } = {},
): Promise<MatrixResult[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outFile = opts.outFile ?? DEFAULT_OUT_FILE;

  const results: MatrixResult[] = [];
  for (const c of cases) {
    const exec = await execCase(c, { timeoutMs, analyze: opts.analyze, resolveAnalyze: opts.resolveAnalyze });
    const result = toMatrixResult(c, exec);
    results.push(result);
    console.log(formatConsoleLine(result));
  }

  writeFileSync(outFile, renderDocument(results, { generatedAt: opts.now?.() ?? new Date() }));
  return results;
}

// isMainModule (src/util/entry.ts) realpaths both sides: robust to the
// percent-encoded space in this repo's own path (the original bug here --
// `npm run matrix` exited 0 having written nothing) AND to symlinked
// invocation paths, which defeated even the pathToFileURL comparison
// because Node realpaths the main module while argv[1] stays as typed.
// Same guard now used by src/cli.ts, src/mcp.ts and scripts/preflight.ts.
if (isMainModule(import.meta.url)) {
  // MATRIX_TIMEOUT_MS: a whole-video row on a long video (a 20-minute talk)
  // needs longer than the default to download and analyze.
  const fromEnv = Number(process.env['MATRIX_TIMEOUT_MS']);
  const results = await runMatrix(CASES, Number.isFinite(fromEnv) && fromEnv > 0 ? { timeoutMs: fromEnv } : {});
  const s = summarize(results);
  console.log(`\n${s.executed} of ${s.total} rows executed (${s.skipped} skipped). Of executed: ${s.passed} passed, ${s.failed} failed, ${s.timedOut} timed out.`);
  if (s.failed > 0 || s.timedOut > 0) process.exitCode = 1;
}
