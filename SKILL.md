# Installing video-extract-mcp in any agent

Give this file to your coding agent and it can install the server itself.

## The portable part

Every MCP client needs the same three things. However your client spells it, this is what you are giving it:

| | value |
| --- | --- |
| transport | `stdio` |
| command | `npx` |
| args | `-y`, `@yanlinglabs/video-extract-mcp@latest` |
| env *(optional)* | `VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto` |

**`@latest` is load-bearing.** Without it npx pins to the first version it cached and never updates again — measured: a bare spec kept serving 0.4.1 with 0.7.0 published, and went on doing so even after a newer copy was already in the npx cache.

Prerequisites, which cannot come from npm: `ffmpeg`, `yt-dlp`, `tesseract` (`brew install ffmpeg yt-dlp tesseract tesseract-lang`, or your platform's package manager). Node >= 26.

## `mcp add` is a common shape, not a standard

Most agent CLIs have grown an `mcp add` subcommand, so the *shape* usually rhymes — but **the flags genuinely differ**, and a command copied from one CLI to another often fails or, worse, silently mis-parses. Verified directly against each CLI's own `--help`:

| CLI | global scope | env var | command separator |
| --- | --- | --- | --- |
| `claude` | `--scope user` | `-e K=V` | `--` required |
| `codex` | global by default (no scope flag) | `--env K=V` | `--` required |
| `gemini` | `-s user` | `-e K=V` | **none** — command and args are positional |
| `grok` | *(see `grok mcp add --help`)* | `-e K=V` | `--` before server flags |

The trap is `gemini`: passing `--` there does not separate anything, and `-y` would be eaten as a flag to `gemini` itself rather than handed to `npx`.

## Verified recipes

Each of these was checked against the installed CLI's own help output.

**Claude Code**
```bash
claude mcp add --scope user video-extract \
  -e VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto \
  -- npx -y @yanlinglabs/video-extract-mcp@latest
```

**Codex**
```bash
codex mcp add video-extract \
  --env VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto \
  -- npx -y @yanlinglabs/video-extract-mcp@latest
```

**Gemini CLI** — note the missing `--`:
```bash
gemini mcp add -s user -t stdio \
  -e VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto \
  video-extract npx -y @yanlinglabs/video-extract-mcp@latest
```

**Grok CLI**
```bash
grok mcp add video-extract \
  -e VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto \
  npx -- -y @yanlinglabs/video-extract-mcp@latest
```

**opencode** — `opencode mcp add` is interactive; run it and supply the command and args from the table above.

## Any other client

If your client takes a JSON config (the common case for editor extensions), this is the equivalent:

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

Some clients name that key `servers` or `mcp` instead of `mcpServers`, and some want the block inside a larger settings file — check your client's own docs for the wrapper. The inner three fields are the same everywhere.

**If your CLI is not listed above, do not guess its flags.** Run `<your-cli> mcp add --help` and map the three values from the first table onto whatever it asks for. Reporting what worked is a genuinely useful contribution — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Verify it worked

```bash
# whichever your client provides:
claude mcp list        # or: codex mcp list / gemini mcp list / grok mcp list
```

Then, from the agent, call `resolve_video` on any public video URL — it returns metadata in a second or two without downloading anything, which is the cheapest possible proof the server is alive.

Two known gotchas:

- **Do not run the npx form from inside this package's own git checkout.** npx resolves the name against the local `package.json`, looks for a binary in a `node_modules` that was never populated, and exits `command not found`. Since MCP clients launch servers with the working directory set to your project, that affects contributors only — see [CONTRIBUTING.md](CONTRIBUTING.md).
- **A health check may fail on the very first launch** while npx downloads the package (~150 packages). Run the command once by hand to warm the cache, then re-check.

## About that cookies setting

`VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto` is optional and safe to omit. It is **lazy**: ordinary requests send no cookies at all, and a browser's cookies are borrowed only after a platform actually refuses a request — then that one request is retried, once.

It exists because YouTube and others rate-limit anonymous downloads, and signing in is the fix they themselves ask for. The first time it triggers, macOS/Linux will show a keychain prompt for Chrome-family browsers that must be approved. Leave it out and refusals simply come back as `rate_limited` with a suggestion attached.

Check what it resolved to at any time:

```bash
npx -y -p @yanlinglabs/video-extract-mcp@latest video-extract cookies
```
