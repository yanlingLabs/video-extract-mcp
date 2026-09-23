# Installing video-extract-mcp

Give this file to your coding agent and it can install the server itself. There are four steps, in this order:

1. [Install the system programs](#1-system-programs) the server calls. They can't come from npm.
2. [Register the server](#2-register-the-server) with your agent.
3. [Raise the tool-call timeout](#3-raise-the-tool-call-timeout). A full analysis takes minutes, and many agents stop waiting after one.
4. [Check that it works](#4-check-that-it-works).

**Agents following this file:** don't guess a flag or a config key. If your harness isn't listed, run `<cli> mcp add --help` or read its own docs, and map the three values from [the portable part](#the-portable-part) onto what it asks for.

## 1. System programs

| Program | What it is for |
| --- | --- |
| Node ≥ 22.12 | Runs the server. |
| `ffmpeg` and `ffprobe` | Every video operation. `ffprobe` usually ships with `ffmpeg`; check that both are on `PATH`. |
| `yt-dlp` | Downloading from YouTube, TikTok, Instagram, X and most other sites. It has to be recent: platforms change often, and a months-old yt-dlp routinely fails on YouTube. |
| Deno | yt-dlp needs a JavaScript runtime to get past YouTube's challenges, and **Deno is the only one it uses by default**. Node doesn't count here: yt-dlp only uses Node when given a flag that this server does not pass. Without Deno, YouTube downloads fail or come back with missing formats. |
| `tesseract`, with `eng` and `chi_sim` | Reads on-screen text in keyframes; `chi_sim` is used alongside `eng` for Chinese, Cantonese, Japanese and Korean videos, including WeChat Channels. Without tesseract, frames still come back, and the reply says OCR was skipped. |

**Restart your agent after installing any of these.** An MCP server gets its `PATH` from the agent that launches it, so an agent that was already running won't see new programs.

### macOS

The tested platform: everything in the README's live results ran on Apple Silicon macOS with these packages.

```bash
brew install node ffmpeg yt-dlp tesseract tesseract-lang
```

Homebrew's `yt-dlp` depends on `deno`, so Deno comes along. `tesseract-lang` provides `chi_sim` and every other language.

### Windows

> **Not yet run on Windows.** These commands come from the package manifests, verified 2026-09-23, not from a Windows install of this server. Please report what happens (see [CONTRIBUTING.md](CONTRIBUTING.md)).

In PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
winget install yt-dlp.yt-dlp            # its manifest also installs Deno and an ffmpeg build with ffprobe
winget install tesseract-ocr.tesseract
```

Then open a **new** terminal, and:

- **If `deno --version` or `ffprobe -version` fails**, install them directly: `winget install DenoLand.Deno` and `winget install Gyan.FFmpeg`.
- **Put tesseract on `PATH`.** Its installer no longer does this:
  ```powershell
  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';C:\Program Files\Tesseract-OCR', 'User')
  ```
- **Add Chinese (`chi_sim`).** `winget install` doesn't select extra languages. Either rerun the tesseract installer by hand and tick *Additional language data (download) → Chinese (Simplified)*, or download the file into tesseract's folder from an **administrator** PowerShell:
  ```powershell
  Invoke-WebRequest https://github.com/tesseract-ocr/tessdata_fast/raw/main/chi_sim.traineddata -OutFile 'C:\Program Files\Tesseract-OCR\tessdata\chi_sim.traineddata'
  ```

Scoop and Chocolatey have all of these too: `ffmpeg`, `yt-dlp`, `tesseract` and `deno` in both. With Scoop, `scoop install tesseract-languages` adds every language.

**Signing in with browser cookies may not work on Windows.** Chrome's app-bound encryption is known to stop yt-dlp from reading Chrome's cookies, so if you use it, prefer Firefox as your default browser.

### Linux

> CI runs the full test suite on Ubuntu. No real downloads have been run on Linux yet.

Debian's and Ubuntu's own `yt-dlp` packages are too old for YouTube: the ones in bookworm, trixie and Ubuntu 24.04 all predate the JavaScript-runtime requirement. Use yt-dlp's own build instead.

**Debian / Ubuntu**

```bash
sudo apt install ffmpeg tesseract-ocr tesseract-ocr-chi-sim

# yt-dlp: the official standalone build (x86_64; on arm64 use yt-dlp_linux_aarch64)
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# Deno (no apt package); the script installs to ~/.deno/bin and offers to add it to PATH
curl -fsSL https://deno.land/install.sh | sh
```

**Fedora**

```bash
sudo dnf install ffmpeg-free tesseract tesseract-langpack-eng tesseract-langpack-chi_sim
curl -fsSL https://deno.land/install.sh | sh
```

Then install yt-dlp as for Debian above. Fedora's own `yt-dlp` package is recent, but it doesn't include the scripts yt-dlp runs in Deno, and nobody has checked whether it works on YouTube. `ffmpeg-free` includes `ffprobe`. RPM Fusion's `ffmpeg` also works.

Node ≥ 22.12 on either: your distribution's `nodejs` if it's new enough, otherwise [nodejs.org](https://nodejs.org) or a version manager such as `nvm`.

### Check them

```bash
node --version            # v22.12 or later
ffmpeg -version
ffprobe -version
yt-dlp --version          # a date; older than a few months is too old
deno --version
tesseract --list-langs    # should list eng and chi_sim
```

## 2. Register the server

### The portable part

Every MCP client needs the same three things. However your client spells them, this is what you are giving it:

| | value |
| --- | --- |
| transport | `stdio` |
| command | `npx` |
| args | `-y`, `@yanlinglabs/video-extract-mcp@latest` |
| env *(optional)* | `VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto` (see [cookies](#cookies)) |

**Keep `@latest`.** Without it, npx pins to the first version it cached and never updates.

**On Windows, if the client can't start `npx`**, use `cmd` as the command and `/c`, `npx`, `-y`, `@yanlinglabs/video-extract-mcp@latest` as the args. Kilo Code's docs say this is needed; for the other harnesses it is unverified.

### How each recipe was checked

Checked 2026-09-23. Harnesses change their MCP setup often, so if a command here fails, trust `--help` over this file.

| Harness | How it was checked |
| --- | --- |
| Claude Code | Used daily with this server. |
| Codex, Gemini CLI, Grok CLI | Command checked against each CLI's own `--help`. |
| Hermes Agent, OpenClaw, Kilo Code CLI | Command run; the harness connected to the live server and listed its three tools. |
| Pi (with pi-mcp-adapter), Cline CLI, DeepSeek Harness | Config written and read back by the harness; no tool call yet. |
| Kilo Code and Cline in VS Code | From their docs only. |

### `mcp add` is a common shape, not a standard

Most agent CLIs have an `mcp add` subcommand, but **the flags differ**. A command copied from one CLI to another often fails, or worse, quietly misreads its arguments.

| CLI | global scope | env var | how `npx`'s own args are passed |
| --- | --- | --- | --- |
| `claude` | `--scope user` | `-e K=V` | after `--` |
| `codex` | global by default | `--env K=V` | after `--` |
| `gemini` | `-s user` | `-e K=V` | positional, **no `--`** |
| `grok` | *(see `grok mcp add --help`)* | `-e K=V` | `--` before server flags |
| `hermes` | global | `--env K=V` | `--args …`, which must come **last** |
| `openclaw` | global | `--env K=V`, repeated | `--arg X`, once per arg |
| `kilo` | global | `--env K=V` | after `--` |
| `cline` | global | **none**; edit the JSON | after `--` |

The trap is `gemini`: `--` separates nothing there, and `-y` would be taken as a flag for `gemini` itself instead of reaching `npx`.

### Claude Code

```bash
claude mcp add --scope user video-extract \
  -e VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto \
  -- npx -y @yanlinglabs/video-extract-mcp@latest
```

### Codex

```bash
codex mcp add video-extract \
  --env VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto \
  -- npx -y @yanlinglabs/video-extract-mcp@latest
```

### Gemini CLI

Note there is no `--`:

```bash
gemini mcp add -s user -t stdio \
  -e VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto \
  video-extract npx -y @yanlinglabs/video-extract-mcp@latest
```

### Grok CLI

```bash
grok mcp add video-extract \
  -e VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto \
  npx -- -y @yanlinglabs/video-extract-mcp@latest
```

### opencode

`opencode mcp add` is interactive. Run it and give it the command and args from [the portable part](#the-portable-part).

### Hermes Agent (Nous Research)

```bash
hermes mcp add video-extract --command npx \
  --env VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto \
  --args -y @yanlinglabs/video-extract-mcp@latest
```

- **Keep `--args` last:** it takes everything after it.
- Hermes connects to the server, lists its three tools and asks whether to enable them; answer `Y`. It writes this to `~/.hermes/config.yaml`:
  ```yaml
  mcp_servers:
    video-extract:
      command: npx
      args: ['-y', '@yanlinglabs/video-extract-mcp@latest']
      env:
        VIDEO_EXTRACT_COOKIES_FROM_BROWSER: auto
      enabled: true
      timeout: 1800          # add this; see step 3
  ```
- **Hermes doesn't pass your shell's environment to the server**, only `PATH`, `HOME` and a few locale variables. Any `VIDEO_EXTRACT_*` setting has to go under `env:` there.
- If it says it "requires the 'mcp' Python SDK", reinstall Hermes with its `mcp` extra (`hermes-agent[mcp]`).
- Apply changes with `/reload-mcp` or a new session.

Docs: [hermes-agent.nousresearch.com › MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp).

### OpenClaw

```bash
openclaw mcp add video-extract --command npx \
  --arg -y --arg @yanlinglabs/video-extract-mcp@latest \
  --env VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto
```

- It starts the server once to check it before saving (`--no-probe` skips that).
- `openclaw mcp doctor video-extract --probe` checks it later.
- `openclaw mcp reload` applies changes.
- The entry lands in `~/.openclaw/openclaw.json` under `mcp.servers`.

Docs: [docs.openclaw.ai › MCP](https://docs.openclaw.ai/tools/mcp).

### Pi

Pi has no MCP support by design; its docs suggest an extension instead. [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) is the one listed on pi.dev. It is **third-party**, not part of Pi, and installs like any Pi package:

```bash
pi install npm:pi-mcp-adapter        # then restart pi
```

Then add the server to `~/.config/mcp/mcp.json`, or to `.mcp.json` in a project:

```json
{
  "mcpServers": {
    "video-extract": {
      "command": "npx",
      "args": ["-y", "@yanlinglabs/video-extract-mcp@latest"],
      "env": { "VIDEO_EXTRACT_COOKIES_FROM_BROWSER": "auto" },
      "requestTimeoutMs": 1800000
    }
  }
}
```

- The model sees one proxy `mcp` tool by default; `"directTools": true` on the server gives it the three tools directly.
- Servers start on first use.
- `/reload` applies changes.
- Pi's package is now `@earendil-works/pi-coding-agent`; `@mariozechner/pi-coding-agent` is deprecated.

### Kilo Code

The CLI:

```bash
kilo mcp add video-extract \
  --env VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto \
  -- npx -y @yanlinglabs/video-extract-mcp@latest
```

It writes `~/.config/kilo/kilo.jsonc`, in a shape unlike the other clients: the key is `mcp` rather than `mcpServers`, `command` is one array that includes the args, env goes under `environment`, and `type` is required:

```jsonc
{
  "mcp": {
    "video-extract": {
      "type": "local",
      "command": ["npx", "-y", "@yanlinglabs/video-extract-mcp@latest"],
      "environment": { "VIDEO_EXTRACT_COOKIES_FROM_BROWSER": "auto" },
      "timeout": 1800000
    }
  }
}
```

- The VS Code extension reads the same file, per Kilo's docs: *Settings → Agent Behaviour → MCP Servers*. Kilo versions before 7 used a separate `mcp_settings.json`.
- A project-level `kilo.json` or `.kilo/kilo.json` overrides the global file.
- On Windows the docs use `"command": ["cmd", "/c", "npx", "-y", "@yanlinglabs/video-extract-mcp@latest"]`.
- `kilo mcp list` should show `video-extract connected`.

Docs: [kilo.ai › MCP in the CLI](https://kilo.ai/docs/automate/mcp/using-in-cli).

### Cline

The CLI has no env flag, so add the server, then edit the file:

```bash
cline mcp add video-extract --yes -- npx -y @yanlinglabs/video-extract-mcp@latest
cline config mcp --json      # prints which settings file it uses
```

- **Don't trust the path in the docs.** They say `~/.cline/mcp.json`, but the 3.0 CLI used `~/.cline/data/settings/cline_mcp_settings.json`. `cline config mcp --json` shows the real one.
- In that file, the server's entry can take the usual shape:
  ```json
  {
    "mcpServers": {
      "video-extract": {
        "command": "npx",
        "args": ["-y", "@yanlinglabs/video-extract-mcp@latest"],
        "env": { "VIDEO_EXTRACT_COOKIES_FROM_BROWSER": "auto" },
        "timeout": 1800,
        "disabled": false
      }
    }
  }
  ```
- **In VS Code**, open the MCP Servers icon → *Configure* → *Configure MCP Servers*. It opens whichever file that build uses; add the same entry there.
- Cline's `timeout` is in **seconds**.

Docs: [docs.cline.bot › MCP](https://docs.cline.bot/mcp/mcp-overview).

### DeepSeek Harness (`dsh`)

DeepSeek's own [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is a developer preview and warns that it may change. It has no `mcp add`. You add a plugin entry to `~/.dsh/cordis.patch.yml`, which covers every profile (for one profile, use `~/.dsh/profiles/<name>/cordis.patch.yml`):

```yaml
- insert:
    - id: mcp-video-extract
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: video-extract
        transport: stdio
        command: npx
        args: ['-y', '@yanlinglabs/video-extract-mcp@latest']
        env:
          VIDEO_EXTRACT_COOKIES_FROM_BROWSER: auto
        toolCallTimeoutMs: 1800000
```

- `serverName` may only contain letters, digits, `_` and `-`, up to 32 characters.
- Restart dsh to apply the change.
- `dsh --dump-config` shows whether the entry was picked up.
- **Environment:** dsh drops any variable whose name contains `KEY`, `PASSWORD`, `SECRET` or `TOKEN` before starting the server. None of this server's variables do.

*Codewhale (formerly DeepSeek-TUI) is a separate, unaffiliated project.* It reads `~/.codewhale/mcp.json` in the `mcpServers` shape from [Any other client](#any-other-client). If you use `codewhale mcp add`, write `--arg=-y`, since plain `--arg -y` is rejected. Apply changes with `/mcp reload`.

### Any other client

If your client takes a JSON config (the usual case for editor extensions), this is the equivalent:

```json
{
  "mcpServers": {
    "video-extract": {
      "command": "npx",
      "args": ["-y", "@yanlinglabs/video-extract-mcp@latest"],
      "env": { "VIDEO_EXTRACT_COOKIES_FROM_BROWSER": "auto" }
    }
  }
}
```

Some clients name that key `servers` or `mcp` instead of `mcpServers`, or want the block inside a larger settings file; check your client's docs for the wrapper. The inner three fields are the same everywhere. If you get a client working that isn't listed here, please report what worked (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## 3. Raise the tool-call timeout

`resolve_video` answers in seconds, but `analyze_video` on a long video, or any call waiting for you to [sign in](#cookies) (up to 3 minutes), runs much longer than many harnesses wait by default. Set the timeout to about 30 minutes:

| Harness | Setting | Default |
| --- | --- | --- |
| DeepSeek Harness | `toolCallTimeoutMs` | 60 s |
| Pi (pi-mcp-adapter) | `requestTimeoutMs` | 60 s |
| Hermes Agent | `timeout` (seconds) | 300 s |
| Cline | `timeout` (seconds) | not documented |
| Kilo Code | `timeout` (ms) | the docs give both 5 s and 30 s |
| OpenClaw | `--timeout <seconds>` | not documented |

**If the harness gives up anyway, the work still finishes.** Call `get_status` with the same URL or path to collect the result.

## 4. Check that it works

```bash
claude mcp list     # or: codex / gemini / grok / hermes / openclaw / kilo mcp list
```

Then, from the agent, call `resolve_video` on any public video URL. It returns metadata in a second or two without downloading anything, which is the quickest proof the server is alive.

Three things that commonly go wrong:

- **The first launch can time out** while npx downloads the package (about 150 dependencies). Run `npx -y -p @yanlinglabs/video-extract-mcp@latest video-extract cookies` once by hand; it fills the cache and exits. Then check again.
- **A program from step 1 is "not found"** even though it works in your terminal: the agent was started before you installed it, or it doesn't pass your shell's `PATH`. Restart the agent; on Hermes, check the `PATH` it passes.
- **Don't run the npx form from inside this package's own git checkout.** npx resolves the name against the local `package.json`, looks for a binary in a `node_modules` that was never filled, and fails with `command not found`. MCP clients start servers in your project's folder, so this only affects contributors; see [CONTRIBUTING.md](CONTRIBUTING.md).

## What it gives you

Three tools:

- `resolve_video`: a video's metadata, and the file itself when you ask for it. Downloading is a complete use on its own.
- `analyze_video`: a transcript and the important keyframes.
- `get_status`: collects a result if your agent stopped waiting. The work finishes regardless.

Transcripts use the platform's captions when it has them. The speech-recognition models for videos without captions (233 MB to 1.3 GB) download themselves the first time one is needed; the README explains how to pre-fetch them or turn that off.

## Cookies

You don't need to configure anything for sign-ins. Both tools take `userCookies: true`, which means the user agreed, **for this one call**, to cookies from their default browser. The tool descriptions tell the agent to ask you first, every time. If you aren't signed in, a small local page opens in your browser, says which site needs a sign-in, and waits for you. Nothing to restart.

`VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto` is the standing alternative, and is optional:

- **It only acts on a refusal.** Ordinary requests send no cookies. Only when a platform refuses a request does the server retry that one request, once, with your default browser's cookies. YouTube and others rate-limit anonymous downloads, and signing in is the fix they ask for.
- **macOS asks for the Keychain** the first time it reads a Chrome-family browser. "Always Allow" stops it repeating.
- Without it, and without `userCookies`, a refusal comes back as `rate_limited` or `auth_required`, with a note suggesting `userCookies`.

See what the environment resolves to:

```bash
npx -y -p @yanlinglabs/video-extract-mcp@latest video-extract cookies
```
