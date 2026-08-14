# Contributing

Contributions are genuinely welcome. This file is the practical version; `CLAUDE.md` is the deeper map of the codebase and its invariants, and is worth reading before a non-trivial change.

## The most valuable thing you can do

**Run the acceptance matrix against real URLs.**

`docs/acceptance-matrix.md` honestly reports **0 of 11 rows executed**. The platform list — YouTube, TikTok, Facebook, WeChat and the rest — is a list of *tested code paths*, not platforms anyone has watched succeed on live media. That gap is this project's single biggest unknown.

```bash
M_YT_MANUAL="https://..." M_TIKTOK="https://..." npm run matrix
```

Run it with whatever URLs you have, and open an issue with what you saw — including the failures, especially the failures. That converts the biggest unknown into fact, and it needs no knowledge of the internals.

Second most valuable: `docs/follow-ups.md` records every deliberately deferred item **with the reasoning that deferred it**. These are not vague "good first issue" labels — each one says what was tried and why it was left. Check it before reporting something as a gap; it may already be there with context.

## Setup

Requires **Node >= 26** and four system binaries that cannot come from npm:

```bash
brew install ffmpeg yt-dlp tesseract tesseract-lang   # macOS; use your package manager elsewhere

git clone https://github.com/yanlingLabs/video-extract-mcp.git
cd video-extract-mcp
npm install && npm run build
npm run preflight          # verifies ffmpeg / ffprobe / yt-dlp / tesseract
```

Speech models (~1.5 GB) are only needed for videos with **no captions at all** — the caption-first policy means most videos never touch them. Fetch them when you want to work on that path:

```bash
./scripts/fetch-models.sh   # into ./models, which takes precedence when present
```

## Read this before you run a single test

**`npx vitest run` does not build. Only `npm test` does** (via `pretest`).

Many test files load the **compiled** output rather than the source — `await import('../dist/...')` — so running them against a stale or missing `dist/` gives you results that have nothing to do with your edit. To see which:

```bash
grep -rl "dist/" tests/
```

When iterating on one file, rebuild between changes:

```bash
npm run build
npx vitest run tests/captions.test.ts
npx vitest run tests/captions.test.ts -t "partial test name"
```

This is not a style preference. Workers are resolved as siblings of the *running* module, so they only exist in compiled output; from `src/` the sibling is a `.ts` file and the spawn misses. The failure is **quiet** — the stage degrades, the run still reports success, and the only trace is a `processing.warnings` entry.

**A green run is not proof.** Many tests self-skip via `describe.skipIf(!ready)` when the speech models or system binaries are absent. Check the skip count, not just the pass count.

```bash
npm test           # full suite (builds first)
npm run typecheck  # strict, with noUncheckedIndexedAccess
npm run matrix     # acceptance matrix (honest about skips)
```

## The testing standard

**This project's most common review finding, by a wide margin, is a test that passes identically against broken code.** It has been found in nearly every task in the project's history — assertions that read values back out of the function's own return value, or that mock the very machinery under test.

So the bar for a new test is not "it passes". It is:

1. **Mutate the thing it guards and confirm it goes red.** If you cannot make it fail, it is not testing what you think.
2. **Assert independently-constructed expectations.** Not values derived from the code under test.
3. **Assert absence explicitly** — `expect('duration' in r).toBe(false)`, not `toBeFalsy()`. `toBe(0)` and `toBeFalsy()` both pass against several real bugs in this domain.
4. **Say what a test does *not* cover** when that is not obvious. A test whose comment claims more than it checks is worse than no test — it stops anyone looking again. (Real example: a test claiming to pin a file-existence check passed because an unrelated upstream filter made the input unreachable.)

Mention in your PR which mutation you used to verify a new test.

## Architecture

Four layers, and the boundaries carry weight:

```
src/mcp.ts                 MCP surface: zod schemas, tool descriptions,
                           task/concurrency/cancellation plumbing
src/agent/*Tool.ts         writes manifest/transcript/frames to destinationPath,
                           decides inline-vs-disk, never throws
src/analyze.ts             pipeline: resolve -> trim -> normalize -> transcript
                           -> frames -> manifest
src/{resolve,media,transcript,vision}/   subsystems
```

**`src/cli.ts` enters at `analyze.ts`, bypassing the agent layer entirely** — so the CLI and the MCP tools are *not* the same code path. A bug on the CLI path can be invisible to every MCP test. It has been.

`src/types.ts` is the single source of truth for shared types.

## Things that break quietly

`CLAUDE.md` documents these in full. The ones that most often catch people:

- **Heavy stages never overlap within one analysis.** Speech recognition and vision embedding each run in their own worker process that exits before the next starts. That is the entire memory strategy. Across *different* videos, up to `VIDEO_EXTRACT_MAX_CONCURRENCY` analyses run at once by design — memory is a per-concurrent-analysis rate (~1.1 GB), not a flat ceiling.
- **Degradation must stay visible.** An optional stage that fails and is skipped records a `processing.warnings` entry, so an empty transcript is distinguishable from a video with no speech. A stage skipped *by design* is not a degradation and must not fabricate a warning.
- **Cancellation is honest, never pretend.** Once any item starts executing, the task refuses cancellation rather than reporting `cancelled` while the work quietly finishes. Do not "fix" that refusal.
- **Status payloads carry observables, never verdicts.** No `stale`, `stuck`, `healthy`, or invented percentage — the reader judges slow-vs-stuck by polling twice and diffing. Tests grep for verdict words.
- **The MCP SDK is pinned to exactly `1.30.0`**, not a caret range — the tasks API lives under the SDK's `experimental/` namespace. Treat a bump as a deliberate, tested event and run `tests/taskSpike.test.ts` first.

**Tool descriptions in `src/mcp.ts` are the agent-facing contract, and are treated as seriously as code.** A description asserting behaviour the engine does not have is a defect, not a doc nit. If you change behaviour, change the description in the same PR.

## Honesty

The project has a hard rule against claims it cannot back:

- Do not let docs, comments, or tool descriptions imply the acceptance matrix has been run when it has not.
- Do not report a measurement that was not measured. Placeholder values must be distinguishable from real ones — this is why `duration` is `null` rather than `0` where the platform gives nothing.
- Record deliberate deferrals in `docs/follow-ups.md` with the reasoning, rather than leaving them implied.

If you find something that overstates, fixing the claim is a welcome PR on its own.

## One legal constraint

**WeChat Channels resolution was clean-room derived** from Tencent's own served frontend and authenticated probes. The well-known reference implementation is MIT + **Commons Clause**, which restricts commercial use. **Never consult it** when extending that code, and say so in your PR if you touch `src/resolve/wechat.ts`.

## Style

- **No Python.** Single Node runtime, ESM, TypeScript strict with `noUncheckedIndexedAccess`.
- Match the surrounding code's comment density and idiom. This codebase comments *why*, especially where a choice looks wrong until you know what it cost.
- Commits follow `type: summary` — `fix:`, `feat:`, `perf:`, `test:`, `docs:`, `refactor:`. Explain the reasoning in the body, not just the change.

## Pull request checklist

- [ ] `npm test` passes, and you checked the **skip count**
- [ ] `npm run typecheck` passes
- [ ] New tests verified by mutation — say which mutation in the PR
- [ ] Tool descriptions in `src/mcp.ts` updated if behaviour changed
- [ ] `docs/follow-ups.md` updated if you deliberately deferred something
- [ ] No claim in docs or comments that the code does not back

Open an issue first for anything large, so the design can be discussed before you spend the time. Questions are welcome as issues too — if something here was unclear, that is a documentation bug worth reporting.

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
