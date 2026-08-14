# video-extract-mcp

**Turn any video URL into a transcript and the handful of frames that actually matter — locally, from an MCP server your AI agent can call.**

Give it a YouTube link, a TikTok, a WeChat Channels share URL, a raw `.mp4`, or a page from a site nobody has heard of. It fetches only what the request actually needs, produces a transcript (real captions when the platform has them, local speech recognition when it does not), and returns a small set of *important* keyframes — deduplicated, scene-aware, and scored — instead of a thousand near-identical stills.

Built for AI agents. Two MCP tools, no cloud, no API keys, no Python.

[![npm](https://img.shields.io/npm/v/@yanlinglabs/video-extract-mcp)](https://www.npmjs.com/package/@yanlinglabs/video-extract-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A526-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-584%20passing-success.svg)](#testing)
[![MCP](https://img.shields.io/badge/MCP-server-orange.svg)](https://modelcontextprotocol.io)

---

## Why this exists

An LLM cannot watch a video. The usual workaround — dump every Nth frame into the context window — burns enormous amounts of context on frames that are 98% identical to the one before, and still misses the slide that changed while nothing else moved.

`video-extract-mcp` does the selection work first:

- **Transcript, honestly sourced.** The platform's own captions are used whenever the video has any — human-written first, otherwise the platform's automatic ones. Audio is transcribed locally (Whisper or SenseVoice) only for videos with no captions at all. The result tells you which you got, via `transcript.source`.
- **Keyframes chosen, not sampled.** Scene-boundary detection, blur/quality filtering, on-screen-text novelty (subtitle-aware, so burned-in captions don't preserve redundant frames), and image-embedding similarity feed an iterative diversity-aware selector.
- **Output goes to disk, not into your context.** The tool reply is a compact summary plus file paths. A 35-frame manifest and a full transcript don't belong in a conversation where the agent needs three numbers from them.
- **Everything runs on your machine.** No third-party API, no upload, no key. Long analyses can run as MCP background tasks — the tool returns a handle immediately and pushes progress; see Background tasks below.

## Quick start

Install the system binaries first — these can't come from npm:

```bash
# macOS; use your package manager elsewhere
brew install ffmpeg yt-dlp tesseract tesseract-lang
```

Then point your MCP client at the package. There are two ways, and they differ in ways worth thirty seconds of your time.

**Option A — `npx`, nothing installed.** Simplest, and it picks up new releases on its own.

```bash
claude mcp add --scope user video-extract -- npx -y @yanlinglabs/video-extract-mcp
```

**Option B — installed globally.** Starts faster and gives you the `video-extract` status CLI as a real command.

```bash
npm install -g @yanlinglabs/video-extract-mcp
claude mcp add --scope user video-extract -- video-extract-mcp
```

|  | `npx` (A) | global install (B) |
|---|---|---|
| Updates | automatic — resolves the latest version on each cold start | **manual: `npm update -g @yanlinglabs/video-extract-mcp`**. You stay on the installed version until you run it |
| Startup | ~0.9s (npm resolution on every launch) | ~0.1s |
| `video-extract status` in your shell | not on `PATH` — needs `npx -y -p @yanlinglabs/video-extract-mcp video-extract status` | works directly |
| Working directory | must not be this package's own checkout (see below) | irrelevant |

Neither affects what agents can do: an agent checks on background work over HTTP using the `statusUrl` handed to it in the reply, never a shell command. The CLI is for humans.

Or in any MCP client's config — `"command": "npx", "args": ["-y", "@yanlinglabs/video-extract-mcp"]` for A, or `"command": "video-extract-mcp"` with no args for B:

```json
{
  "mcpServers": {
    "video-extract": {
      "command": "npx",
      "args": ["-y", "@yanlinglabs/video-extract-mcp"]
    }
  }
}
```

> **One gotcha with `npx`, and it only bites contributors.** Run inside this package's own git checkout, `npx @yanlinglabs/video-extract-mcp` fails with `command not found` — npx sees the local `package.json` claiming that name, looks for the binary in a local `node_modules/.bin` that was never populated, and gives up. Since MCP clients launch servers with the working directory set to your project, option A cannot work *in this repo*. Working on the tool itself? Point that one project at your build — `claude mcp add --scope local video-extract -- node "$PWD/dist/mcp.js"` — which also means a `npm run build` takes effect immediately, with no publish round-trip. Everywhere else, `npx` is fine.

That is enough for any video that has captions — which, thanks to the caption-first transcript policy, is most of them. The vision model downloads itself on first use.

**Speech models are only needed for videos with no captions at all.** They are ~1.5 GB, so they are not bundled. Fetch them when you want that fallback:

```bash
npx -y @yanlinglabs/video-extract-mcp --help   # installs the package
curl -fsSL https://raw.githubusercontent.com/yanlingLabs/video-extract-mcp/main/scripts/fetch-models.sh \
  | bash -s -- ~/.cache/video-extract-mcp/models
```

`~/.cache/video-extract-mcp/models` is where the tool looks by default. Override with `VIDEO_EXTRACT_MODELS_DIR`. Without them, an uncaptioned video still returns frames and records a warning explaining the transcript is missing — it degrades rather than fails.

### From source (contributors)

```bash
git clone https://github.com/yanlingLabs/video-extract-mcp.git
cd video-extract-mcp
npm install && npm run build
./scripts/fetch-models.sh    # into ./models, which takes precedence when present
npm run preflight            # verifies ffmpeg / ffprobe / yt-dlp / tesseract
```

### Environment variables

| Variable | Purpose |
|---|---|
| `VIDEO_EXTRACT_MODELS_DIR` | Where speech models live. Defaults to `./models` when that exists, else `~/.cache/video-extract-mcp/models`. |
| `VIDEO_EXTRACT_WECHAT_COOKIE` | A yuanbao session cookie, required only for WeChat Channels links. |
| `VIDEO_EXTRACT_MAX_CONCURRENCY` | Caps concurrent `analyze_video` item executions — plain calls and background tasks, batch items and separate calls, all count against the same limit. Default `4`. `resolve_video` is exempt: it loads no models, so there is nothing to throttle. |
| `VIDEO_EXTRACT_TASK_TTL_MS` | How long a completed background-task handle stays queryable before it expires. Default `1800000` (30 minutes). `0` (or any non-positive value) means the handle never expires. Governs the in-memory handle only — files already written to `destinationPath` are never deleted by the tool, expired handle or not. |
| `VIDEO_EXTRACT_STATUS_PORT` | Pins the port of the localhost `/status` endpoint (see [Watching progress](#watching-progress)). Unset picks an ephemeral port each start (default: endpoint on). The literal value `0` disables the endpoint entirely — note the contrast with `VIDEO_EXTRACT_TASK_TTL_MS` above, where `0` means *no expiry*, not disabled. |

## Three ways to use it

The MCP server is the main surface, but the same engine is available two other ways.

**As a CLI**, which is the quickest way to see what it does before wiring up an agent:

```bash
npm run cli -- "https://youtube.com/watch?v=..." --max-frames 10 --out ./output

# just the transcript, no frames
npm run cli -- "<url>" --frames none --out ./output

# one exact frame at 7s, as cheap as this gets
npm run cli -- "<url>" --start 7 --end 7 --frames even --max-frames 1 --no-transcript --out ./output
```

It writes `manifest.json` plus the frame images into `--out`, and also prints the manifest to stdout.

If you want to pipe that JSON somewhere, call the built entry point directly — `npm run` prefixes its own banner lines to stdout, so `npm run cli` output is not valid JSON on its own:

```bash
npm run build
node dist/cli.js "<url>" --max-frames 10 | jq '.transcript.source'
```

**As a library**, if you want the pipeline without an agent in the loop:

```ts
import { analyzeVideo } from '@yanlinglabs/video-extract-mcp/dist/analyze.js';

const manifest = await analyzeVideo('https://youtube.com/watch?v=...', {
  start: 30, end: 90, frames: 'key', maxFrames: 12, outDir: './output',
});
console.log(manifest.transcript?.source);   // 'manual' | 'auto' | 'asr'
console.log(manifest.frames.map((f) => f.image));
```

`analyzeVideo` never throws for expected failures — a DRM page or a dead link comes back as a manifest whose `source.status` is not `'ok'`, carrying a readable reason. Check `processing.warnings` too: any optional stage that failed and was skipped past records an entry there.

Note that both the CLI and library paths run the **compiled** output. The speech and vision models run in separate worker processes resolved next to the compiled module, so running the TypeScript sources directly leaves those workers unresolvable — they degrade to a warning rather than an error, which is quiet enough to miss. `npm run cli` builds first for this reason.

## The two tools

> **Breaking change in 0.2.0:** both tools' call shape changed. 0.1.x took a
> single top-level `url` (`resolve_video`) or `pathOrUrl` (`analyze_video`)
> per call. 0.2.0 replaces that with a `videos` array — one entry per video,
> so a single call can now process a batch — plus the required
> `destinationPath` that used to sit alongside it. A 0.1.x call needs its
> arguments reshaped: `{ url: "..." }` becomes `{ destinationPath: "...",
> videos: [{ url: "..." }] }` (`resolve_video`), same idea for
> `analyze_video`'s `pathOrUrl`. The **on-disk output layout is unaffected**
> at `videos.length === 1` — a single-item call still writes exactly where
> 0.1.x did, byte-for-byte (`manifest.json` etc. flat in `destinationPath`,
> no `video-1/` subdirectory) — but the **JSON reply shape** changed too:
> every reply is now `{ videos: [...] }`, one entry per item, even for a
> single video. See the current schemas just below for the exact shape.

The surface is deliberately small. Earlier versions had four tools and the descriptions had to shout about which ones took URLs versus local paths — a sign the design was wrong, not that the warning needed to be louder.

### `resolve_video` — look it up, optionally fetch it

```ts
resolve_video({
  destinationPath: string,          // required — shared by every item below
  videos: [{                        // one entry per video, at least one
    url:             string,        // required
    returnVideo?:    boolean,       // default false: metadata only, no download
    start?:          number,        // seconds; only with returnVideo: true
    end?:            number,
    comments?:       boolean,       // default false — slow on popular videos
  }],
})
```

One video — the common case, written flat into `destinationPath`:

```ts
resolve_video({
  destinationPath: "./out",
  videos: [{ url: "https://youtube.com/watch?v=..." }],
})
// -> ./out/metadata.json
```

Several videos in one call — each gets its own subdirectory, `video-1/`, `video-2/`, ... in array order:

```ts
resolve_video({
  destinationPath: "./out",
  videos: [
    { url: "https://youtube.com/watch?v=..." },
    { url: "https://tiktok.com/@user/video/...", returnVideo: true },
  ],
})
// -> ./out/video-1/metadata.json
// -> ./out/video-2/metadata.json + source.mp4 (returnVideo: true)
```

By default it downloads **nothing heavy**. You get title, creator, duration, the chapter list when the platform publishes one, and a short description preview. That is usually enough to decide what to do next — and it composes with ranges into the workflow that makes this whole thing efficient:

> Read the chapters → see the demo starts at 12:04 → analyze only 12:04–20:00 → skip 90% of the download, transcription, and frame work.

### `analyze_video` — the real work

```ts
analyze_video({
  destinationPath: string,                      // required — shared by every item below
  videos: [{                                     // one entry per video, at least one
    pathOrUrl:       string,                     // URL *or* a local file — both work
    start?:          number,                     // seconds
    end?:            number,                     // end === start means one instant
    frames?:         "key" | "even" | "none",    // default "key"
    maxFrames?:      number,                     // default 35
    transcript?:     boolean,                    // default true
    language?:       string,                     // optional override, e.g. "zh"
  }],
})
```

One video — the common case, written flat into `destinationPath`, byte-identical to a 0.1.x call:

```ts
analyze_video({
  destinationPath: "./out",
  videos: [{ pathOrUrl: "https://youtube.com/watch?v=..." }],
})
// -> ./out/manifest.json, ./out/transcript.json, frame images
```

Several videos in one call — each gets its own subdirectory, `video-1/`, `video-2/`, ... in array order, and one item failing never fails the others:

```ts
analyze_video({
  destinationPath: "./out",
  videos: [
    { pathOrUrl: "https://youtube.com/watch?v=...", maxFrames: 10 },
    { pathOrUrl: "./local-clip.mp4", frames: "none" },
  ],
})
// -> ./out/video-1/manifest.json, transcript.json, frame images
// -> ./out/video-2/manifest.json, transcript.json, no frame images (frames: "none")
```

- `"key"` runs the importance selector and returns the best frames, deduplicated.
- `"even"` samples the range uniformly — `maxFrames` sets the density, so 60 frames across 30 seconds is 2fps.
- `"none"` returns no frames at all. That is how you ask for a transcript alone.
- One exact frame: `start: 7, end: 7, frames: "even", maxFrames: 1, transcript: false`.

Frame selection is bounded to `start`–`end` in both modes, and the transcript covers only the selected range.

## Background tasks

Both tools are task-capable. Called as a plain MCP tool call, every example above behaves exactly as shown, on every client, whether or not it knows what a task is — but plain calls now carry a small latency floor, honestly: both tools are registered so that a client marking a call as a **task** gets a handle back immediately instead of blocking, and a *plain* call is served by the MCP SDK's own automatic task-polling bridge underneath, which waits one poll interval (~150ms) before its first status check no matter how fast the work actually finishes. 0.1.x had no such floor. ~150ms is not noticeable next to a real download or transcription, but it is not zero, and a caller timing something trivial (a cheap metadata-only `resolve_video`, say) will see it. Called as a **task** — an MCP client marks the call that way, using the (experimental) MCP tasks capability — the tool returns a handle immediately instead of blocking, and pushes progress while the work runs. This matters most for `analyze_video`, where a real video can take minutes.

- **Status messages** describe where the batch is: `"video 2/3: transcribing"` for an item currently running, `"queued, 1 ahead"` for an item waiting on a concurrency slot. Status is visible through client polling (roughly once every 150ms), so it is a snapshot at each poll, not a live per-stage feed — a stage that starts and finishes between two polls can be coalesced away.
- **Cancellation is honest, not performative — and it is per task, not per item.** A task none of whose items has started executing cancels fully: nothing runs, nothing is written. The moment any item's execution begins, the whole task refuses cancellation — identically for both tools — with a message saying it will finish and deliver its result rather than silently disappearing; a five-video batch with one item already running refuses even while four are still queued. `resolve_video` never queues at all, so a cancel on a live `resolve_video` task always hits that refused case.
- **Handles are in-memory only.** They expire `VIDEO_EXTRACT_TASK_TTL_MS` after the task completes (default 30 minutes) and die with the server process regardless — the server process itself exits promptly once its stdin closes, even with handles still pending. Files already written to `destinationPath` are unaffected either way — the tool never deletes them, expired handle or not.
- **Plain calls work everywhere, with that one caveat.** Task support requires an MCP client that implements the experimental tasks capability; without one, both tools behave exactly as documented above, synchronously, modulo the ~150ms floor above.

## Watching progress

`statusMessage` (above) is a snapshot at each poll — useful, but coalesced, and gone once the task completes. For anything longer-lived — checking from a different terminal, after a client restarted, across every video every server on the machine is working on — every server also runs a small, local status channel, on by default. Its one governing rule: **the server reports observations, never judgments.** No response anywhere in this channel ever says `stale`, `stuck`, or `healthy`, or invents a completion percentage — that call belongs to whoever is asking, made by polling twice and comparing.

**The CLI.** Once installed, `video-extract status [--watch] [--json] [url...]` discovers every *live* `video-extract-mcp` server on the machine — each MCP client spawns its own server process, and this merges across all of them, not just whichever one you happen to be talking to — and renders one view:

```
https://youtu.be/AbC123xyz  resolving → downloading → transcribing  (45s in stage) · asrWorker pid 4122 · cpu 38.2s · workdir 892 MB
https://youtu.be/DeF456uvw  resolving → downloading → transcribing → frames  (done 2m ago)
https://tiktok.com/@u/video/789  resolving → downloading  (372s in stage) · yt-dlp pid 4210 · cpu 12.4s · workdir 412 MB
https://youtu.be/JkL012rst  queued
server pid 4098 · up 14m · cap 4 · running 2 · queued 1
```

Every field is exactly what it says: raw stage names in the order they fired, raw elapsed time, the child process actually doing the work and its cumulative CPU, and — for an item still in progress only — the working directory's byte count so far; a completed item's directory is done changing, so its own line carries no `workdir` clause. `--watch` re-renders in place every second until you press Ctrl-C; `--json` prints the same, merged across every live server, as plain JSON with no ANSI control bytes, for scripting rather than reading; any positional argument filters the output to just that URL (repeatable). With no live servers, the human-readable render prints `no live video-extract servers`; `--json` prints `[]` instead — either way it exits 0.

**The endpoint.** Every server also runs a localhost-only `GET /status` — bound to an ephemeral port by default — that the CLI above is itself just a client of. Its URL reaches an agent two ways, so nobody has to shell out to find it: the completed result's `statusUrl` field (`null` when the endpoint is disabled), and, for a task-mode caller that only has a handle so far, the handle reply's own `statusMessage`, prefixed `status: <url>` — with no such prefix at all, not a null, when the endpoint is disabled:

```bash
curl http://127.0.0.1:PORT/status
curl 'http://127.0.0.1:PORT/status?url=https://youtu.be/AbC123xyz'   # repeatable
```

`VIDEO_EXTRACT_STATUS_PORT` pins that port instead of picking one at random; the literal value `0` disables the endpoint entirely (see the environment table below).

**Telling slow from stuck.** The server reports observations, never judgments — poll twice and compare CPU/bytes to tell a slow download from a stuck one. A download silent for six minutes is routine for a huge video and a bug on bad wifi; nothing in this channel guesses which. Fetch `/status` (or run `video-extract status`) a few seconds apart and diff `childCpuSeconds` and the workdir byte count for the item in question — moving means it's working, flat means it genuinely is not.

**Stopping something.** There is no `cancel` subcommand for this channel — stopping is a plain `kill` against a pid the status output just showed you, and the two targets you can aim it at behave differently, on purpose: killing an item's child process makes that item fail honestly while the batch continues and the task itself still completes; killing the server's own pid stops everything, and whatever was already written to `destinationPath` survives, exactly as if the server had exited normally.

**Half-downloaded files are cleaned up.** A download in flight is written under a `.part` name and renamed only once every byte has arrived, so a killed process can never leave something that *looks* like a finished video. A direct or WeChat download that fails removes its own bytes immediately. A failed `yt-dlp` download deliberately does not: yt-dlp picks its own filenames, so two calls into one directory produce the same names, and nothing can tell abandoned bytes from a concurrent download's live ones. Those are collected instead by the next download into that directory, which removes the leftovers it recognises once they are more than six hours old — old enough that nothing still running could own them. The same sweep is what resolves the crash and reboot cases, where no code of ours was left to clean up.

Only files this tool itself created are ever removed, matched on the `source.*` names it downloads under — never a manifest, transcript, frame or completed video, and never a `.part` file left by your browser or your own `yt-dlp` run.

A server that exits takes its in-memory status history with it — there is no cross-restart persistence, by design (see `docs/follow-ups.md`). Nothing about that loses what matters: the files at `destinationPath` are the durable record either way.

## What "important frame" actually means

Each candidate frame is scored on:

| Signal | What it catches |
|---|---|
| Scene boundaries | Hard cuts, shot changes — sampled ~250–500ms *after* the boundary so you get the new scene, not the transition |
| On-screen text novelty | A slide whose text changed, spatially aware so a persistent subtitle bar doesn't read as "new" |
| Visual quality | Rejects motion-blurred and out-of-focus frames before they compete |
| Embedding similarity | SigLIP vision embeddings, so two frames that *look* the same don't both survive |

Selection is iterative and diversity-aware (maximal marginal relevance), not a fixed weighted sum — so picking one frame changes what the next pick is worth. Every returned frame carries its `importance` score and the reasons it was chosen.

## Supported sources

Genuinely exercised code paths: **YouTube, TikTok, Facebook and Reels, X/Twitter, Instagram, Twitch, Vimeo, Reddit, WeChat Channels**, and direct `.mp4`/`.m3u8` URLs. Many other sites work through yt-dlp's generic extraction. Some will not, and those return a clear failure status rather than throwing.

WeChat Channels (视频号) support is worth calling out: it resolves **headlessly**, through a documented request sequence, with no browser automation and no MITM proxy. It needs a `VIDEO_EXTRACT_WECHAT_COOKIE` environment variable. The protocol was derived clean-room from Tencent's own served frontend and authenticated probes — deliberately *without* consulting existing implementations, since the well-known one is MIT + Commons Clause and would have restricted commercial use.

## Design constraints worth knowing

**Memory is a per-concurrency rate, not a flat ceiling.** Speech recognition and vision embedding are both heavy models, so within one analysis they never coexist: each runs in its own worker process that exits before the next starts. ~1.1 GB peak per concurrent analysis; total footprint ≈ concurrency × 1.1 GB. Default cap 4 ⇒ plan for ~4.5 GB worst case. `VIDEO_EXTRACT_MAX_CONCURRENCY=1` restores the old flat under-2GB behavior.

**Single Node runtime.** No Python sidecar, no subprocess to a second language runtime. Speech recognition is `sherpa-onnx-node`; vision embeddings are `@huggingface/transformers`.

**Range requests are real.** For yt-dlp sources, asking for 30–340s of a two-hour video downloads roughly five minutes of media, not two hours. Direct URLs and WeChat download then trim locally. Either way, a fetched clip **starts at zero** — the reply says so and gives you the offset.

**Degradation is visible.** If OCR dies, or embeddings fail, or speech recognition errors out, the run continues and records a warning. An empty transcript is always distinguishable from a video that simply has no speech.

**Cheap requests are cheap.** A single-frame request skips scene detection, quality filtering, OCR, embeddings, transcription, *and* the video re-encode. Measured at ~240ms whether the source is 6 seconds or 5 minutes long.

**A transcript-only request doesn't download the video.** Ask for `frames: "none"` on a video that has captions and the media is never fetched at all — the captions answer the question, and nothing else in the pipeline needs the file. Measured on a 27-minute YouTube video: 888 KB instead of 285 MB. The reply simply omits `videoPath` in that case, because there is no local file to point at. Add a `start`/`end` range and it downloads as before — a range makes the clip's time base load-bearing, so that case is deliberately left alone.

## Status

**This is a working proof of concept, and honest about what that means.**

What is verified:

- 584 automated tests pass, including integration tests driving a real MCP client end-to-end against synthetic video fixtures — among them the status channel's own kill-workflow test: observe a live item's child pid via `/status`, kill it, confirm that item fails honestly while its batch sibling still completes.
- The WeChat resolution protocol was verified live, end to end, returning a real MP4.
- Caption-tier selection was verified against the installed yt-dlp's own source.
- The memory rate and single-frame latency are measured numbers, not estimates.

What is **not** verified:

- **The live-platform acceptance matrix has never been run.** `docs/acceptance-matrix.md` reports 0 of 11 rows executed, because it needs real URLs supplied via environment variables. Every platform above is a code path that is unit- and integration-tested — not a platform someone has watched succeed on a live link.

If you run the matrix against real URLs, that result is the single most valuable contribution this project can receive right now. See below.

## Contributing

Contributions are genuinely welcome, and there is a clear on-ramp. **[CONTRIBUTING.md](CONTRIBUTING.md)** has the full version — setup, the build trap that will otherwise waste your first hour, the testing standard, and the invariants that break quietly. The short version:

**Highest value first:** run `npm run matrix` with real URLs in the environment variables it names, and open an issue with what you saw. That converts the project's biggest unknown into fact.

**Also open, with context already written down:** `docs/follow-ups.md` records every deliberately-deferred item with its reasoning — selector weight calibration against real footage, end-of-file candidate edges, byte-range fetching for direct and WeChat sources, and more. These are not vague "good first issue" labels; each one explains what was tried and why it was left.

House rules, briefly:

- Tests are expected to *fail against broken code*. This project's most common review finding has been a test that passes either way — if you add a test, mutate the thing it guards and confirm it goes red.
- No Python. Single Node runtime.
- `src/types.ts` is the single source of truth for shared types.
- Keep the per-analysis staging invariant intact: within one video's pipeline, heavy stages (speech recognition, vision embedding) run sequentially, never concurrently — that discipline is what keeps the per-concurrent-analysis rate at ~1.1 GB. Across different videos, up to `VIDEO_EXTRACT_MAX_CONCURRENCY` analyses run at once by design.

```bash
npm test          # full suite
npm run typecheck # strict, with noUncheckedIndexedAccess
npm run matrix    # acceptance matrix (honest about skips)
```

## Requirements

| | |
|---|---|
| Node | ≥ 26 |
| System binaries | `ffmpeg`, `ffprobe`, `yt-dlp`, `tesseract` (with `chi_sim` for Chinese OCR) |
| Models | ~1.5 GB, fetched by `scripts/fetch-models.sh` — Silero VAD, Whisper small, SenseVoice |
| Platform | Developed on macOS/arm64; nothing is platform-specific by design, but other platforms are untested |

Speech recognition routes by language: `zh`, `yue`, `ja`, `ko` → SenseVoice; everything else → Whisper. There is no audio-based language detection, because the installed library returns a constant value regardless of what is actually spoken — supply `language` when you know it.

## License

MIT — see [LICENSE](LICENSE).

---

<sub>Keywords: MCP server, Model Context Protocol, video transcription, keyframe extraction, YouTube transcript, TikTok downloader, WeChat Channels 视频号, Whisper, SenseVoice, SigLIP, yt-dlp, scene detection, AI agent tools, video understanding, local ASR, TypeScript, Node.js</sub>
