# Security Policy

## Reporting a vulnerability

**Report privately through GitHub:** [open a draft security advisory](https://github.com/yanlingLabs/video-extract-mcp/security/advisories/new). Private vulnerability reporting is enabled on this repository, so the report stays between you and the maintainers until a fix ships.

Please do **not** open a public issue for a suspected vulnerability.

Useful things to include, roughly in order of value:

- what an attacker gains, and what they need to already control to get it
- a minimal reproduction — a URL, a tool call, an environment variable
- the version (`video-extract status`, or the `version` field on any `/status` reply) and your OS
- versions of `ffmpeg`, `yt-dlp` and `tesseract`, since much of the attack surface runs through them

**What to expect.** This is a small project with a small maintainer team, so these are honest targets rather than guarantees: an acknowledgement within **3 working days**, an initial assessment within **10 days**, and a fix released as soon as it is ready and verified. You will get a straight answer either way — including "this is intended behaviour, and here is why", which is a real outcome and not a brush-off. If you disagree with that call, say so; it has been wrong before.

Credit in the advisory and release notes unless you would rather stay anonymous.

## Supported versions

Pre-1.0, so the honest answer is short: **only the latest published version receives security fixes.**

| Version | Supported |
| --- | --- |
| latest `0.x` | ✅ |
| any earlier `0.x` | ❌ — upgrade |

There are no long-term support branches, and no backports. If you are pinned to an older version and cannot upgrade, say so in your report and it can be discussed.

## What this tool actually does

Most of the risk here is not in this codebase's own logic. It is in what the tool is *for*: fetching arbitrary media from arbitrary places, handing it to large native binaries, and returning the result to an automated agent. Worth knowing before you assess anything:

- **It executes external binaries** — `yt-dlp`, `ffmpeg`/`ffprobe`, `tesseract` — with URLs and paths you supply. They are spawned with **argument arrays, never through a shell** (`spawn(cmd, args)`, no `shell: true` anywhere), so there is no shell-metacharacter interpolation. A report showing that a crafted URL or path escapes that boundary is squarely in scope and will be treated as serious.
- **It downloads and decodes untrusted media.** The bytes come from the internet and go into ffmpeg and tesseract. This project does not execute downloaded content, but it does feed it to parsers with long CVE histories — see *Out of scope* below.
- **It writes to a caller-chosen `destinationPath`**, and to a cache directory. It never deletes a finished artifact — manifests, transcripts, frames and completed videos all stay. It *does* delete one narrow class of file: its own abandoned partial downloads, matched on the `source.*` names it downloads under and only once they are more than six hours old. A case where it removes a file it did not create, or a completed one, is a real bug. So are writes outside those two locations.
- **It runs a localhost HTTP status endpoint** — see below.
- **It reads a WeChat session cookie** from `VIDEO_EXTRACT_WECHAT_COOKIE` when resolving WeChat Channels links. The value is read from the environment and sent to Tencent's endpoints; it is never logged and never written to disk.

## For agent integrators — the surface that is easy to miss

This is an MCP server, so its output usually lands directly in an AI agent's context. Two consequences worth designing around:

**Transcripts and OCR text are attacker-controlled content.** If someone can get your agent to analyze a video they control, they choose the words in that transcript and the text painted on those frames. That text arrives in your agent's context looking exactly like tool output. Treat it as untrusted data, never as instructions — the same way you would treat the body of a fetched web page. This is not a flaw in the tool; it is what a transcript *is*. But an integration that pipes transcripts into a prompt without that framing has a prompt-injection problem, and it is worth saying plainly.

**A URL is an instruction to make a network request from your machine.** `resolve_video` and `analyze_video` will fetch what they are pointed at. If an agent takes URLs from untrusted input, it can be induced to make requests to hosts of the attacker's choosing, including on your local network. Constrain the URLs your agent is allowed to pass if that matters in your deployment.

## The status endpoint, stated plainly

The `/status` endpoint binds to **`127.0.0.1` only** and has **no authentication**. It exposes, for each item: the URL being processed, the `destinationPath`, stage history and timestamps, the task id, and the server's pid and version.

On a single-user machine that is observability. **On a shared or multi-user host, any local user can read which videos you are processing and where the output goes.** That is a deliberate trade for a debugging channel, not an oversight — but if it is wrong for your environment, disable it:

```bash
VIDEO_EXTRACT_STATUS_PORT=0   # disables the endpoint entirely
```

A report that the endpoint is reachable from **off** the host, or that it discloses something not listed above (credentials, cookie values, environment contents), is a real vulnerability. Local-user visibility of the fields listed above is documented behaviour.

## In scope

- Escaping the argument-array boundary into shell execution
- Path traversal or writes outside `destinationPath` and the cache directory
- Leaking `VIDEO_EXTRACT_WECHAT_COOKIE`, environment variables, or file contents into any output, log, manifest, or the status endpoint
- The status endpoint binding beyond loopback, or disclosing fields not documented above
- A crafted URL or media file causing this project's own code to execute attacker-controlled code
- Dependency vulnerabilities that are genuinely reachable through this tool's use of them — please say *how* they are reached

## Out of scope

- **Vulnerabilities in `ffmpeg`, `yt-dlp`, or `tesseract` themselves.** Report those upstream; they have their own security processes. Keep them updated — they are the largest parser surface here and this project deliberately does not vendor them. If our *invocation* of one turns an upstream issue into an exploit that would not otherwise be reachable, that part is in scope.
- Anything requiring an attacker who already controls the machine, the environment variables, or the MCP client.
- The tool fetching a URL it was asked to fetch, or writing to a `destinationPath` it was given. Both are the caller's decision by design.
- Local-user visibility of the documented `/status` fields (see above).
- Findings from automated scanners with no demonstrated impact. A report needs a path to harm, not a severity label.

## Disclosure

Coordinated disclosure, please. Give a fix a reasonable window before publishing — **90 days** is the default expectation, and shorter is fine by mutual agreement once a fix is out. If a vulnerability is already being exploited, say so up front and the timeline compresses accordingly.

Fixes ship as a new patch release, with a GitHub Security Advisory describing the issue, affected versions, and the upgrade path.

## Safe harbour

Good-faith security research on your own installation is welcome and will not be met with legal action. That means: test against your own machine and your own accounts, do not access other people's data, do not degrade anyone else's service, and give the project a chance to fix things before going public. Testing against third-party platforms this tool can reach — YouTube, TikTok, WeChat and the rest — is between you and them, and their terms apply.
