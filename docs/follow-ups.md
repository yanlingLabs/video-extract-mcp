# Norma — Follow-Ups After the Initial Build

All 17 planned tasks are complete and the final whole-branch review is clean. This file records what was deliberately left for later, so the decisions are not lost when the build's scratch workspace is deleted.

Nothing here blocks merge. Items are grouped by theme, in rough priority order.

## A. Selector calibration against real footage

The frame selector works — verified end-to-end on an adversarial synthetic fixture, where a slide's text change was picked first (importance 0.594 versus ~0.28 for noise frames) while caption churn and a moving distractor produced no false picks. What has never been tested is real, compressed, noisy video. Do not tune these blind; gate on the first real acceptance-matrix run.

- **Quality weight is likely too high at 0.25.** After the quality filter rejects bad frames, surviving scores have a floor around 0.32, so the usable spread is worth up to 0.17 of a frame's score — roughly half the influence of text novelty. Worse, the metric is Laplacian variance, which measures *edge density* rather than focus: dense-text frames saturate at 1.0 while a perfectly focused face or sky sits near 0.4–0.6. That is a systematic bias toward busy frames, double-counting what text novelty already captures. Suggested: `0.45 / 0.40 / 0.15`, which lands close to the design spec's implied ratios and stays strictly distinct so the weight-ordering test survives. Bump `SELECTOR_VERSION` if changed — every emitted `importance` shifts.
- **Semantic novelty was folded entirely into the dynamic similarity penalty.** The spec listed it as the largest single term. The consequence: a within-shot change with no cut and no text — an object simply appearing — scores almost nothing intrinsically, because heartbeat frames carry zero scene significance. A small static term using cosine distance to the previous candidate's embedding would close this, and the embedding is already computed.
- The greedy loop is O(n·k²·d) rather than O(n·k·d); it recomputes similarity against all picked frames each round. Measured 329 ms at spec scale (600 candidates, 50 picks). Not harmful now; both max and min are monotone, so caching per-candidate values updated only against the newly-picked frame would fix it.
- `semantic_change` is emitted as a reason for embedding-less frames and for every first pick, since max-similarity is 0 against an empty set. Misleading when there is no embedding to judge by.
- `new_scene`'s 0.3 threshold rarely fires for real cuts, which land near 0.15–0.2 normalized, so reasons under-report scene-driven picks.

## B. Candidate generation and end-of-file edges

One small pull request covers all of these.

- A scene boundary within ~100 ms of the video's end can produce a sample at or *before* the boundary itself, violating the design rule that samples must come after a cut. The frame then shows the old scene while carrying the new scene's id and significance — trading a silently dropped frame for a silently mislabeled one.
- The end-of-video margin is a constant 0.1 s, empirically tuned at 25 fps and **proven insufficient at low frame rates**: on a 1 fps fixture, seeks at the duration, at the margin, and well inside all fail; only the last frame's actual presentation time succeeds. The margin should scale with frame duration (1/fps).
- The dedup window is a fixed 0.5 s and is not scaled to the heartbeat interval, so sub-second heartbeats collapse non-uniformly.
- `sceneIdAt` is used only for heartbeat items and no test asserts a heartbeat candidate's scene id, so an off-by-one there would ship undetected.

## C. Temporary-artifact lifetime

Decide one policy and document it, rather than fixing piecemeal.

`Manifest.source.filePath` and `frames[].image` both point into a working directory that nothing cleans up. That is deliberate — those paths are the coarse-to-fine handoff and must outlive the call — so "delete eagerly" is the wrong answer. What is missing is a documented lifetime contract: a caller currently cannot tell that these paths are temp-scoped and could be reaped by the OS between an analysis and a later `get_clip`. One clause in the type's doc comment would fix it. Related loose end: `get_frame`/`get_clip` never pass `outDir` through from MCP, so each call creates its own directory.

**Partly addressed by the v2 branch, and what remains.** `work.mp4` and `work.wav` are now deleted after every call, and spec §8's cheapness work means `'even'`/`'none'` requests never produce them at all. Two artifacts still survive each call: `clip.mp4` (written by `trim()` when a range is applied) and the candidate JPEGs that the selector considered but did not pick. Measured at 328KB for a 30-second ranged `key` call — but `clip.mp4` scales with the requested range, so repeatedly analyzing long sections inside one long-lived MCP server accumulates hundreds of megabytes. This is the remainder of the same disk-growth class, deliberately left because the cleanup order is delicate: `Manifest.source.filePath` and `frames[].image` are the documented coarse-to-fine handoff, and deleting something they point at is worse than the leak. Any fix must keep the invariant the v2 cleanup tests already assert — every path returned in a reply or manifest still exists after the call.

## D. Degradation visibility

`processing.warnings` now exists and records dead OCR, dead embeddings, and ASR failure. Two gaps remain: the ASR-failure line has no test, and a partial-embedding drop (where some frames embedded and others did not) removes candidates with no warning recorded.

## E. Architecture promised but not delivered

State these explicitly rather than leaving them implicit:

- The spec described `transcribe_video` and `extract_keyframes` as agent-facing primitives. Four MCP tools shipped and these two were dropped without being recorded as deferred.
- The spec's WeChat activation experience — Keychain persistence, assisted login, an expiry probe — is currently an environment variable discoverable only by reading source. The headless resolution protocol itself is validated and working.
- **The acceptance matrix is a smoke matrix, not an acceptance judge.** It compares returned status against an expected status and nothing more. A passing row proves the URL was reachable and ended in the expected state; it does not prove the claim named in its "proves" column. Rows asserting that subtitle-aware selection avoids over-selecting, or that WeChat routes to the Chinese speech model, would pass without ever inspecting frames or the transcript's language. Strengthening the assertions is worth doing before treating a green matrix as evidence.

## F. Known residual risks

- **Real-platform behavior is unproven.** The caption-acquisition rewrite was verified against the installed yt-dlp's own source and a faithful fake, but never against a live platform. Running the matrix with real URLs is the necessary next step.
- When yt-dlp performs a sectioned download, it snaps to keyframes and may start slightly before the requested point, so caption re-basing can be off by up to ~1.5 s. This is a small constant offset, not the range-sized misalignment that was fixed.
- Automatic-caption track ordering can prefer a machine-translated English track over the original language when no preference and no platform hint are available.
- There is no CI, and no CI would fetch the roughly 1.5 GB of models, so the model-backed integration tests will skip in any automated run. The real speech and embedding integration currently rests on local execution.

## G. Range parameters require both bounds

`resolve_video` and `analyze_video` both gate range extraction on `start` **and** `end` being supplied together (`src/resolve/ytdlp.ts`, `src/analyze.ts`, `src/agent/resolveTool.ts`). Passing just one is silently treated as no range at all — the whole video is fetched/analyzed rather than "from here to the end" or "from the start to here." Treating a lone `start` as "to the end of the video" (or a lone `end` as "from the start") is a reasonable alternative and was considered; requiring both is a deliberate current limitation, not an oversight, and the tool descriptions now say so explicitly rather than leaving it for a caller to discover by surprise.

## H. Left open after the v2 agent-surface branch

The v2 branch (two-tool MCP surface) closed its own final review with four Critical fixes. These were adjudicated as deferred rather than fixed, and are recorded here because the branch's scratch workspace is deleted at merge.

**Found on the first real URLs ever run through the engine** (while measuring platform captions against local ASR):

- **A sectioned download can 403 where a full download succeeds.** yt-dlp selected an AV1+opus format for one video and YouTube refused the ranged fetch with `HTTP 403 Forbidden`, so `--download-sections` failed while the full download worked fine. The engine handled it correctly — an honest `extractor_failed`, no silent full video — but an agent asking for a range on such a video gets nothing. Worth investigating whether constraining the format selection for ranged requests avoids it.
- **`transcript.language` is real again for captioned videos.** The known "language field is a constant" defect is a property of the local ASR path; caption tracks carry their own language tag, so a captioned video now reports `en`, `pt` and so on honestly. Only the ASR fallback still reports `auto`.

**Do this one first.** `src/resolve/direct.ts`'s safe-default direction — `returnVideo === undefined` means download, which `analyze.ts` relies on because it never sets the flag — is untested at its boundary. Every test passes the flag explicitly. Mutating it to `!== true` breaks every direct/HLS URL in `analyze_video` and yet survives the entire suite. It is correct today; the coverage hole is what makes it dangerous.

Other open items, in rough priority order:

- **The `*7-7` degenerate download section is unverified.** `analyze_video` accepts URLs, and the description recommends `start === end` with `frames: "even"` for a single frame. For yt-dlp sources that produces `--download-sections *7-7`, a zero-length section. This cannot be checked offline and needs one manual run once real matrix URLs exist.
- A clipped fetch reports `appliedEnd - appliedStart` as its duration rather than the probed length of the clip. In the resolver-applied case yt-dlp had already probed a genuine value, and keyframe snapping is accepted within ±max(1.5s, 15%), so an accurate measurement is discarded for an arithmetic one. `r.rangeApplied` distinguishes the two sub-cases cleanly.
- `'even'` and `'none'` frames now come from the un-normalized source (spec §8's cheapness rules out re-encoding), so returned JPEGs are at the source's own resolution rather than the normalized 720p — measured 1920x1080 versus 1280x720 for the same instant. Correct, but the tool description does not mention it.
- WeChat skips its own cheap discovery calls under `returnVideo: false` and falls back to a synthetic "WeChat video &lt;id&gt;" title, even though `get_parse_result` genuinely carries a real title and author. Defensible as conservative — fewer hits on an unofficial credential-gated endpoint — but it means a default `resolve_video` on a named platform returns almost nothing.
- The `analyze_video` no-copy guard asserts its working directory is not *equal* to `destinationPath`. A working directory placed one level *inside* the destination would slip through. The real bug (exact assignment) is caught; tighten to a `startsWith` check.
- `chapters` defaults to `[]` for sources that structurally have none, the same zero-as-fact shape `duration` was deliberately fixed to avoid.

**Left open after the tasks-and-batching branch (0.2.0).** Recorded here because this branch's own task workspace under `.superpowers/` is gitignored and never committed. Section citations below (`§N`) are to `docs/superpowers/specs/2026-08-12-tasks-and-batching-design.md`, not the v2 spec cited elsewhere in this file.

- **Real cancellation of running work (process-tree kill).** Deferred (§14); the honest-refusal contract ships in its place instead — for both `analyze_video` and `resolve_video`, a task whose work has started refuses `tasks/cancel` rather than pretending to stop (`HonestCancelStore`, `src/mcp.ts`; §8). What is deferred specifically is killing the underlying yt-dlp/ffmpeg/worker process tree and cleaning up its partial output.
- **A durable task store surviving server restarts.** Deferred (§14). The in-memory store is deliberate (§9), not an oversight — a task's artifacts already survive at `destinationPath` regardless of what happens to the handle.
- **Partial batch results before completion.** Deferred (§14). A multi-video task's per-item results are delivered once, together, when the whole task reaches `completed` (§5); progress before then is visible only through `statusMessage`, not through early results.

**Left open after the status-channel branch (0.3.0).** Recorded here because this branch's own task workspace under `.superpowers/` is gitignored and never committed. Section citations below (`§N`) are to `docs/superpowers/specs/2026-08-13-status-channel-design.md`.

- **Real download percentages.** Deferred (§8). `yt-dlp` writes its own download progress; parsing it and attaching a genuine percentage at the `'downloading'` stage would add a real number where the status channel currently only reports the binary fact "downloading, or not" — a fact yt-dlp itself would be reporting, not a judgment this project invents, so it does not conflict with the observables-never-verdicts rule.
- **Status-history persistence across a server restart.** Deferred (§8), by design, not an oversight: the status registry is per-server and in-memory (`src/status/registry.ts`), so a server that exits takes its item history with it — only the discovery file survives (`src/status/discovery.ts`), and even that keeps just a `{pid, port, startedAt, version}` tuple, never item history. Revisit only if real usage demands surviving a restart; the durable record today is the files at `destinationPath`, which outlive the registry either way.
- **Queue position (`queued, N ahead`) is not in the registry.** The design doc's own illustrative CLI render (§6) shows a queued item as `queued, 2 ahead`; the shipped `StatusRegistry` (`src/status/registry.ts`) carries no "items ahead" field, so `video-extract status` renders the one fact it actually has: plain `queued`, never a fabricated count (task-6-report.md's own adjudication). The value is not missing from the codebase, only from this one payload — `onQueued(i, ahead)` in `src/mcp.ts` already computes it and feeds the per-task MCP `statusMessage`. Closing this needs a registry change (e.g. a `queued(id, ahead)` method, called from that same `onQueued` callback, threaded through to the `/status` payload and the CLI's render) — out of scope for the CLI task that found the gap and for this docs-only task alike, so it is recorded here rather than fixed in place.

**Left open after the skip-the-download optimization (0.4.0).**

- **Ranged transcript-only requests still download the media.** `analyze_video` skips the media fetch entirely when a request needs no frames and the video has platform captions, but deliberately only when no `start`/`end` was given. A range makes the media's time base load-bearing: `clipRelative` (`src/analyze.ts`) gates the caption clamp on whether the media was genuinely re-based to zero, so skipping the fetch would answer a "just this section" request with a whole-video transcript in absolute time, and would also change `manifest.source.duration` from the clip's length to the source's. Both are pinned by tests in both directions, and CLAUDE.md marks the invariant load-bearing. Closing this means clamping captions from the *request* rather than from the media's state — safe in principle, since a frames-less run has no frame timestamps to misalign — plus deciding what `duration` should mean when nothing was measured. The measured win (285 MB → 888 KB on a 27-minute video) is the whole-video case, so the ranged case was left alone rather than half-done. `tests/analyzeSkipDownload.integration.test.ts` pins the exclusion so it stays a decision.
- **`transcript: false` with `frames: "none"` still downloads.** Structurally it needs nothing at all, but the skip is gated on a caption track actually being found, which is also what establishes that a real extractor supplied the duration. `direct`/`wechat` return `duration: 0` as a type placeholder under `returnVideo: false`, and putting that in a manifest would be a fabricated measurement — the honesty class this project exists to kill. Closing this needs a way to say "duration unknown" in the manifest rather than a zero.
- **The manual-caption pool is fetched in every language the uploader wrote.** `--sub-langs all,-live_chat` downloaded 14 VTT files (888 KB) for one video where one was used. It is bounded by human effort, and it is load-bearing: fetching all manual tracks first is what lets `pickManualCaption` apply the caller's language preference over what genuinely exists, and what keeps `requested_subtitles` provably manual-only (`src/resolve/ytdlp.ts`). Narrowing it would need the preference resolved before the fetch, from the metadata pass alone.

**Dependency advisories, surfaced when Dependabot was enabled (0.4.x).**

- **`adm-zip` <0.6.0 (GHSA-xcpc-8h2w-3j85, high) has no upstream fix.** Reached via `@huggingface/transformers` → `onnxruntime-node@1.24.3` → `adm-zip@0.5.18`. An override cannot help: there is no patched release to point at. `adm-zip` serves onnxruntime's own packaging rather than any path this project feeds attacker-controlled bytes into, so the practical exposure is low, but it stays open until upstream moves. Re-check when `onnxruntime-node` publishes a release that drops or bumps it.
- **The `sharp`/libvips advisories are fixed for this repo but NOT for npm consumers.** `@huggingface/transformers` pins `sharp: ^0.34.5`; an `overrides` entry forces `^0.35.3` here, which resolves CVE-2026-33327/-33328/-35590/-35591 and additionally dedupes libvips (two copies were loading at once, which libvips warns can cause "spurious casting failures and mysterious crashes"). npm applies `overrides` only from the root project, so this cannot protect anyone who installs the published package — verified by installing the packed tarball into a clean project and finding the vulnerable nested copy still there. Nothing further can be done from this side; the real fix is upstream widening its pin. `SECURITY.md` documents the override consumers can apply themselves in the meantime. Drop our override once transformers ships a `sharp` range that admits ≥0.35.0.
