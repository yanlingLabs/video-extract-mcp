# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                              # full suite; `pretest` runs the build first
npm run build                         # tsc -> dist/
npm run typecheck                     # build + strict pass (tsconfig.typecheck.json)
npm run preflight                     # verify ffmpeg / ffprobe / yt-dlp / tesseract
npm run check:lockfile                # the CI guard against npm-10 lockfile damage
npm run matrix                        # acceptance matrix (see "Honesty" below)
npm run cli -- <url> [flags]          # CLI; builds first
```

Single test file or single test:

```bash
npm run build                         # REQUIRED first — see below
npx vitest run tests/captions.test.ts
npx vitest run tests/captions.test.ts -t "partial test name"
```

**`npx vitest run` does not build.** Only `npm test` does (via `pretest`). Many test
files `vi.mock` and `await import('../dist/...')`, so running them against a stale or
missing `dist/` gives results that have nothing to do with your edit. When
iterating on a single file, rebuild between changes. For the current list, run
`grep -rl "dist/" tests/` — deliberately not a count here, since the number grew
from 9 to 16 while this line still said "nine".

Many tests self-skip via `describe.skipIf(!ready)` when the ~1.5 GB speech models
or system binaries are absent. A green run is not proof those paths ran — check
the skip count.

## Architecture

Four layers. Read them in this order; each one's responsibility is genuinely
distinct and the boundaries are load-bearing.

```
src/mcp.ts                  MCP surface: zod schemas + tool descriptions,
                            plus task/concurrency/cancellation plumbing
                            (slot pool, HonestCancelStore) -- orchestration.
                            The analysis logic itself still lives below.
src/agent/*Tool.ts          Agent layer: writes manifest/transcript/frames to
                            destinationPath, decides inline-vs-disk, never throws.
src/analyze.ts              Pipeline orchestrator: resolve -> trim -> normalize
                            -> transcript -> frames -> manifest.
src/{resolve,media,transcript,vision}/   Subsystems.
```

**`src/cli.ts` enters at `analyze.ts`, bypassing the agent layer entirely.** So the
CLI and the MCP tools are *not* the same code path — the disk-first output policy
and inline-transcript threshold are agent-layer behaviour the CLI does not get.
A bug in the CLI path can be invisible to every MCP test, and was: see the
`processing.warnings` note below.

The tool descriptions in `src/mcp.ts` are the agent-facing contract and are treated
as seriously as code. A description asserting behaviour the engine does not have is
a defect, not a doc nit.

## Invariants that break quietly if violated

**Staged memory is a per-concurrent-analysis rate, not a flat ceiling.** Within one
analysis, speech recognition and vision embedding are still heavy models that must
never be resident together — each runs in its own worker process
(`transcript/asrWorker.ts`, `vision/embedWorker.ts`) that exits before the next
stage starts. Anything that lets two heavy stages overlap *within an item* is a
serious defect. Across items, `VIDEO_EXTRACT_MAX_CONCURRENCY` (default 2) caps how
many `analyze_video` item executions run at once — plain calls and tasks, batch
items and separate calls, identically; `resolve_video` is exempt. Peak per concurrent
analysis is set by the speech model, measured: ~2.0 GB with Whisper (every non-CJK
video without usable captions), ~1.1 GB with SenseVoice, <1 GB when captions supply
the transcript. Default cap 2 ⇒ plan for ~4 GB worst case (it was 4, i.e. ~8 GB, until
0.14.0 measured Whisper). The older "~1.1 GB per
analysis" figure was the SenseVoice number applied to both engines. What the Whisper
worker's ~2 GB is: ~0.86 GB to load whisper-small int8 (374 MB on disk), ~0.9 GB more
on the first decode; thread count does not move it (1.85 GB at 1 thread, 1.94 at 4).
The worker streams its WAV and decodes each VAD segment as it is emitted
(`streamVad`, `openPcm16Wav`) -- holding the whole waveform plus every segment cost
~128 KB per second of audio. What remains length-dependent is a creep inside
sherpa-onnx of ~0.7 MB per decoded segment that forcing GC does not remove: 2.00 GB
on a 4.4-minute clip, 2.14 GB on 26 minutes (70 segments). Not measured beyond that.

**0.2.0 is a breaking change to both tools' call shape** (README.md has the full
note): 0.1.x's top-level `url`/`pathOrUrl` became a required `videos` array, one
entry per video. The on-disk layout at `videos.length === 1` is unaffected — see
below — but the JSON reply shape changed for every call, even N=1.

**Batch layout: flat at N=1, `video-N/` at N>1.** A one-item `videos` array writes
exactly where 0.1.x did -- same paths, though no longer the same FILE SET: as of
0.8.0 intermediates (candidate frames, the second video copy, caption files) stay
in a scratch subdirectory and are discarded, so `source.mp4` alongside `work.mp4`
is gone and only the video `videoPath` names is delivered. Two or more items each get their own
`destinationPath/video-1/`, `video-2/`, ... (1-based, array order), so per-item
`manifest.json`/`metadata.json` never collide. `itemDir` (`src/agent/analyzeTool.ts`)
is the one place this decision lives — do not reimplement the branch elsewhere.

**The MCP SDK is pinned to exactly `1.30.0`, not a caret range.** The tasks API this
project depends on lives under the SDK's `experimental/` namespace, which warns it
may change without notice — an unpinned upgrade could silently change task or
cancellation behavior underneath every task/cancellation test in the suite. Treat an
SDK bump as a deliberate, tested event: update the pin, then run
`tests/taskSpike.test.ts` first, before touching anything else — it is the tripwire
that pins the exact API facts (`task-1-report.md`) the rest of the task/batching
design depends on.

**Cancellation is honest, never pretend.** A task none of whose items has started
executing cancels fully. The moment any item's execution begins, the whole task
refuses cancellation — identically for both tools — with a message saying it will
finish and deliver its result; this is per-task, not per-item, so a batch with one
item already running still refuses even while the rest are queued. `resolve_video`
never queues (it bypasses the analyze pool entirely), so every cancel on a live
`resolve_video` task hits this refusal — it has no cancellable window at all.
`HonestCancelStore` (`src/mcp.ts`) enforces this. Do not "fix" a refusal into a
pretend-cancel that reports `cancelled` while the work quietly finishes underneath —
that is exactly the dishonesty class this project exists to kill.

**The status registry is per-server and in-memory, never persisted.**
`createStatusRegistry()` (`src/status/registry.ts`) is instantiated once per
`buildServer()` call — no module-level registry, the same no-shared-mutable-state
rule `store`/`pool` already follow. The only files the whole status feature ever
writes are the discovery entries, one per live server
(`~/.cache/video-extract-mcp/servers/<pid>.json`, `src/status/discovery.ts`,
overridable via the test-facing `VIDEO_EXTRACT_CACHE_DIR`) — each written once at
server start, removed once at exit, and removed by readers only when a liveness
check actually finds that pid dead. One file per pid, not one shared file, is
deliberate: it removes the simultaneous-server-start race entirely (final
whole-branch review, Important finding 3) rather than narrowing it — two servers
starting at the same instant write to two different paths, so there is no shared
state for a read-modify-write to lose an entry over. Nothing about a stage
transition ever touches disk.

**Status payloads and CLI output carry observables, never verdicts.** No `stale`,
`stuck`, `healthy`, or fabricated percentage may ever appear in the `/status` JSON
or the `video-extract status` render — tests grep both the payload and the
rendered text for verdict words. The reader (agent or human) judges slow-vs-stuck
itself, by polling twice and diffing `childCpuSeconds`/`workDirBytes`. Do not add a
health/staleness field to make the output more readable — that judgment belongs to
the caller, not this server.

**The status endpoint must stay unref'd.** `src/status/endpoint.ts`'s listener and
every accepted socket call `.unref()` so a live endpoint can never hold the process
open — the exact 0.2.0 zombie-process class this feature must not reintroduce.
`tests/mcpProcessLifecycle.test.ts` guards this with the endpoint genuinely live;
dropping both unref calls together fails it — the only combination actually
verified, so do not assume either call alone is redundant.

**Workers are resolved as siblings of the *running* module**, so they only exist in
compiled output — from `src/` under tsx the sibling is a `.ts` file and the spawn
misses. The failure is quiet: the stage degrades, and the only trace is a
`processing.warnings` entry, so the run still "succeeds" with every embedding
missing. Any entry point must run `dist/`.

**Image embeddings fall back to WebAssembly only when the native runtime cannot
load.** `@huggingface/transformers`' Node build imports `onnxruntime-node` at the top,
and onnxruntime-node 1.24+ ships no Intel Mac binary at all (the older Intel builds
need libc++ symbols that only arrive in macOS 13; PR #5). So `embedWorker.ts` imports
transformers dynamically, and only a failure of that import switches it to
`src/vision/embedWasm.ts`: onnxruntime-web, the same model file in the same cache
directory, and a `processing.warnings` entry. A model download or inference failure on
a working native runtime is not a reason to switch. The preprocessing there is a
re-implementation, pinned pixel-for-pixel against transformers' own by
`tests/embedWasm.test.ts`; `tests/embedWorkerFallback.integration.test.ts` blocks the
native binding with an `--import` fixture so the real path runs on any machine.
Measured on picture-like images: cosine >= 0.996 against native and frame-to-frame
similarity within 0.02, on Apple Silicon and Linux x64 (random noise agrees less, which
once made this test flaky); ~186 ms per image against ~28 ms, ~630 MB peak, inside the
per-analysis budget. `onnxruntime-web` is a direct dependency pinned
to exactly the version transformers requires, so npm keeps one copy (a second one is
~145 MB); bump the two together.

**Regenerate `package-lock.json` only with npm 11 or newer.** npm 10, the one bundled
with Node 22, rebuilds a lockfile from an existing `node_modules` without the other
platforms' optional binaries, so installs break everywhere else while the diff looks
routine (reproduced; it is how PR #5 arrived). `npm run check:lockfile` runs in CI and
also rejects entries missing `resolved`/`integrity`.

**Degradation must stay visible.** An optional stage that fails and is skipped past
records a `processing.warnings` entry, so an empty transcript is distinguishable
from a video with no speech. A stage skipped *by design* (frame-mode short circuits)
is not a degradation and must not fabricate a warning.

**`userCookies` is consent for one call, never remembered permission.** A caller can
never name a cookie file or a browser; `userCookies: true` means only "the user said yes
to their own default browser, this call" (`src/util/browsers.ts`). Rules that each cost
a real mistake or were measured:
- **The browser opened is the browser read.** On this machine Safari was the default
  while `detectBrowser()` found Chrome first; opening one and polling the other waits
  forever. `browserForCall()` is the one place that decides.
- **What is remembered is the WeChat SESSION, in memory** (`src/resolve/wechatSession.ts`),
  so a second call skips the browser read and its Keychain prompt. A call without
  `userCookies` never uses it. Nothing is written to disk except the jar yt-dlp exports,
  for the moment it takes to read it (not `/dev/stdout`, which hung; see follow-ups §K).
- **`getuserinfo` decides which cookie is right, and renews it.** A 200 there can carry
  a fresh `hy_token` in Set-Cookie (measured on an aging token); `applyRenewal` puts it
  in the header the rest of the resolve uses. Measured: `hy_token` + `hy_user` are the
  session; everything the browser would send to that URL is sent anyway.
- **No cookie value reaches a message.** yt-dlp's output is never forwarded from the jar
  read (stdout can hold cookies); failures are fixed sentences. Tests grep for a marker.
- **A sign-in is asked for on our own page, never by opening a login cold**
  (`src/util/signInPage.ts`, 127.0.0.1, random port and path, exact-Host and Origin
  checks, nonce CSP, everything escaped, unref'd). It carries no credential. A bare
  yuanbao.tencent.com login popping up was alarming in real use, and the page's first
  version, a card of explanations and buttons, still "looked like a scam". The page is
  now the user's own design: a few centred lines of monospace text naming the MCP client
  (`requesterLabel(getClientVersion().name)`; Claude Code sends "Claude Code"), the
  missing cookies, and the sign-in URL in green, plus "[don't sign in]", which ends the
  wait at once. Keep it that plain.
- **Sign-in waits are bounded** (3 minutes) and count as execution, so the
  honest-cancel rule makes the item uncancellable while it waits; the tool description
  tells the agent the call may wait that long. Concurrent WeChat items share one read and
  one page.
- **A yt-dlp site gets a retry only on a sign-in signal** (`src/resolve/siteSignIn.ts`):
  the page's button, or a new cookie NAME for that host. Never on a timer, and never on
  value churn -- every retry is a request to the platform, and repeated ones provoke its
  rate limiter. At most 3. Only for a `userCookies` call: a browser from the environment
  gets the old one-line hint, since nobody said yes to a page.
- **The WeChat session is process-lifetime module state, on purpose** -- an exception to
  the per-`buildServer()` rule above, because a session has to outlive the call that got
  it. It hangs off `DEFAULT_RESOLVERS`' `WeChatHeadlessResolver`; a test that needs
  isolation constructs `new WeChatHeadlessResolver(new WeChatSession(deps))`.

**Partial downloads are written under `.part` and promoted on completion.**
`src/util/partials.ts` owns this. It exists for the shape where none of our
cleanup code runs at all — a killed process, a crash, a power cut: the only
protection left is the name the bytes were written under, so a truncated
file can never be mistaken for a finished `source.mp4`.

Three rules, each of which cost a real bug:
- **The pattern is anchored to `source.`, not to `.part`.** `.part` is a
  shared convention (Firefox, a user's own yt-dlp), so a bare suffix match
  inside the caller's directory deletes THEIR files — while missing the
  litter yt-dlp actually leaves (`-FragN`, `.ytdl`, per-format `source.<id>.<media ext>`,
  and a truncated `source.temp.mp4`, which wears a media extension).
- **Cleanup is age-gated, always, with no override.** Neither a directory
  sweep nor a before/after snapshot can distinguish an abandoned partial
  from a concurrent call's live one — yt-dlp reuses the same names across
  calls. A draft that tried to be cleverer destroyed 2.4 MB of a running
  download. Only a path a call minted itself (`partialPathFor`) may be
  deleted eagerly; everything else waits out the age gate.
- **`out` is deleted only by the call that promoted it.** Otherwise a slow
  call's failure deletes a file a fast call already returned as success.

ffmpeg is passed an explicit `-f` because it infers the muxer from the
output extension — a `.part` name has none, which silently broke every HLS
URL in one draft.

**`get_status` is keyed on the VIDEO, never on a handle the caller had to mint.**
Some clients cap tool-call duration and send `notifications/cancelled` while the
server keeps working -- observed in a real client's own MCP log. An earlier draft
had the caller invent a `callId`; it worked, but only for a caller who had thought
to supply one BEFORE discovering it would be needed, and recovery matters exactly
when nobody prepared. The url/path is required on every call, so it cannot be
missing. Matched exactly -- no youtu.be/youtube.com equivalence, no query-parameter
stripping -- because answering about the wrong video is worse than answering
"unknown". `src/agent/resultStore.ts` holds finished results verbatim and is
deliberately SEPARATE from `src/status/registry.ts`, which already tracks running
items by url and whose observables-never-verdicts rule stays intact by not being
asked to store results.

**`src/types.ts` is the single source of truth** for shared types.

**No Python.** Node 22.12+ (CI runs 22 and 26; `@types/node` is held at 22 so an API
newer than that fails the typecheck), ESM, TypeScript strict with `noUncheckedIndexedAccess`.

## Domain rules worth knowing before editing

**Transcript tiering:** any platform caption beats local speech recognition —
manual first, then automatic, *including machine-translated tracks*. Local ASR is
the no-captions fallback, never a preferred tier. This reverses an earlier
"accuracy bias" and was measured, not assumed; `chooseCaptionTier` carries the
numbers. Do not reintroduce a caller-facing choice here.

**Platform automatic captions use rolling cues** — each cue repeats the previous
one's trailing lines before appending. Parsed naively they inflate ~3x. Dedup runs
*during* parse (`parseVttCues` -> `dedupeRollingCues`), because joining cue lines
destroys the line structure that identifies duplicates.

**Clip timestamps re-base to zero.** A range-fetched file is a clip starting at 0,
not the original with a hole. `clipRelative` in `analyze.ts` tracks whether the
media has actually been re-based; the caption clamp is gated on it, not on
`opts.start`/`opts.end` alone. The `'even' + start === end` carve-out deliberately
skips the trim and stays in absolute time — tests pin this in both directions.

**Frame-mode short circuits (spec §8):** a single-frame request must not pay for
scene detection, quality filtering, OCR, embeddings, transcription, *or* the video
re-encode. `normalizeVideo()` runs only for `frames: 'key'`; the WAV is extracted
only when a transcript is actually needed.

**A captioned transcript-only request never downloads the media.** `frames: 'none'`
+ captions means nothing downstream ever opens the file, so stage 1 of `analyze.ts`
resolves metadata-only first (`--skip-download` still writes caption files and still
reports duration) and fetches the media in a second pass *only* if ASR turns out to
be needed. Measured: 285 MB → 888 KB on a 27-minute video. Three things hold it
together, each load-bearing:
- **`usableCaption()` is one function with two callers** — the stage-1 "do we need
  media?" decision and the transcript stage itself. If they ever disagree, stage 1
  skips the download and the transcript stage asks for audio that was never
  fetched. Do not inline either copy.
- **Deliberately not extended to ranged requests.** A range makes the time base
  load-bearing (`clipRelative`), and skipping the fetch would answer "just this
  section" with a whole-video transcript. Pinned in both directions; see
  `docs/follow-ups.md`.
- **`duration` comes from the extractor, not a probe, on that path** — genuine
  (yt-dlp scrapes it during extraction), but only because the gate guarantees a real
  extractor ran. `direct`/`wechat` return `duration: 0` as a type placeholder, which
  is why the gate requires a caption track rather than merely `frames: 'none'`.

An analyze item whose stage chain shows no `'downloading'` is therefore honest, not
a dropped stage.

## Testing expectations

The recurring defect in this codebase's history is **a test that passes identically
against broken code** — assertions reading values back out of the function's own
return value, or mocking the very machinery under test. When adding a test, mutate
the thing it guards and confirm it fails. Assert independently-constructed
expectations and key *absence* (`'duration' in r === false`) rather than falsiness,
since `toBe(0)` and `toBeFalsy()` pass against several real bugs here.

## Honesty

`docs/acceptance-matrix.md` reports **0 of 11 rows executed** because it needs real
URLs via `M_*` environment variables. The platform list is tested *code paths*, not
platforms anyone has watched succeed live. Do not let docs, comments, or tool
descriptions imply otherwise. `docs/follow-ups.md` records every deliberately
deferred item with its reasoning — check it before "discovering" a known gap.

## Reference

- `docs/superpowers/specs/` — design docs; the v2 spec governs the agent surface,
  the tasks-and-batching spec (2026-08-12) governs tasks/batching on top of it, and
  the status-channel spec (2026-08-13) governs the observable status registry,
  `/status` endpoint, and `video-extract status` CLI on top of both
- `docs/follow-ups.md` — deferred work, with the reasoning that deferred it
- Env: `VIDEO_EXTRACT_MODELS_DIR`, `VIDEO_EXTRACT_WECHAT_COOKIE`,
  `VIDEO_EXTRACT_COOKIES_FILE`, `VIDEO_EXTRACT_COOKIES_FROM_BROWSER`,
  `VIDEO_EXTRACT_AUTO_FETCH_MODELS`,
  `VIDEO_EXTRACT_MAX_CONCURRENCY`, `VIDEO_EXTRACT_TASK_TTL_MS`,
  `VIDEO_EXTRACT_STATUS_PORT` (README has the full table). TEST-FACING only:
  `VIDEO_EXTRACT_CACHE_DIR`, and `VIDEO_EXTRACT_NO_LAUNCH` (set by vitest.config.ts so a
  test can never open the developer's browser or post a notification)
- WeChat resolution was **clean-room derived**; the well-known reference
  implementation is MIT + Commons Clause. Never consult it when extending that code.
