# video-extract-mcp

**Give an AI agent any video link: download the file, read the transcript, or get just the frames that matter — all on your own machine.**

Two jobs, and you can use either on its own:

**Get the video.** A YouTube link, a TikTok, a WeChat Channels share URL, a raw `.mp4`, or a page from a site nobody has heard of — it resolves and downloads it, whole or just the section you asked for. If that is all you need, stop there; nothing forces you to analyse anything.

**Or read it.** A transcript (real captions when the platform has them, local speech recognition when it does not) and a small set of *important* keyframes — deduplicated, scene-aware, and scored — instead of a thousand near-identical stills.

Built for AI agents. Three MCP tools, no cloud, no API keys, no Python.

[![npm](https://img.shields.io/npm/v/@yanlinglabs/video-extract-mcp)](https://www.npmjs.com/package/@yanlinglabs/video-extract-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)
[![CI](https://github.com/yanlingLabs/video-extract-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/yanlingLabs/video-extract-mcp/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-server-orange.svg)](https://modelcontextprotocol.io)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-com.yanlinglabs%2Fvideo--extract--mcp-blue.svg)](https://registry.modelcontextprotocol.io/v0/servers?search=video-extract)

---

## What it can do

**Get the video, from almost anywhere.** Paste a link and it resolves: YouTube, TikTok, Instagram, X, Facebook and Reels, Twitch, Vimeo, Reddit, WeChat Channels, a bare `.mp4` or `.m3u8`, or a page on a site nobody has heard of. Local files work too. Anything unsupported comes back as a clear failure rather than a crash.

From there you choose how much work to pay for:

- **Just look it up.** Title, creator, duration, chapter list, description, comment count — without downloading a byte. On a long video this is how you find the one section worth analysing.
- **Download the file.** The whole thing, or just seconds 300–420 of it. Where the platform supports ranged fetching, only that section is transferred rather than the full video.
- **Get a transcript.** Real captions when the platform has them, in any language it publishes; local speech recognition when it has none. The result says which you got. A captions-only request skips the download entirely — seconds instead of minutes.
- **Get the frames that matter.** Not every Nth frame: scene changes, on-screen text appearing, genuinely new visuals — deduplicated and scored, typically a few dozen for an hour of video. Or uniform sampling, or one exact frame at one exact second, if that is what you need.
- **Do several at once.** Pass a list of videos and get a result per video; one failing does not sink the rest.
- **Reach private or rate-limited content.** Point it at your browser's cookies and it can fetch age-restricted, members-only or followers-only media, and shrug off the bot checks that block anonymous downloads.
- **Run long jobs in the background.** A full analysis of an hour-long video takes minutes; it can run as a background task, report progress over a local HTTP endpoint, and hand back the result even if your client gave up waiting.

Everything happens on your machine. No API key, no upload, no third-party service.

## Why this exists

Two problems, really. Getting the video at all — every platform hides its media behind a different mechanism, and none of them want a script fetching it. And then reading it: an LLM cannot watch a video, and the usual workaround — dump every Nth frame into the context window — burns enormous amounts of context on frames that are 98% identical to the one before, while still missing the slide that changed when nothing else moved.

`video-extract-mcp` handles both:

- **Fetching, from almost anywhere.** One resolver chain covers the big platforms, direct media URLs, and generic sites, with ranged fetches where the platform allows them and cookie support for anything that needs a login. Downloading is a complete use of this tool, not a step on the way to something else.

- **Transcript, honestly sourced.** The platform's own captions are used whenever the video has any — human-written first, otherwise the platform's automatic ones. Audio is transcribed locally (Whisper or SenseVoice) only when the video has no captions, or when the captions it has could not be retrieved. The result tells you which you got via `transcript.source`, and for a local transcript `transcript.asrReason` says why (`no_captions` or `captions_failed`; a failed retrieval is also listed in `warnings`).
- **Keyframes chosen, not sampled.** Scene-boundary detection, blur/quality filtering, on-screen-text novelty (subtitle-aware, so burned-in captions don't preserve redundant frames), and image-embedding similarity feed an iterative diversity-aware selector.
- **Output goes to disk, not into your context.** The tool reply is a compact summary plus file paths. A 35-frame manifest and a full transcript don't belong in a conversation where the agent needs three numbers from them.
- **Everything runs on your machine.** No third-party API, no upload, no key. Long analyses can run as MCP background tasks — the tool returns a handle immediately and pushes progress; see Background tasks below.

## Quick start

Install the system programs first; they can't come from npm. You need `ffmpeg` (with `ffprobe`), `yt-dlp`, Deno (yt-dlp needs it for YouTube), `tesseract` with Chinese language data, and Node ≥ 22.12.

**macOS** (the tested platform):

```bash
brew install node ffmpeg yt-dlp tesseract tesseract-lang    # Homebrew's yt-dlp brings Deno along
```

**Windows** (not yet run there; these come from the package manifests), in PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
winget install yt-dlp.yt-dlp            # also installs Deno and an ffmpeg build with ffprobe
winget install tesseract-ocr.tesseract
```

Then open a new terminal. Tesseract's installer doesn't add itself to `PATH`, and winget doesn't add Chinese language data; [INSTALL.md](INSTALL.md#windows) has both steps.

**Linux:** your distribution's `yt-dlp` is usually too old for YouTube, and Deno isn't packaged. [INSTALL.md](INSTALL.md#linux) has the Debian/Ubuntu and Fedora steps.

Restart your agent after installing, so the server it launches sees the new programs.

Then point your MCP client at the package. There are two ways, and they differ in ways worth thirty seconds of your time.

**Option A — `npx`, nothing installed.** Simplest, and it picks up new releases on its own.

Claude Code:

```bash
claude mcp add --scope user video-extract -- npx -y @yanlinglabs/video-extract-mcp@latest
```

Codex:

```bash
codex mcp add video-extract -- npx -y @yanlinglabs/video-extract-mcp@latest
```

**Another agent?** Point it at **[INSTALL.md](https://github.com/yanlingLabs/video-extract-mcp/blob/main/INSTALL.md)** and it can install itself. It covers Gemini CLI, Grok, opencode, Hermes Agent, OpenClaw, Pi, Kilo Code, Cline and DeepSeek Harness, says how each recipe was checked, and lists the tool-call timeout to raise in each: a full analysis takes minutes, and several stop waiting after one.

**Keep the `@latest`** — without it npx pins to the first version it cached and never updates.

**Option B — installed globally.** Starts faster and gives you the `video-extract` status CLI as a real command.

```bash
npm install -g @yanlinglabs/video-extract-mcp
```

Then register it — Claude Code:

```bash
claude mcp add --scope user video-extract -- video-extract-mcp
```

Codex:

```bash
codex mcp add video-extract -- video-extract-mcp
```

|  | `npx` (A) | global install (B) |
|---|---|---|
| Updates | automatic **only with `@latest` in the spec** — a bare `npx -y @yanlinglabs/video-extract-mcp` pins to the first version it cached and never updates | **manual: `npm update -g @yanlinglabs/video-extract-mcp`**. You stay on the installed version until you run it |
| Startup | ~0.9s (npm resolution on every launch) | ~0.1s |
| `video-extract status` in your shell | not on `PATH` — needs `npx -y -p @yanlinglabs/video-extract-mcp video-extract status` | works directly |
| Working directory | must not be this package's own checkout (see below) | irrelevant |

Neither affects what agents can do: an agent checks on background work over HTTP using the `statusUrl` handed to it in the reply, never a shell command. The CLI is for humans.

Or in any MCP client's config — `"command": "npx", "args": ["-y", "@yanlinglabs/video-extract-mcp@latest"]` for A, or `"command": "video-extract-mcp"` with no args for B:

```json
{
  "mcpServers": {
    "video-extract": {
      "command": "npx",
      "args": ["-y", "@yanlinglabs/video-extract-mcp@latest"]
    }
  }
}
```

> **One gotcha with `npx`, and it only bites contributors.** Run inside this package's own git checkout, `npx @yanlinglabs/video-extract-mcp` fails with `command not found` — npx sees the local `package.json` claiming that name, looks for the binary in a local `node_modules/.bin` that was never populated, and gives up. Since MCP clients launch servers with the working directory set to your project, option A cannot work *in this repo*. Working on the tool itself? Point that one project at your build — `claude mcp add --scope local video-extract -- node "$PWD/dist/mcp.js"` — which also means a `npm run build` takes effect immediately, with no publish round-trip. Everywhere else, `npx` is fine.

That is enough for any video that has captions — which, thanks to the caption-first transcript policy, is most of them. The vision model downloads itself on first use.

**Speech models are only needed for videos with no captions at all**, and they are fetched automatically the first time one is. Only the engine that video needs is downloaded — 233 MB for the Chinese/Japanese/Korean model, 1.3 GB for Whisper — into `~/.cache/video-extract-mcp/models`. Set `VIDEO_EXTRACT_AUTO_FETCH_MODELS=0` to keep it manual, or pre-fetch them yourself:

```bash
npx -y -p @yanlinglabs/video-extract-mcp@latest video-extract cookies   # installs the package, then exits
curl -fsSL https://raw.githubusercontent.com/yanlingLabs/video-extract-mcp/main/scripts/fetch-models.sh \
  | bash -s -- ~/.cache/video-extract-mcp/models
```

`~/.cache/video-extract-mcp/models` is where the tool looks by default. Override with `VIDEO_EXTRACT_MODELS_DIR`. If the fetch is disabled or fails, an uncaptioned video still returns frames and records a warning explaining why the transcript is missing — it degrades rather than fails.

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
| `VIDEO_EXTRACT_AUTO_FETCH_MODELS` | Set `0` to stop the speech models being downloaded on demand. They are then your job (`scripts/fetch-models.sh`), and an uncaptioned video degrades with a warning saying so. |
| `VIDEO_EXTRACT_COOKIES_FILE` | Path to a Netscape-format cookie jar, used for **every** yt-dlp source at once — YouTube, Instagram, Facebook, X, TikTok, Twitch and the rest. See [Authenticated sources](#authenticated-sources). |
| `VIDEO_EXTRACT_COOKIES_FROM_BROWSER` | Load cookies from a local browser instead: `chrome`, `firefox`, `safari`, `edge`, `brave`, `chromium`, `opera`, `vivaldi`, `whale`, optionally `browser:profile`. Ignored when `VIDEO_EXTRACT_COOKIES_FILE` is set. |
| `VIDEO_EXTRACT_WECHAT_COOKIE` | A yuanbao session cookie for WeChat Channels links. Optional since a `userCookies` call can take the session from your browser instead (see [Per call, no restart](#per-call-no-restart-usercookies)). Separate from the above by design — a different protocol with its own credential. |
| `VIDEO_EXTRACT_MAX_CONCURRENCY` | Caps concurrent `analyze_video` item executions — plain calls and background tasks, batch items and separate calls, all count against the same limit. Default `2` (each analysis can take ~2 GB; see Memory below). `resolve_video` is exempt: it loads no models, so there is nothing to throttle. |
| `VIDEO_EXTRACT_TASK_TTL_MS` | How long a completed background-task handle stays queryable before it expires. Default `1800000` (30 minutes). `0` (or any non-positive value) means the handle never expires. Governs the in-memory handle only — files already written to `destinationPath` are never deleted by the tool, expired handle or not. |
| `VIDEO_EXTRACT_STATUS_PORT` | Pins the port of the localhost `/status` endpoint (see [Watching progress](#watching-progress)). Unset picks an ephemeral port each start (default: endpoint on). The literal value `0` disables the endpoint entirely — note the contrast with `VIDEO_EXTRACT_TASK_TTL_MS` above, where `0` means *no expiry*, not disabled. |

### Authenticated sources

Plenty of media is not public, and the answer is the same one the platforms themselves ask for: cookies. There are two ways to give them: per call, with nothing to configure, or as a standing setting in the environment.

#### Per call, no restart: `userCookies`

Both tools take `userCookies: true`. It means "the user said yes to their own browser, for this call": the server reads cookies from your **default** browser and sends them only to the site being fetched. Nothing carries over, so the agent has to ask again next time — the tool descriptions tell it to ask you first, every time, the way a shell tool asks before leaving its sandbox. No environment variable, no restart.

When a request is refused with no cookies sent (`auth_required`, `auth_expired`, `rate_limited`), the reply says so and suggests asking you. Every item reports what it sent, never a value:

| `cookies` | Meaning |
|---|---|
| `"none"` | Nothing was sent. |
| `"browser:safari"` (or `chrome`, `firefox`, …) | Cookies from that browser, via `userCookies` or `VIDEO_EXTRACT_COOKIES_FROM_BROWSER`. |
| `"cookies_file"` | The jar `VIDEO_EXTRACT_COOKIES_FILE` names. |
| `"wechat_cookie"` | `VIDEO_EXTRACT_WECHAT_COOKIE`. |

**When you need to sign in, it asks you, on a page of its own.** A sign-in page for a site nobody mentioned, appearing out of nowhere, is alarming. So instead of opening a login directly, the server opens a small page of its own in your browser, served from `127.0.0.1`. It is a few lines of plain text, like terminal output. It names your MCP client ("Claude Code is trying to download … using your browser cookies"), says whose cookies are missing ("Cookies for yuanbao.tencent.com, required for the WeChat Channels download, were not found"), and gives the sign-in link in green. For YouTube, Instagram, TikTok, X, Facebook, Twitch, Vimeo, Reddit and Bilibili that is the site's own sign-in page; for anything else it is the site's home page. Below that is a live status line with two controls: **[I've signed in]**, and **[don't sign in]**, which stops the wait at once and tells the agent not to retry. It holds no credential; the cookies are still read from the browser. The browser comes to the front with the page. The call waits up to 3 minutes; if you don't sign in within that time, it fails with a message asking you to finish signing in and retry.

What a WeChat sign-in looked like in real use (macOS, Safari, Claude Code): Safari came to the front on the page, the green link opened yuanbao.tencent.com, the user signed in with the QR code, came back and pressed **[I've signed in]**, and the download carried on.

- **WeChat Channels:** when the browser holds no yuanbao.tencent.com session. The page explains that WeChat Channels videos are fetched through yuanbao.tencent.com (Tencent's AI assistant), which is why that site asks you to sign in with WeChat. The server notices the sign-in on its own by checking yuanbao's `getuserinfo`, so there's nothing else to press.
- **Any other site:** when it still refuses the video with your browser's cookies (private, age-restricted, members-only, or a "confirm you're not a bot" check). There is no cheap way to check whether you are signed in to an arbitrary site, and every retry is a request to it, so a retry is spent only on a sign-in signal: pressing **I've signed in**, or a new cookie name appearing for that site (signing in adds session cookies; values changing does not count). At most 3 retries, 10 seconds apart when triggered by cookies. If it is still refused after that, the reply says the account probably can't access the video.

Every WeChat session is checked against yuanbao's `getuserinfo` before use. When the token is old, that response carries a renewed one, and the server now uses it instead of discarding it as earlier versions did. Keeping it may help a pasted `VIDEO_EXTRACT_WECHAT_COOKIE` expire less often, but that is unmeasured. A session taken from the browser is kept in memory, renewed each time, so later calls skip the browser read. Each call still has to pass `userCookies` to use it, and it is never written to disk.

Worth knowing:

- **"Your browser" means the default one**, because that is where a sign-in page opens and where the cookies are then read. If yt-dlp can't read the default (Arc, for instance), it falls back to an installed browser it can read and opens that one instead.
- **Chrome-family browsers show a macOS Keychain prompt** when read ("Chrome Safe Storage"). "Always Allow" stops it repeating; while waiting for a sign-in the server checks those browsers every 15 seconds rather than 5 for the same reason. Safari needs no prompt, but the app running the server may need Full Disk Access to read it; if it does, the reply says so.
- **Firefox may be slow to show a new sign-in:** yt-dlp copies only `cookies.sqlite`, not the write-ahead log where recent changes can sit until Firefox merges them.
- Only macOS with Safari has been exercised end to end, and only for WeChat. A real sign-in on another site (YouTube, Instagram, …) has not been watched yet. The Linux (`xdg-settings`) and Windows (`UserChoice`) default-browser lookups are tested code paths only.

#### Standing configuration

**One jar covers every yt-dlp source at once** — cookies are scoped by domain inside the file, so a single export authenticates YouTube, Instagram, Facebook, X, TikTok and Twitch together. It is not a YouTube-only setting. Like any environment variable, these take effect when the server starts.

```bash
export VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto       # recommended: borrow only when blocked
```

**`auto` is lazy, and that is the point.** Ordinary requests send no cookies at all. Only when a platform actually refuses one does the server take your default browser (the same one `userCookies` uses), retry that single request with its cookies, and stop — no loop. You pay the cost of touching a credential store only when something is genuinely blocked, which is also what keeps a borrowed session from being rotated out from under you on every public video.

The other two modes are eager — cookies on every request:

Read a browser's store directly (`chrome`, `safari`, `edge`, `brave`, …):

```bash
export VIDEO_EXTRACT_COOKIES_FROM_BROWSER=firefox
```

Or point at an exported Netscape-format jar:

```bash
export VIDEO_EXTRACT_COOKIES_FILE=~/cookies.txt
```

Set both and the file wins — they are alternatives, not a pair.

**Expect an OS keychain prompt.** Every Chrome-family browser encrypts its cookie store against the system keyring, so the first read shows a dialog you must approve — on macOS, "Chrome Safe Storage". Firefox and Safari do not. If a request is refused with no cookies sent, the reply suggests asking you about `userCookies`, and warns about that prompt, rather than leaving you to discover it.

What it unlocks, beyond simply logging in: age-restricted and members-only YouTube, most of Instagram and Facebook, much of X, subscriber-only Twitch — and **`rate_limited` / "sign in to confirm you're not a bot"**, which an anonymous fetch hits far sooner than a signed-in one.

Three things worth knowing before you use it:

- **A caller can never name a cookie file or a browser.** An agent that could do either could read any file on the machine, or pick any session on it. The most it can do is pass `userCookies: true`, which only ever means your default browser, for that one call, after asking you.
- **Your jar is never modified.** `--cookies FILE` doesn't only read that file, it rewrites it on exit; the tool copies your jar to a private temp file, hands yt-dlp the copy, and deletes it afterwards. The cost is that refreshed cookies aren't written back.
- **Exporting from a browser you are actively logged into can log you out.** Platforms rotate session cookies, and a copy taken from a live session goes stale — YouTube is especially prone to it. yt-dlp's own advice: export from a private/incognito window, then close that window *without* logging out.

A wrong path fails loudly rather than quietly fetching anonymously — an unreadable jar is a broken setup, not something to degrade past, and silently anonymous results would send you hunting the wrong bug.

**Check what you actually configured**, without printing a single cookie value:

```console
$ video-extract cookies
cookie jar: /Users/you/cookies.txt
  .youtube.com      12 cookies  expires in 23 days
  .instagram.com     4 cookies  expires in 3 days
  .x.com             2 cookies  EXPIRED 5 days ago
  3 domain(s), 18 cookies, 1 with expired cookies
```

It reports domains, counts and expiry — never names or values, so the output is safe to paste into an issue. It also names the mistake people actually make: an exporter set to JSON rather than the Netscape format produces a file that looks fine and contains nothing yt-dlp can read, which otherwise surfaces much later as a confusing `auth_required` on an unrelated video. Add `--json` for scripting.

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

## The tools

Two that do the work, plus one lookup.

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
// -> ./out/metadata.json (+ the caption file it points at, e.g. auto.en-orig.vtt, when the video has captions)
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

One video — the common case, written flat into `destinationPath`:

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

### `get_status` — collect a result after a timeout

```json
get_status({
  videos: [string, ...]        // required — the same URLs or paths you passed before
})
```

Returns one entry per video: `finished` with the result the original call would have given you, `running` with the stages it has reached, or `unknown`. Only reach for it when a call actually timed out — see below.

## Recovering a call your client stopped waiting for

Some clients cap how long they will wait for a tool call. When that happens the work **carries on** — the server keeps going and writes its files; only the client stops listening. To collect the result afterwards, ask about the video:

```json
get_status({ videos: ["https://youtube.com/watch?v=..."] })
```

Pass the same URL or file path you gave `analyze_video` or `resolve_video`, several at once if you like. A finished video returns exactly the result the original call would have given you; one still running returns the stages it has reached.

Nothing has to be prepared in advance — that is the point. The URL is required on every call, so you always have it, and recovery matters precisely when nobody thought to set it up. Matching is exact: a `?si=` parameter added or removed is a different string and answers `unknown`, because guessing which video you meant is worse than saying it does not know.

Records live in the server's memory and expire with `VIDEO_EXTRACT_TASK_TTL_MS`, so a restarted server answers `unknown` too — and says so plainly, because the files at `destinationPath` are the durable result either way.

## Background tasks

Both tools are task-capable. Called as a plain MCP tool call, every example above behaves exactly as shown, on every client, whether or not it knows what a task is — with a small latency floor of about 150ms, which is invisible next to a real download but not zero on a cheap metadata-only call. Called as a **task** — an MCP client marks the call that way, using the (experimental) MCP tasks capability — the tool returns a handle immediately instead of blocking, and pushes progress while the work runs. This matters most for `analyze_video`, where a real video can take minutes.

- **Status messages** describe where the batch is: `"video 2/3: transcribing"` for an item currently running, `"queued, 1 ahead"` for an item waiting on a concurrency slot. Status is visible through client polling (roughly once every 150ms), so it is a snapshot at each poll, not a live per-stage feed — a stage that starts and finishes between two polls can be coalesced away.
- **Cancellation is honest, not performative — and it is per task, not per item.** A task none of whose items has started executing cancels fully: nothing runs, nothing is written. The moment any item's execution begins, the whole task refuses cancellation — identically for both tools — with a message saying it will finish and deliver its result rather than silently disappearing; a five-video batch with one item already running refuses even while four are still queued. `resolve_video` never queues at all, so a cancel on a live `resolve_video` task always hits that refused case.
- **Handles are in-memory only.** They expire `VIDEO_EXTRACT_TASK_TTL_MS` after the task completes (default 30 minutes) and die with the server process regardless — the server process itself exits promptly once its stdin closes, even with handles still pending. Files already written to `destinationPath` are unaffected either way — the tool never deletes them, expired handle or not.
- **Plain calls work everywhere, with that one caveat.** Task support requires an MCP client that implements the experimental tasks capability; without one, both tools behave exactly as documented above, synchronously, modulo the ~150ms floor above.
- **Some clients cannot use tasks at all** — the Claude desktop app is one, and says so when asked. There the flow is a plain call that may hit the client's own time limit; the server keeps working regardless, and [`get_status`](#get_status--collect-a-result-after-a-timeout) collects the result afterwards.

## Watching progress

`statusMessage` (above) is a snapshot at each poll — useful, but coalesced, and gone once the task completes. For anything longer-lived — checking from a different terminal, after a client restarted, across every video every server on the machine is working on — every server also runs a small, local status channel, on by default. Its one governing rule: **the server reports observations, never judgments.** No response anywhere in this channel ever says `stale`, `stuck`, or `healthy`, or invents a completion percentage — that call belongs to whoever is asking, made by polling twice and comparing.

**The CLI.** Once installed, `video-extract status [--watch] [--json] [url...]` discovers every *live* `video-extract-mcp` server on the machine — each MCP client spawns its own server process, and this merges across all of them, not just whichever one you happen to be talking to — and renders one view:

```
https://youtu.be/AbC123xyz  resolving → downloading → transcribing  (45s in stage) · asrWorker pid 4122 · cpu 38.2s · workdir 892 MB
https://youtu.be/DeF456uvw  resolving → downloading → transcribing → frames  (done 2m ago)
https://tiktok.com/@u/video/789  resolving → downloading  (372s in stage) · yt-dlp pid 4210 · cpu 12.4s · workdir 412 MB
https://youtu.be/JkL012rst  queued
server pid 4098 · up 14m · cap 2 · running 2 · queued 1
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

**Half-downloaded files are cleaned up.** A download in flight is written under a `.part` name and renamed only once every byte has arrived, so a killed process can never leave something that *looks* like a finished video. Leftovers from a crash, a kill or a reboot are collected by the next call into that directory.

Only files this tool itself created are ever removed — its own partial downloads and scratch directories. Never a manifest, transcript, frame or completed video, and never a `.part` file left by your browser or your own `yt-dlp` run.

**You get results, not scratch.** The pipeline produces far more than it returns — every scene-boundary candidate before filtering, and a normalized re-encode in `frames: "key"` mode. That work happens in a scratch subdirectory which is deleted when the item finishes, so `destinationPath` receives the manifest, the transcript, exactly the frames the reply names, and the one video file `videoPath` points at.

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

WeChat Channels (视频号) support is worth calling out: it resolves **headlessly**, through a documented request sequence, with no browser automation and no MITM proxy. It needs a signed-in yuanbao.tencent.com session: from your browser on a `userCookies` call (which opens the site for you to sign in when there is none), or from a `VIDEO_EXTRACT_WECHAT_COOKIE` environment variable. The protocol was derived clean-room from Tencent's own served frontend and authenticated probes — deliberately *without* consulting existing implementations, since the well-known one is MIT + Commons Clause and would have restricted commercial use.

## Design constraints worth knowing

**Memory is a per-concurrency rate, not a flat ceiling.** Speech recognition and vision embedding are both heavy models, so within one analysis they never coexist: each runs in its own worker process that exits before the next starts. The peak depends on which speech model runs. Measured per analysis: **~2.0 GB** when Whisper transcribes (any non-CJK video without usable captions: the Whisper worker alone reaches ~1.9 GB, creeping to ~2.1 GB over 26 minutes of speech), **~1.1 GB** with SenseVoice (Chinese, Japanese, Korean, Cantonese), and under 1 GB when captions supply the transcript (the image-embedding stage is then the heaviest, ~0.8 GB). Total footprint ≈ concurrency × that. Default cap 2 ⇒ plan for ~4 GB worst case. `VIDEO_EXTRACT_MAX_CONCURRENCY=1` keeps it to a single analysis, ~2 GB; raising it to 4 means ~8 GB.

**Single Node runtime.** No Python sidecar, no subprocess to a second language runtime. Speech recognition is `sherpa-onnx-node`; vision embeddings are `@huggingface/transformers`.

**Range requests are real.** For yt-dlp sources, asking for 30–340s of a two-hour video downloads roughly five minutes of media, not two hours. Direct URLs and WeChat download then trim locally. Either way, a fetched clip **starts at zero** — the reply says so and gives you the offset.

**Degradation is visible.** If OCR dies, or embeddings fail, or speech recognition errors out, the run continues and records a warning. An empty transcript is always distinguishable from a video that simply has no speech.

**Cheap requests are cheap.** A single-frame request skips scene detection, quality filtering, OCR, embeddings, transcription, *and* the video re-encode. Measured at ~240ms whether the source is 6 seconds or 5 minutes long.

**A transcript-only request doesn't download the video.** Ask for `frames: "none"` on a video that has captions and the media is never fetched at all — the captions answer the question, and nothing else in the pipeline needs the file. Measured on a 27-minute YouTube video: 888 KB instead of 285 MB. The reply simply omits `videoPath` in that case, because there is no local file to point at. Add a `start`/`end` range and it downloads as before.

## Status

Tested live on macOS (Apple Silicon), on real videos, as of 0.16.0 (2026-09-23):

- **The acceptance matrix ran against real URLs: all 10 executed rows pass** ([docs/acceptance-matrix.md](docs/acceptance-matrix.md)). Those were YouTube with manual captions and with none (Whisper), TikTok, Facebook, a sign-in-walled YouTube video (a clean `auth_required`), a direct MP4, a video embedded in a web page, WeChat Channels and a Chinese Bilibili video (SenseVoice). The ranged-download row failed on the first run because YouTube refused the ranged fetch with a 403. A refused range now falls back to downloading the whole video and trimming it locally, and the row passes. The DRM row was not run; no DRM page was at hand.
- **Downloads from X, Twitch and Instagram** also worked live, with no cookies needed. **Vimeo** now requires a signed-in account in yt-dlp (2026.08.19), so it needs `userCookies` and a Vimeo sign-in; Reddit has not been tried.
- **Browser cookies and sign-in** (`userCookies`) ran end to end with Safari, including a real WeChat sign-in through the sign-in page.
- 821 automated tests pass, including integration tests driving a real MCP client end to end, and CI runs them on Linux and macOS with Node 22 and 26.
- The memory rate and single-frame latency are measured numbers, not estimates.

What has not been run live: Intel Macs, Linux beyond CI's test suite, and Windows. Nothing in the code is tied to macOS, so most of it should work elsewhere, but the native libraries it relies on differ by platform (see [Platform support](#platform-support)).

If you run `npm run matrix` on another platform, or against sites not listed above, that result is the most useful contribution this project can receive. See below.

## Contributing

Contributions are genuinely welcome, and there is a clear on-ramp. **[CONTRIBUTING.md](CONTRIBUTING.md)** has the full version — setup, the build trap that will otherwise waste your first hour, the testing standard, and the invariants that break quietly. The short version:

**Highest value first:** run `npm run matrix` with real URLs in the environment variables it names, on a platform other than Apple Silicon macOS, and open an issue with what you saw.

**Also open, with context already written down:** `docs/follow-ups.md` records every deliberately-deferred item with its reasoning — selector weight calibration against real footage, end-of-file candidate edges, byte-range fetching for direct and WeChat sources, and more. These are not vague "good first issue" labels; each one explains what was tried and why it was left.

House rules, briefly:

- Tests are expected to *fail against broken code*. This project's most common review finding has been a test that passes either way — if you add a test, mutate the thing it guards and confirm it goes red.
- No Python. Single Node runtime.
- `src/types.ts` is the single source of truth for shared types.
- Keep the per-analysis staging invariant intact: within one video's pipeline, heavy stages (speech recognition, vision embedding) run sequentially, never concurrently — that discipline is what keeps the per-concurrent-analysis rate at ~2 GB (Whisper) or ~1.1 GB (SenseVoice) instead of their sum. Across different videos, up to `VIDEO_EXTRACT_MAX_CONCURRENCY` analyses run at once by design.

```bash
npm test          # full suite
npm run typecheck # strict, with noUncheckedIndexedAccess
npm run matrix    # acceptance matrix (honest about skips)
```

## Requirements

| | |
|---|---|
| Node | ≥ 22.12 |
| System binaries | `ffmpeg`, `ffprobe`, `yt-dlp`, Deno (yt-dlp's JavaScript runtime for YouTube), `tesseract` (with `chi_sim` for Chinese OCR). Per-OS steps: [INSTALL.md](INSTALL.md) |
| Models | ~1.5 GB, fetched by `scripts/fetch-models.sh` — Silero VAD, Whisper small, SenseVoice |
| Platform | Developed on macOS/arm64; see [Platform support](#platform-support) |

Speech recognition routes by language: `zh`, `yue`, `ja`, `ko` → SenseVoice; everything else → Whisper. There is no audio-based language detection, because the installed library returns a constant value regardless of what is actually spoken — supply `language` when you know it.

## Platform support

Nothing in this code is platform-specific by design, but the native libraries it runs on are, and they set the limits:

| Platform | Status |
|---|---|
| macOS, Apple Silicon | Developed here and tested live: the acceptance matrix against real URLs, and downloads from nine platforms. The speech-recognition library's bundled runtime declares macOS 15.5 as its minimum; older versions are untested. |
| macOS, Intel | `onnxruntime-node` has shipped no Intel Mac binary since 1.24, so image embeddings run on a WebAssembly fallback: near-identical results, several times slower, noted in `processing.warnings`. Local speech recognition needs macOS 15. Not yet run on real Intel hardware. |
| macOS 12 | See below. |
| Linux (glibc) | The full test suite runs there in CI; no live runs against real URLs yet. Expected to work. |
| Windows | Not run yet. The engine should work, but browser cookies are the weak spot there: Chrome's app-bound encryption is known to block yt-dlp from reading them. |

### macOS 12 (Monterey)

A contributor ran the pipeline on macOS 12.7.6 (Intel) and documented what it takes ([#5](https://github.com/yanlingLabs/video-extract-mcp/pull/5)). Their setup patched onnxruntime's binary; this release uses the WebAssembly fallback instead, which has not been run on macOS 12 yet.

- **Node 22, not 26.** Node 26 can't start on macOS 12: its binary needs a libc++ symbol that macOS 12 doesn't export.
  ```
  dyld: Symbol not found: (__ZNSt3__122__libcpp_verbose_abortEPKcz)
    Expected in: /usr/lib/libc++.1.dylib
  ```
  This package supports Node 22.12 and later, so use the latest Node 22 (`nvm install 22`).
- **Image embeddings need the fallback.** onnxruntime's older Intel binaries were built against a newer libc++ than macOS 12 has, so they fail to load (`Symbol not found: __ZNSt3__18to_charsEPcS0_d`), and the current version has no Intel binary at all. The fallback doesn't use the native library.
- **No local speech recognition** for videos without captions: sherpa-onnx's Intel build needs macOS 15. Captioned videos work.
- **No OCR.** Homebrew has no tesseract bottle for Monterey (`brew install --force-bottle tesseract` answers `` `--force-bottle` passed but tesseract has no bottle! ``), and building it from source means compiling its whole dependency tree. Frames still come back with their embeddings, scenes and transcript windows, and `processing.warnings` carries `ocr unavailable: ... spawn tesseract ENOENT`; only text burned into the picture (and the WeChat Channels OCR path) is lost.

## License

MIT — see [LICENSE](LICENSE).

---

<sub>Keywords: MCP server, Model Context Protocol, video transcription, keyframe extraction, YouTube transcript, TikTok downloader, WeChat Channels 视频号, Whisper, SenseVoice, SigLIP, yt-dlp, scene detection, AI agent tools, video understanding, local ASR, TypeScript, Node.js</sub>
