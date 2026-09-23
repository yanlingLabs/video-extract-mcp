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

**Resolved for URL sources in 0.8.0.** A URL source now works in a scratch directory inside `destinationPath` and only the deliverables are moved out, so the unpicked candidate JPEGs and `clip.mp4` are discarded with it rather than accumulating — one real run had been leaving 258 JPEGs and 390 MB to deliver 40 frames. The invariant holds by construction: the paths a reply names are exactly the ones moved out before the scratch is removed. Still open for LOCAL sources, which deliberately keep their own `mkdtemp` working directory outside `destinationPath` (never duplicating a file the caller already placed) and clean up only `work.mp4`/`work.wav`; their unpicked candidates still linger in a temp directory the OS reaps on its own schedule.

## D. Degradation visibility

`processing.warnings` now exists and records dead OCR, dead embeddings, and ASR failure. Two gaps remain: the ASR-failure line has no test, and a partial-embedding drop (where some frames embedded and others did not) removes candidates with no warning recorded.

## E. Architecture promised but not delivered

State these explicitly rather than leaving them implicit:

- The spec described `transcribe_video` and `extract_keyframes` as agent-facing primitives. Four MCP tools shipped and these two were dropped without being recorded as deferred.
- The spec's WeChat activation experience — Keychain persistence, assisted login, an expiry probe. **Assisted login and the expiry probe shipped with `userCookies` (see §K); Keychain persistence did not.** The session a browser gives lives in memory only, so a restarted server reads the browser again (no sign-in, unless the browser's own session has lapsed).
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

- ~~**A sectioned download can 403 where a full download succeeds.**~~ **Corrected: this is transient rate limiting, not format selection.** The original note guessed the AV1+opus format selection was the cause and proposed constraining formats for ranged requests. Measured since, and that guess was wrong. Observed the failure in the opposite direction too — the *ranged* download succeeding while the *full* one 403'd — after six calls in ~20 seconds against one video: extraction kept working while YouTube refused media URLs. Freshly-obtained URLs for the very formats that had just 403'd (`396`, `251`, and four others) each served `206` on a direct fetch immediately afterwards, so nothing is wrong with those formats. Constraining format selection would not have helped and is not worth doing. What came out of it instead: a `rate_limited` status so an agent is told the condition is temporary rather than being handed `ffmpeg exited with code 8`. **Refined again in 0.11.0, with better evidence.** The ranged and whole-video paths were reporting the same condition differently: a whole-video fetch is yt-dlp's own, so its 403 reaches stderr and classifies as `rate_limited`; a ranged fetch is ffmpeg's, and yt-dlp does not forward ffmpeg's stderr unless verbose, so the identical refusal arrived as nothing but `ffmpeg exited with code 8`. Confirmed by running the same request at verbose level and seeing `Server returned 403 Forbidden (access denied)` underneath. That asymmetry also meant a ranged request never reached the cookie retry, since that fires only on `rate_limited`/`auth_required`. Ranged downloads now pass `--verbose` so the cause is visible to the classifier.

Still open, mildly: the tool does not itself back off or retry — a caller that hammers one video will still trip the limiter, and self-throttling with a retry-after-delay would be a genuine improvement.
- **`transcript.language` is real again for captioned videos.** The known "language field is a constant" defect is a property of the local ASR path; caption tracks carry their own language tag, so a captioned video now reports `en`, `pt` and so on honestly. Only the ASR fallback still reports `auto`.

**Do this one first.** `src/resolve/direct.ts`'s safe-default direction — `returnVideo === undefined` means download, which `analyze.ts` relies on because it never sets the flag — is untested at its boundary. Every test passes the flag explicitly. Mutating it to `!== true` breaks every direct/HLS URL in `analyze_video` and yet survives the entire suite. It is correct today; the coverage hole is what makes it dangerous.

Other open items, in rough priority order:

- **The `*7-7` degenerate download section is unverified.** `analyze_video` accepts URLs, and the description recommends `start === end` with `frames: "even"` for a single frame. For yt-dlp sources that produces `--download-sections *7-7`, a zero-length section. This cannot be checked offline and needs one manual run once real matrix URLs exist.
- A clipped fetch reports `appliedEnd - appliedStart` as its duration rather than the probed length of the clip. In the resolver-applied case yt-dlp had already probed a genuine value, and keyframe snapping is accepted within ±max(1.5s, 15%), so an accurate measurement is discarded for an arithmetic one. `r.rangeApplied` distinguishes the two sub-cases cleanly.
- `'even'` and `'none'` frames now come from the un-normalized source (spec §8's cheapness rules out re-encoding), so returned JPEGs are at the source's own resolution rather than the normalized 720p — measured 1920x1080 versus 1280x720 for the same instant. Correct, but the tool description does not mention it.
- WeChat skips its own cheap discovery calls under `returnVideo: false` and falls back to a synthetic "WeChat video &lt;id&gt;" title, even though `get_parse_result` genuinely carries a real title and author. Defensible as conservative — fewer hits on an unofficial credential-gated endpoint — but it means a default `resolve_video` on a named platform returns almost nothing.
- ~~The `analyze_video` no-copy guard asserts its working directory is not *equal* to `destinationPath`; tighten to `startsWith`.~~ **Resolved, and deliberately NOT by tightening to `startsWith`.** As of 0.8.0 a URL source works in a scratch directory placed one level *inside* `destinationPath` on purpose — same filesystem, so delivery is a rename rather than a copy of the whole video, and `/status` can still see the bytes grow (its walk is recursive with an entry-count cap). A `startsWith` check would now forbid the intended design. The guard's real subject is the LOCAL-source rule (never duplicate a file the caller already placed), which is unchanged: local sources still use a private `mkdtemp` outside `destinationPath`, pinned by `tests/analyzeTool.test.ts`.
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

- ~~**`adm-zip` <0.6.0 has no upstream fix.**~~ **Resolved.** `adm-zip@0.6.0` was published and is now forced via an `overrides` entry, taking this repository to a clean `npm audit`. `onnxruntime-node` still pins `^0.5.16`, so the override is doing real work; npm's own `audit fix` would instead downgrade `@huggingface/transformers` to 3.8.1, which is a breaking change and the wrong direction. Verified rather than assumed: the exact adm-zip API the installer calls (`new AdmZip(path)`, `getEntries`, `extractEntryTo`) behaves identically on 0.6.0. NOT verified: onnxruntime's `postinstall` running end to end against 0.6.0 — npm's install-script policy on this machine blocks it, and `allowScripts` did not override that. The risk of that gap is small, since onnxruntime bundles prebuilt binaries for every supported platform and the ZIP extraction is a fallback. Still open, as with `sharp`: npm applies `overrides` only from the root project, so neither reaches consumers of the published package.
- **The `sharp`/libvips advisories are fixed for this repo but NOT for npm consumers.** `@huggingface/transformers` pins `sharp: ^0.34.5`; an `overrides` entry forces `^0.35.4` here (0.35.3 at first; 0.35.4 adds the libheif fixes in GHSA-rgj7-g3m4-5g8c), which resolves CVE-2026-33327/-33328/-35590/-35591 and additionally dedupes libvips (two copies were loading at once, which libvips warns can cause "spurious casting failures and mysterious crashes"). npm applies `overrides` only from the root project, so this cannot protect anyone who installs the published package — verified by installing the packed tarball into a clean project and finding the vulnerable nested copy still there. Nothing further can be done from this side; the real fix is upstream widening its pin. `SECURITY.md` documents the override consumers can apply themselves in the meantime. Drop our override once transformers ships a `sharp` range that admits ≥0.35.0.

**Where OCR crops are staged (0.10.1), and the evidence behind it.**

An analyze run lost all 459 frames to OCR failures reporting `image file not
found` for a file that was present with 193101 bytes in it. Diagnosed by
reading the failing MCP server's own environment: it had **no `TMPDIR`**,
where a server launched by a different client on the same machine had
`TMPDIR=/var/folders/.../T/`. Node's `os.tmpdir()` falls back to `/tmp` when
TMPDIR is unset, and the failing crop path was `/tmp/norma-ocr-<pid>-....png`
carrying that server's pid. The frames in the same run — written by ffmpeg,
read by sharp, in the working directory — were fine throughout.

Crops are now staged beside the frame. Why `/tmp` specifically failed for
that process is still unexplained, and deliberately so: the fix removes the
dependency rather than resting on a theory about it. Worth revisiting only if
something else in the pipeline is found to depend on `os.tmpdir()` in the
same way — `src/util/cookies.ts` stages its jar copy there, and would be the
next candidate if this recurs elsewhere.

## I. Platform support after PR #5

PR #5 (a contributor's macOS 12 Intel setup) was not merged as submitted; what it found was acted on instead. What is still open:

- **The WebAssembly embedding fallback has never run on an Intel Mac.** It is exercised here by blocking the native binding on Apple Silicon (`tests/fixtures/no-native-onnxruntime.mjs`), which reproduces the load error an Intel Mac gets, not the machine. The contributor offered the obvious test; nobody on this side has the hardware.
- **Local speech recognition has no fallback, and on Intel it needs macOS 15.** `sherpa-onnx-darwin-x64` 1.13.4 declares minimum OS 15.0 for its addon and 15.5 for its bundled onnxruntime (read from the binaries' load commands; not run on an older system). Captioned videos are unaffected. A WebAssembly build of sherpa-onnx exists but was not evaluated: Whisper small is ~1.3 GB, close to wasm32's 4 GB address space once activations are counted.
- **The Apple Silicon onnxruntime-node dylib targets macOS 14.0**, above Node 26's own 13.5 floor. On 13.5-13.x the fallback should catch a load failure, but nobody has checked whether one actually happens.
- **`onnxruntime-web` must move in lockstep with `@huggingface/transformers`.** It is pinned to the exact build transformers requires so npm installs one copy; a bump of either one alone (a Dependabot security update, say) silently adds a second ~145 MB copy. `check-lockfile` could assert a single `node_modules/onnxruntime-web` entry; not done yet.
- **Node 22 reaches end of life on 2027-04-30.** Then raise `engines`, move `@types/node` and the CI matrix with it, and point a `node22` dist-tag at the last release that supported it, so an old machine can still `npx @yanlinglabs/video-extract-mcp@node22`.
- **The OCR-chain integration test runs on neither CI platform.** Its fixture needs ffmpeg's `drawtext` filter and a macOS system font: Homebrew's ffmpeg 9 has no `drawtext` (so the macOS runner skips it, and so will a developer Mac after `brew upgrade ffmpeg`), and the Linux runner lacks the font path. It still runs on a Mac with an older or drawtext-enabled ffmpeg. A font lookup that also accepts a Linux font would bring it back on Linux.
- **The first CI run found two Linux-only behaviours.** Ubuntu 24.04's ffmpeg 6.1 exits 0 without writing a frame when a seek lands past the end (now checked in `extractFrame`), and two cookie tests depended on a browser profile existing on the machine (now supplied by the tests).
- **OCR on macOS 12:** Homebrew has no tesseract bottle for Monterey, per the contributor. OCR degrades with a warning, as designed.

## J. Caption fallback, frame labels and memory (2026-09-23)

A real run on a Portuguese music video (`youtube.com/watch?v=fu9dCuPRFHY`) transcribed with Whisper while YouTube offered a Portuguese auto-caption track, and said nothing. Fixed, together with what that run showed. Still open:

- **The original failure was never observed directly.** Every later attempt on the download path hit YouTube's 403 media throttle. What was measured: the info dict prints 1.3 s into the run, the download took 92 s after it, and the metadata-only twin fetched the same track in 194 ms. With the fetch moved to the moment the JSON prints, a real throttled run fetched the track (200, 222 ms) before the media 403. A recurrence can no longer be silent: it arrives as `transcript.asrReason: "captions_failed"` plus a warning naming the cause.
- **A caption host that hangs now costs up to ~2 minutes** (3 attempts × 30 s timeout + backoff) on the metadata-only paths, where no download hides it; a plain 429 without Retry-After costs ~7 s. `frames: "none"` re-resolves once when captions fail, so it can pay that twice. Lower `CAPTION_FETCH_TIMEOUT_MS` if this bites.
- **Whisper's residual memory creep** of ~0.7 MB per decoded segment is inside sherpa-onnx and survives forced GC. Measured to 26 minutes (2.14 GB peak); a two-hour talk was not measured.
- **The default `VIDEO_EXTRACT_MAX_CONCURRENCY` dropped from 4 to 2** once Whisper's ~2 GB was measured (4 meant ~8 GB worst case). A smaller Whisper model was the alternative and was declined: accuracy over memory.
- **Temp directories.** `resolve_video` (every call, `norma-res-*`) and `analyze_video` on a local file (every call, `norma-*`) left a directory in `os.tmpdir()` that nothing removed. Both now work in the `.work-*` scratch inside `destinationPath` and discard it. A server sweeps `norma-res-*` older than 24 h once at start; the CLI's `norma-*` output directories are still left alone, since their manifest points into them (§C).

## K. `userCookies`: per-call browser cookies (2026-09-23)

Both tools take `userCookies: true`, the user's per-call consent to their own default browser's cookies, replacing the old "set `VIDEO_EXTRACT_COOKIES_FROM_BROWSER` and restart" suggestion. For WeChat it also opens yuanbao.tencent.com for sign-in and polls for up to 3 minutes. Left open, deliberately:

- **Sign-in on yt-dlp sites is a heuristic.** WeChat has an exact test (`getuserinfo`); an arbitrary site has none, so `siteSignIn.ts` retries only when the user presses the page's button or a new cookie name for that host appears. A site whose sign-in only changes existing cookie values (no new name) is noticed only through the button. A per-site table of session-cookie names would sharpen it, at the cost of maintaining the table. The name-appearance signal was checked with fakes only, not against a real YouTube or Instagram sign-in.
- **Concurrent yt-dlp items each get their own sign-in page.** WeChat items share one read and one page (`WeChatSession.inFlight`); `waitForSiteSignIn` has no equivalent, so a two-video batch refused by the same site opens two tabs and runs two waits. Not wrong, but noticeable; keying a shared wait on the site host would fix it.
- **The macOS notification did not appear in real use** (2026-09-23). `presentSignIn` asks `osascript` for one; macOS attributes it to Script Editor and suppressed it. It turned out not to matter: `open -b` brings the browser to the front with the page. It can go, or be kept as harmless best-effort.
- **The sign-in page's final design ran end to end in Safari for a real WeChat sign-in** (2026-09-23, 0.16.0): the page came to the front, the user signed in at yuanbao, pressed "I've signed in", and the download carried on. A real sign-in on a non-WeChat site has not been watched. Headless Chrome screenshots covered light mode and several widths; dark mode was only seen in the earlier design. The sign-in URLs for the nine known sites all answered 200 when checked (2026-09-23); sites move them, and a stale one only degrades to a page that still has a sign-in link.
- **Firefox sign-ins can lag.** yt-dlp copies `cookies.sqlite` without its write-ahead log (verified in yt-dlp's `_open_database_copy`), so a cookie Firefox has not yet checkpointed is invisible. Reading the log too would need yt-dlp to change, or reading Firefox's store ourselves.
- **Only macOS has been exercised against real browsers** (Safari, live against yuanbao: read, validated and remembered). The Linux `xdg-settings` and Windows `UserChoice` lookups, and the Linux/Windows browser openers, are tested code paths only.
- **Renewal is kept only for sessions taken from the browser.** A renewed `VIDEO_EXTRACT_WECHAT_COOKIE` is used for the call that got it and then dropped; remembering it too is cheap, but whether it actually stops the pasted cookie expiring is unmeasured.
- **A sign-in wait does not stop for shutdown.** The poll's sleep is an ordinary timer and takes no abort signal, so a server whose stdin closes mid-wait lives up to 3 more minutes, finishes that call and writes its result, then exits. That matches "the work finishes either way", but it is the process-lifetime class `tests/mcpProcessLifecycle.test.ts` guards, so it is recorded here rather than left to be rediscovered.
- **The jar touches disk.** `readBrowserJar` has yt-dlp write the whole jar to a 0700 temp directory that is removed as soon as it is read. `/dev/stdout` avoided that and hung: `--cookies FILE` is also read at startup, and Node's stdout pipe is a socket.

