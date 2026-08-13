# Observable Status Channel — Design

**Date:** 2026-08-13
**Status:** Approved, pending implementation
**Ships as:** 0.3.0 (0.2.0 remains a git-only version; npm's next publish is 0.3.0)
**Amends:** the task surface of `2026-08-12-tasks-and-batching-design.md`. Pipeline unchanged except one added progress seam (§4).

---

## 1. Why

Background tasks report a result once, at completion — deliberately, like a harness subagent. What's missing is the other half of that model: a way for an agent that *wants* to check on long-running work to do so, on any client, without the server ever pushing anything into its context.

The constraint that shapes everything: **the server reports observables, never verdicts.** A download silent for six minutes is a bug on bad wifi and routine for a huge video. Staleness is a judgment only the agent can make, by comparing two snapshots. Anything labeled `stale` in our output would be a guess; we don't emit one.

Second constraint, from the operator: **no per-stage file writes.** Status lives in memory, per server process. The only file is a discovery registry written at server start and removed at exit — O(server lifecycle), not O(stage transition).

## 2. The three consumers, one source

An in-memory **status registry** per server process (§3) feeds:

1. **A localhost HTTP endpoint** (§5) — `GET /status` returns the registry as JSON. Its URL is returned in task-mode replies, so an agent holding a task handle can check without bash.
2. **A CLI subcommand** (§6) — `video-extract status [--watch] [--json] [url...]` discovers every live server, merges their registries, renders one view.
3. The existing MCP `statusMessage` mechanism — unchanged, now just another reader of the same stage events.

"All videos independently of session" means **all live servers**: each MCP client spawns its own server process; the CLI merges across them via the discovery file. A server that exited takes its in-memory history with it — the accepted price of no persistent writes. Artifacts at `destinationPath` remain the durable record.

## 3. The registry

`src/status/registry.ts`, one instance per `buildServer()` (no module-level state — the established rule). Entries are per **item** (one video), keyed by a server-unique id, retaining:

- `url`, `tool` (`analyze` | `resolve`), `taskId` (when task-mode), `destinationPath` (the item's dir)
- `stageHistory`: `[{ stage, at }]` — appended at each transition; the current stage is the last entry
- `outcome`: absent while running; `{ status, at }` once the item resolves (honest per-item status, including failures)
- `childPid` + `childCommand`: the currently-running spawned process for this item (yt-dlp / ffmpeg / asrWorker / embedWorker), set when spawned, cleared when it exits
- `workDir`: the item's working directory, for the bytes observable

Population uses the seams that already exist: `onItemStart`, `onStage`, `onQueued`, plus item completion in the batch layer. `childPid` requires the process-spawn layer (`src/util/run.ts`) to accept an optional `onSpawn?: (pid, command) => void` callback, threaded down the same way `onStage` is — additive, no behavior change.

**Retention:** completed items are kept for the server's lifetime, capped as a ring of the most recent 500 items; the cap exists to bound memory, and when it evicts, the response says how many were evicted (no silent truncation).

## 4. One new stage: `downloading`

`AnalyzeStage` gains `'downloading'`, emitted by the resolver layer when media transfer genuinely begins (yt-dlp download start; direct/WeChat fetch start). Metadata-only resolves never emit it. This is the one pipeline touch: the operator's status view distinguishes "resolving" (cheap lookup) from "downloading" (the long part), and it is also where a future real download-percentage would attach. `resolveFrameMode` and existing seams are untouched; the stage flows through the existing `onStage` plumbing.

## 5. The HTTP endpoint

- Bound to `127.0.0.1` on an **ephemeral port**, started by `buildServer()`; the listener and its sockets are `unref`'d so the endpoint never holds the process open — the zombie-process class fixed in 0.2.0 must not return. A dedicated process-lifecycle test guards this.
- `GET /status` → `{ server: { pid, version, startedAt, uptimeSeconds, concurrencyCap, running, queued }, items: [...], evicted }`. Item entries carry the registry fields plus two request-time samples:
  - `workDirBytes`: total size of the item's working directory at this instant
  - `childCpuSeconds`: cumulative CPU of `childPid` at this instant (via `ps`; absent when no child or `ps` fails)
  Both are raw numbers. The agent polls twice and diffs; the server draws no conclusion.
- `?url=<u>` (repeatable) filters items by exact URL match — the operator's "send video urls together to get only those" ask.
- GET-only; any other method is 405. No auth: local-tool posture, and the endpoint exposes titles/URLs of videos being processed to local processes — stated in the README, accepted.
- **Discoverability:** task-mode replies carry `statusUrl`. The mechanism (result `_meta`, an added reply field, or the initial `statusMessage`) is settled by the plan against what the pinned SDK actually passes through — the requirement is only: an agent that receives a task handle can find the URL in that same reply, and every completed result includes it too.

## 6. The CLI

`video-extract status [--watch] [--json] [url...]`

- Reads the discovery file, health-checks each entry (`kill(pid, 0)` + a short-timeout GET), prunes dead entries opportunistically, merges live servers' items.
- Default render, one line per item — stages as a chain, age of the current stage, and the observables an agent (or human) needs to judge and to act:

```
https://…A  resolved → downloading → transcribed → frames → done   (2m ago)
https://…B  resolved → transcribing        45s in stage · asrWorker pid 4122 · cpu 38.2s
https://…D  resolved → downloading         6m in stage · yt-dlp pid 4210 · workdir 412 MB
https://…F  queued, 2 ahead
server pid 4098 · up 14m · cap 4 · running 2 · queued 1
```

- `--watch` re-renders every second (in-place). `--json` emits the merged endpoint payload for scripting. URL arguments filter.
- No `cancel` subcommand. Stopping is plain `kill`: killing an item's child makes that item fail honestly (`extractor_failed`) while the batch continues — this is existing pipeline behavior and gets an integration test; killing the server pid stops everything, files at `destinationPath` survive. The README's status section states both, in exactly those terms.

## 7. The discovery file

`~/.cache/video-extract-mcp/servers.json` — an array of `{ pid, port, startedAt, version }`.

- Written on server start (append/replace own entry, atomic write-rename), removed on clean shutdown (transport close / SIGINT / SIGTERM handlers, best-effort).
- Crashed servers leave stale entries; every reader treats the file as a hint, verifies liveness per entry, and prunes what's dead. Concurrent writers use the atomic rename; last-writer-wins is acceptable because readers re-verify everything anyway.
- This is the only file the feature ever writes, and never on a stage transition.

## 8. What this deliberately does not do

- **No verdicts**: no `stale`, no health scores, no fabricated percentages. Stage-based facts and request-time samples only. (Real download percentages by parsing yt-dlp progress: recorded in follow-ups, attaches at the `downloading` stage when done.)
- **No per-task abort machinery**: `kill` on exposed PIDs is the v1 stop story; the deferred process-tree cancellation item in follow-ups §H stays deferred.
- **No persistence of history**: dead server, gone registry — by design.
- **No new MCP tools**: the surface stays two tools; status is HTTP + CLI.

## 9. Docs and versioning

`analyze_video`/`resolve_video` descriptions gain one sentence each about `statusUrl` (a deliberate frozen-string amendment, dictated verbatim in the plan). README gains a "Watching progress" section: the CLI, the endpoint, the two-polls-and-diff pattern for judging slow-vs-stuck, and the kill semantics. `VIDEO_EXTRACT_STATUS_PORT` env var to pin the port (default ephemeral); `0` disables the endpoint entirely. Ships as 0.3.0; npm publish happens after this feature (0.2.0 is never published).

## 10. Testing

- Registry: unit tests per transition; eviction cap honest (evicted count surfaces).
- Endpoint: real `fetch` against a built server — shape, `?url=` filter, 405s, and the request-time samples present for a live child.
- Lifecycle: the process-exit test pattern from 0.2.0 (`mcpProcessLifecycle.test.ts`) extended — a server with the endpoint up and one completed call exits promptly after stdin EOF.
- Discovery: stale-entry pruning (fake dead pid), atomic write survivable by a concurrent reader.
- Kill semantics: integration — kill a mocked long-running child mid-item; the item lands `extractor_failed`, the sibling item completes, the batch result stays honest.
- Mutants that must die: endpoint holds the process open (unref dropped); registry writes a file per transition; `stale`-style verdict added to output (a grep-level guard in tests keeps the payload verdict-free); filter returning all items regardless of `?url=`.
