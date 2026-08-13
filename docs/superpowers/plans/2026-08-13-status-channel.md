# Observable Status Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-server in-memory status registry exposed through a localhost `GET /status` endpoint and a `video-extract status` CLI that merges all live servers — raw observables only, never verdicts — shipping as 0.3.0.

**Architecture:** An `AsyncLocalStorage` context established at the agent layer carries per-item reporting callbacks down to `src/util/run.ts` (child PID + command) and the three resolver download sites (the new `'downloading'` stage) — one context site, four read sites, no callback threading through the 8 modules that call `run()`. Each `buildServer()` owns a registry and an unref'd HTTP listener; the CLI discovers servers via a liveness-verified `~/.cache` file and merges their endpoint payloads.

**Tech Stack:** Node built-ins only (`async_hooks`, `http`, `fs`, `child_process`); no new dependencies. SDK stays pinned at exactly 1.30.0.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-13-status-channel-design.md`, cited as §N.
- **Observables, never verdicts** (§1/§5): no `stale`, no health scores, no fabricated percentages anywhere in payloads, CLI output, or docs examples. A test greps the endpoint payload for verdict words (§10).
- **No per-stage file writes** (§1/§7): the discovery file is written at server start and removed at exit — nothing else touches disk on a stage transition. A mutant that writes a file per transition must die.
- The endpoint must never hold the process open: listener and sockets unref'd; the 0.2.0 zombie-process class must not return (§5). Lifecycle test mandatory.
- Per-server state only — no module-level mutable registries (`AsyncLocalStorage` is context propagation, not shared mutable state, and is the one sanctioned module-level instance).
- No new MCP tools; the two tool descriptions gain exactly the Task 7-dictated sentence each and nothing else changes in the frozen strings.
- No Python. Node 26, ESM, strict TS with `noUncheckedIndexedAccess`. `src/types.ts` single source of truth. Version 0.3.0 in Task 7 only.
- Gates every task: `npm test` green (496 baseline), `npm run typecheck` clean. `npx vitest run` does not build — `npm run build` first when a touched test imports `dist/`.
- Never write personal identity strings anywhere, including scan commands (active pre-commit name-guard; phrase checks as "the name-guard's patterns"). Do not commit `.superpowers/`, `experiments/`, `models/`, `scratch/`.

## File Structure

- Create `src/status/registry.ts` — the in-memory registry (per-server instance; ring cap 500 with honest `evicted` count).
- Create `src/status/context.ts` — the `AsyncLocalStorage` carrying `{ onStage?, onSpawn? }`.
- Create `src/status/endpoint.ts` — unref'd localhost HTTP server + request-time samples (`workDirBytes`, `childCpuSeconds`) + `statusPortFromEnv()`.
- Create `src/status/discovery.ts` — the `~/.cache/video-extract-mcp/servers.json` writer/reader/pruner.
- Create `src/status/statusCli.ts` — the `status` subcommand (merge, render, `--watch`, `--json`, url filters).
- Modify `src/types.ts` (AnalyzeStage + `'downloading'`), `src/util/run.ts` (context read), `src/resolve/ytdlp.ts` + `src/resolve/direct.ts` + `src/resolve/wechat.ts` (one `'downloading'` emit each), `src/agent/analyzeTool.ts` + `src/agent/resolveTool.ts` (context establishment + `onSpawn` hook), `src/mcp.ts` (registry + endpoint wiring, statusUrl), `src/cli.ts` (subcommand dispatch), `package.json`, `README.md`, `CLAUDE.md`, `docs/follow-ups.md`.
- Tests: `tests/statusRegistry.test.ts`, `tests/statusContext.test.ts`, `tests/statusEndpoint.test.ts`, `tests/statusDiscovery.test.ts`, `tests/statusCli.test.ts`, `tests/statusKill.integration.test.ts`, additions to `tests/mcp.test.ts` and `tests/mcpProcessLifecycle.test.ts`.

---

### Task 1: The registry and the `'downloading'` stage type

**Files:**
- Create: `src/status/registry.ts`
- Modify: `src/types.ts` (one union member)
- Test: `tests/statusRegistry.test.ts`

**Interfaces:**
- Consumes: `AnalyzeStage` from `src/types.ts`.
- Produces (Tasks 2/3/4/6 rely on these exactly):

```ts
export interface StatusItem {
  id: number;                       // server-unique, monotonically increasing
  url: string;
  tool: 'analyze' | 'resolve';
  taskId?: string;
  destinationPath: string;
  stageHistory: Array<{ stage: string; at: number }>;   // epoch ms; last entry = current stage
  outcome?: { status: string; at: number };             // absent while running
  childPid?: number;
  childCommand?: string;
}
export interface StatusRegistry {
  register(item: { url: string; tool: 'analyze' | 'resolve'; destinationPath: string; taskId?: string }): number; // returns id
  stage(id: number, stage: string): void;               // appends {stage, now}
  spawn(id: number, pid: number, command: string): void;
  spawnEnded(id: number): void;                          // clears childPid/childCommand
  finish(id: number, status: string): void;              // sets outcome
  snapshot(urls?: string[]): { items: StatusItem[]; evicted: number };  // deep-copied; urls = exact-match filter
}
export function createStatusRegistry(cap?: number): StatusRegistry;    // cap default 500
```

- [ ] **Step 1: Add the stage.** In `src/types.ts:167` extend the union: `export type AnalyzeStage = 'resolving' | 'downloading' | 'transcribing' | 'frames';` and extend the doc comment above it with: `'downloading' fires when media transfer genuinely begins (never on a metadata-only resolve); it is emitted from the resolver layer via the status context (src/status/context.ts), so it reaches agent-layer hooks but not a bare library caller's opts.onStage.` Run `npm run typecheck` — expect clean (the union only widened).

- [ ] **Step 2: Write the failing tests**

```ts
// tests/statusRegistry.test.ts
import { describe, it, expect } from 'vitest';
import { createStatusRegistry } from '../src/status/registry.js';

describe('createStatusRegistry', () => {
  it('records a full item lifecycle with timestamped stage history', () => {
    const r = createStatusRegistry();
    const id = r.register({ url: 'https://x.test/a', tool: 'analyze', destinationPath: '/out' });
    r.stage(id, 'resolving'); r.stage(id, 'downloading');
    r.spawn(id, 4122, 'yt-dlp'); r.spawnEnded(id);
    r.stage(id, 'frames'); r.finish(id, 'ok');
    const { items, evicted } = r.snapshot();
    expect(evicted).toBe(0);
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    expect(it0.stageHistory.map((s) => s.stage)).toEqual(['resolving', 'downloading', 'frames']);
    expect(it0.stageHistory.every((s) => Number.isFinite(s.at))).toBe(true);
    expect(it0.childPid).toBeUndefined();           // cleared by spawnEnded
    expect(it0.outcome).toMatchObject({ status: 'ok' });
  });

  it('keeps the live child pid+command visible while a spawn is active', () => {
    const r = createStatusRegistry();
    const id = r.register({ url: 'u', tool: 'resolve', destinationPath: '/d' });
    r.spawn(id, 999, 'ffmpeg');
    expect(r.snapshot().items[0]).toMatchObject({ childPid: 999, childCommand: 'ffmpeg' });
  });

  it('snapshot(urls) filters by exact url match', () => {
    const r = createStatusRegistry();
    r.register({ url: 'https://a', tool: 'analyze', destinationPath: '/d' });
    r.register({ url: 'https://b', tool: 'analyze', destinationPath: '/d' });
    expect(r.snapshot(['https://b']).items.map((i) => i.url)).toEqual(['https://b']);
    expect(r.snapshot([]).items).toHaveLength(2);   // empty filter = no filter
  });

  it('evicts oldest COMPLETED items past the cap and reports the count honestly', () => {
    const r = createStatusRegistry(3);
    const ids = [1, 2, 3, 4].map((n) => r.register({ url: `u${n}`, tool: 'analyze', destinationPath: '/d' }));
    ids.forEach((id) => r.finish(id, 'ok'));
    const { items, evicted } = r.snapshot();
    expect(items.map((i) => i.url)).toEqual(['u2', 'u3', 'u4']);   // oldest evicted
    expect(evicted).toBe(1);                                       // no silent truncation
  });

  it('never evicts a RUNNING item, even past the cap', () => {
    const r = createStatusRegistry(2);
    const a = r.register({ url: 'running', tool: 'analyze', destinationPath: '/d' });   // never finished
    const rest = [1, 2, 3].map((n) => r.register({ url: `done${n}`, tool: 'analyze', destinationPath: '/d' }));
    rest.forEach((id) => r.finish(id, 'ok'));
    const { items } = r.snapshot();
    expect(items.some((i) => i.url === 'running')).toBe(true);
    void a;
  });

  it('snapshot returns copies -- mutating the result does not corrupt the registry', () => {
    const r = createStatusRegistry();
    const id = r.register({ url: 'u', tool: 'analyze', destinationPath: '/d' });
    r.stage(id, 'resolving');
    r.snapshot().items[0]!.stageHistory.push({ stage: 'FORGED', at: 0 });
    expect(r.snapshot().items[0]!.stageHistory.map((s) => s.stage)).toEqual(['resolving']);
  });
});
```

- [ ] **Step 3: Verify failure** — `npx vitest run tests/statusRegistry.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement**

```ts
// src/status/registry.ts
/** Spec §3: per-server in-memory status. NOTHING here touches the
 *  filesystem -- status is observable via the endpoint/CLI, and the only
 *  file the whole feature writes is the discovery registry (§7). */
export interface StatusItem { /* exactly as in Interfaces above */ }
export interface StatusRegistry { /* exactly as in Interfaces above */ }

export function createStatusRegistry(cap = 500): StatusRegistry {
  const items: StatusItem[] = [];
  let nextId = 1;
  let evicted = 0;
  const byId = (id: number) => items.find((i) => i.id === id);
  const enforceCap = () => {
    // Evict oldest COMPLETED first; a running item is never dropped (§3) --
    // dropping it would make a live child invisible to the kill workflow.
    while (items.length > cap) {
      const idx = items.findIndex((i) => i.outcome !== undefined);
      if (idx === -1) break;
      items.splice(idx, 1);
      evicted++;
    }
  };
  return {
    register(item) {
      const id = nextId++;
      items.push({ id, stageHistory: [], ...item });
      enforceCap();
      return id;
    },
    stage(id, stage) { byId(id)?.stageHistory.push({ stage, at: Date.now() }); },
    spawn(id, pid, command) { const i = byId(id); if (i) { i.childPid = pid; i.childCommand = command; } },
    spawnEnded(id) { const i = byId(id); if (i) { delete i.childPid; delete i.childCommand; } },
    finish(id, status) { const i = byId(id); if (i) i.outcome = { status, at: Date.now() }; enforceCap(); },
    snapshot(urls) {
      const filtered = urls && urls.length > 0 ? items.filter((i) => urls.includes(i.url)) : items;
      return { items: structuredClone(filtered), evicted };
    },
  };
}
```

- [ ] **Step 5: Green + mutation** — tests pass. Mutate: make `enforceCap` also evict running items — the never-evicts-running test must fail. Make `snapshot` return the live arrays — the copies test must fail. Restore both.

- [ ] **Step 6: Commit** — `git add src/status/registry.ts src/types.ts tests/statusRegistry.test.ts && git commit -m "feat: in-memory status registry and the downloading stage"`

---

### Task 2: The status context — spawn reporting and the `'downloading'` emits

**Files:**
- Create: `src/status/context.ts`
- Modify: `src/util/run.ts`, `src/resolve/ytdlp.ts`, `src/resolve/direct.ts`, `src/resolve/wechat.ts`, `src/agent/analyzeTool.ts`, `src/agent/resolveTool.ts`
- Test: `tests/statusContext.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (the context is callback-shaped; the MCP layer connects it to the registry in Task 4).
- Produces:

```ts
// src/status/context.ts
export interface StatusCallbacks {
  onStage?: (stage: string) => void;
  onSpawn?: (pid: number, command: string) => void;
  onSpawnEnded?: () => void;
}
export function runWithStatus<T>(cb: StatusCallbacks, fn: () => Promise<T>): Promise<T>;
export function statusCallbacks(): StatusCallbacks | undefined;   // current context, if any
```

- `AnalyzeRunHooks` (in `src/agent/analyzeTool.ts`) gains `onSpawn?: (itemIndex: number, pid: number, command: string) => void; onSpawnEnded?: (itemIndex: number) => void;`. `resolveVideoTool` gains an optional second parameter `hooks?: { onStage?: (itemIndex: number, stage: string) => void; onSpawn?: (itemIndex: number, pid: number, command: string) => void; onSpawnEnded?: (itemIndex: number) => void }` (resolve has no pool, so no `run`/`onQueued`).

**Why a context instead of threading:** `run()` is called from 8 modules (`resolve/direct`, `resolve/ytdlp`, `transcript/asr`, `vision/ocr`, `vision/embed`, `primitives`, `media/scenes`, `media/ffmpeg`); threading a callback through every signature would be an invasive, error-prone change. One `AsyncLocalStorage` established around each item's execution reaches all of them. This is the plan-level refinement of spec §3's "threaded the same way onStage is" — record it as such in the task report.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/statusContext.test.ts
import { describe, it, expect } from 'vitest';
import { runWithStatus, statusCallbacks } from '../src/status/context.js';
import { run } from '../src/util/run.js';

describe('status context', () => {
  it('run() reports spawn pid+command to the ambient context, then reports the end', async () => {
    const events: Array<[string, unknown]> = [];
    await runWithStatus(
      {
        onSpawn: (pid, cmd) => events.push(['spawn', { pid, cmd }]),
        onSpawnEnded: () => events.push(['ended', null]),
      },
      () => run('node', ['-e', 'setTimeout(() => {}, 50)']),
    );
    expect(events.map(([k]) => k)).toEqual(['spawn', 'ended']);
    const spawn = events[0]![1] as { pid: number; cmd: string };
    expect(spawn.cmd).toBe('node');
    expect(Number.isInteger(spawn.pid)).toBe(true);
    expect(spawn.pid).toBeGreaterThan(0);
  });

  it('run() outside any context behaves exactly as before (no context, no crash)', async () => {
    const r = await run('node', ['-e', 'process.exit(0)']);
    expect(r.code).toBe(0);
    expect(statusCallbacks()).toBeUndefined();
  });

  it('contexts do not leak across concurrent executions', async () => {
    const a: string[] = []; const b: string[] = [];
    await Promise.all([
      runWithStatus({ onSpawn: (_p, c) => a.push(c) }, () => run('node', ['-e', 'setTimeout(() => {}, 30)'])),
      runWithStatus({ onSpawn: (_p, c) => b.push(c) }, () => run('node', ['-e', 'setTimeout(() => {}, 30)'])),
    ]);
    expect(a).toEqual(['node']);   // exactly one spawn seen by each context
    expect(b).toEqual(['node']);
  });

  it('a throwing onSpawn callback does not break run()', async () => {
    const r = await runWithStatus(
      { onSpawn: () => { throw new Error('reporting must never break work'); } },
      () => run('node', ['-e', 'process.exit(0)']),
    );
    expect(r.code).toBe(0);
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/statusContext.test.ts` → FAIL.

- [ ] **Step 3: Implement.**

```ts
// src/status/context.ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface StatusCallbacks { /* as in Interfaces */ }

/** The one sanctioned module-level instance in the status feature: an
 *  AsyncLocalStorage is context PROPAGATION, not shared mutable state --
 *  each runWithStatus() call sees only its own store. Established at the
 *  agent layer around one item's execution; read by src/util/run.ts and
 *  the three resolver download sites, which is what lets spawn/download
 *  reporting reach 8 run()-calling modules with zero signature changes. */
const als = new AsyncLocalStorage<StatusCallbacks>();

export function runWithStatus<T>(cb: StatusCallbacks, fn: () => Promise<T>): Promise<T> {
  return als.run(cb, fn);
}
export function statusCallbacks(): StatusCallbacks | undefined {
  return als.getStore();
}
```

In `src/util/run.ts`, inside the Promise executor after `spawn(...)`:

```ts
    const status = statusCallbacks();
    if (status?.onSpawn && typeof child.pid === 'number') {
      try { status.onSpawn(child.pid, cmd); } catch { /* reporting never breaks work */ }
    }
```

and in the `close` handler (before `resolve`): `try { status?.onSpawnEnded?.(); } catch { /* ditto */ }`. (`error` handler too — a spawn that errored still ends.)

In each resolver, ONE emit where media transfer genuinely begins (§4 — never on metadata-only):
- `src/resolve/ytdlp.ts`: immediately before the `run('yt-dlp', [...args, url], ...)` call at ~:249, gated: `if (wantsDownload) statusCallbacks()?.onStage?.('downloading');`
- `src/resolve/direct.ts`: immediately before its media `fetchToFile`/download call, inside the branch where a real transfer happens (returnVideo-gated — read the file, find the transfer branch).
- `src/resolve/wechat.ts`: immediately before its media download call (stage-3 fetch), same gating.
Each is one line plus the import.

In `src/agent/analyzeTool.ts`: `analyzeVideoTool`'s per-item execution wraps the item in the context, bridging to indexed hooks (place inside the existing `exec(...)` fn, wrapping the `analyzeOneVideo` call):

```ts
      () => {
        hooks?.onItemStart?.(i);
        return runWithStatus(
          {
            onStage: (s) => hooks?.onStage?.(i, s as AnalyzeStage),
            onSpawn: (pid, cmd) => hooks?.onSpawn?.(i, pid, cmd),
            onSpawnEnded: () => hooks?.onSpawnEnded?.(i),
          },
          () => analyzeOneVideo(item, itemDir(args.destinationPath, i, n), (s) => hooks?.onStage?.(i, s)),
        );
      },
```

In `src/agent/resolveTool.ts`: `resolveVideoTool(args, hooks?)` wraps each `resolveOneVideo` call the same way (no pool). Existing callers pass no hooks — no behavior change.

- [ ] **Step 4: Green + suite** — `npm run build && npx vitest run tests/statusContext.test.ts` → PASS; full `npm test` green (the resolver emits are inert without a context; existing onStage tests must be unaffected — if any asserts an exact stage list for a DOWNLOADING path, it cannot exist yet since no context is established in those tests).

- [ ] **Step 5: Mutation** — remove the `onSpawnEnded` call from run()'s close handler — the lifecycle test's `['spawn','ended']` assertion fails. Remove the try/catch around `onSpawn` — the throwing-callback test fails. Restore both.

- [ ] **Step 6: Commit** — `git add src/status/context.ts src/util/run.ts src/resolve src/agent tests/statusContext.test.ts && git commit -m "feat: status context carries spawn and download reporting to the agent layer"`

---

### Task 3: The HTTP endpoint

**Files:**
- Create: `src/status/endpoint.ts`
- Test: `tests/statusEndpoint.test.ts`

**Interfaces:**
- Consumes: `StatusRegistry`, `StatusItem` (Task 1).
- Produces:

```ts
export interface StatusEndpoint { url: Promise<string | null>; close(): void; }
/** port: number to pin, 0 for ephemeral, null for disabled (never listens). */
export function startStatusEndpoint(
  registry: StatusRegistry,
  server: { pid: number; version: string; startedAt: number; concurrency: () => { cap: number; running: number; queued: number } },
  port: number | null,
): StatusEndpoint;
export function statusPortFromEnv(): number | null;   // VIDEO_EXTRACT_STATUS_PORT: unset -> 0 (ephemeral); '0' -> null (disabled); int>0 -> pin; garbage -> 0
```

Payload shape (Task 4/6 rely on it): `{ server: { pid, version, startedAt, uptimeSeconds, concurrencyCap, running, queued }, items: [...StatusItem plus workDirBytes?, childCpuSeconds?], evicted }`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/statusEndpoint.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStatusRegistry } from '../src/status/registry.js';
import { startStatusEndpoint, statusPortFromEnv } from '../src/status/endpoint.js';

const serverInfo = () => ({ pid: process.pid, version: '0.3.0', startedAt: Date.now(), concurrency: () => ({ cap: 4, running: 1, queued: 2 }) });
const open: Array<{ close(): void }> = [];
afterEach(() => { open.splice(0).forEach((e) => e.close()); vi.unstubAllEnvs(); });

describe('status endpoint', () => {
  it('serves the registry with server info and request-time samples', async () => {
    const reg = createStatusRegistry();
    const dir = mkdtempSync(join(tmpdir(), 'vem-status-'));
    writeFileSync(join(dir, 'blob.bin'), Buffer.alloc(2048));
    const id = reg.register({ url: 'https://x/a', tool: 'analyze', destinationPath: dir });
    reg.stage(id, 'downloading');
    reg.spawn(id, process.pid, 'node');            // a real, live pid -> cpu sample must work
    const ep = startStatusEndpoint(reg, serverInfo(), 0); open.push(ep);
    const url = await ep.url;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/status$/);
    const body = await (await fetch(url!)).json() as Record<string, unknown>;
    const server = body.server as Record<string, unknown>;
    expect(server.pid).toBe(process.pid);
    expect(server.concurrencyCap).toBe(4);
    const item = (body.items as Array<Record<string, unknown>>)[0]!;
    expect(item.workDirBytes).toBeGreaterThanOrEqual(2048);
    expect(typeof item.childCpuSeconds).toBe('number');   // live pid sampled via ps
  });

  it('?url= filters to exact matches and is repeatable', async () => {
    const reg = createStatusRegistry();
    reg.register({ url: 'https://x/a', tool: 'analyze', destinationPath: '/nonexistent' });
    reg.register({ url: 'https://x/b', tool: 'analyze', destinationPath: '/nonexistent' });
    const ep = startStatusEndpoint(reg, serverInfo(), 0); open.push(ep);
    const base = (await ep.url)!;
    const one = await (await fetch(`${base}?url=${encodeURIComponent('https://x/b')}`)).json() as { items: Array<{ url: string }> };
    expect(one.items.map((i) => i.url)).toEqual(['https://x/b']);
    // Repeatable: two url params select both items (URLSearchParams.getAll).
    const both = await (await fetch(`${base}?url=${encodeURIComponent('https://x/a')}&url=${encodeURIComponent('https://x/b')}`)).json() as { items: Array<{ url: string }> };
    expect(both.items.map((i) => i.url).sort()).toEqual(['https://x/a', 'https://x/b']);
  });

  it('rejects non-GET with 405 and unknown paths with 404', async () => {
    const ep = startStatusEndpoint(createStatusRegistry(), serverInfo(), 0); open.push(ep);
    const base = (await ep.url)!;
    expect((await fetch(base, { method: 'POST' })).status).toBe(405);
    expect((await fetch(base.replace('/status', '/other'))).status).toBe(404);
  });

  it('the payload never contains verdict words (spec §10 guard)', async () => {
    const reg = createStatusRegistry();
    const id = reg.register({ url: 'https://x/a', tool: 'analyze', destinationPath: '/nonexistent' });
    reg.stage(id, 'downloading');
    const ep = startStatusEndpoint(reg, serverInfo(), 0); open.push(ep);
    const text = await (await fetch((await ep.url)!)).text();
    // The server reports observables; 'stale'/'stuck'/'healthy'/'percent'
    // are judgments that belong to the agent (§1). If a legitimate field
    // name ever collides with this list, rename the field, not the test.
    expect(text.toLowerCase()).not.toMatch(/stale|stuck|healthy|percent/);
  });

  it('disabled (port null) never listens and resolves url to null', async () => {
    const ep = startStatusEndpoint(createStatusRegistry(), serverInfo(), null); open.push(ep);
    expect(await ep.url).toBeNull();
  });

  it('a pinned port already in use degrades to null, never throws', async () => {
    const first = startStatusEndpoint(createStatusRegistry(), serverInfo(), 0); open.push(first);
    const firstUrl = await first.url;
    const pinned = Number(new URL(firstUrl!).port);
    const second = startStatusEndpoint(createStatusRegistry(), serverInfo(), pinned); open.push(second);
    expect(await second.url).toBeNull();          // EADDRINUSE absorbed; server still works
  });

  it('statusPortFromEnv: unset->0, "0"->null, int->pin, garbage->0', () => {
    vi.stubEnv('VIDEO_EXTRACT_STATUS_PORT', '');
    expect(statusPortFromEnv()).toBe(0);
    vi.stubEnv('VIDEO_EXTRACT_STATUS_PORT', '0');
    expect(statusPortFromEnv()).toBeNull();
    vi.stubEnv('VIDEO_EXTRACT_STATUS_PORT', '52341');
    expect(statusPortFromEnv()).toBe(52341);
    vi.stubEnv('VIDEO_EXTRACT_STATUS_PORT', 'auto');
    expect(statusPortFromEnv()).toBe(0);
  });
});
```

- [ ] **Step 2: Verify failure**, then **Step 3: Implement.** Key requirements the code must honor (write it; the tests above define the contract):

- `http.createServer` bound to `'127.0.0.1'`; after `listen`, call `srv.unref()` AND `srv.on('connection', (s) => s.unref())` — the listener must never hold the process open (§5; the 0.2.0 zombie lesson). `close()` destroys open sockets.
- `url` is a Promise resolved on `'listening'` (ephemeral port known only then), `null` on `'error'` (EADDRINUSE degrades, one-shot — no retry, no throw) or when `port === null`.
- Samples computed per request, best-effort, absent on failure:
  - `workDirBytes`: recursive size of `destinationPath` via `readdirSync(..., { withFileTypes: true, recursive: true })` + `statSync` per file, wrapped in try/catch (directory may not exist yet). This is the plan-level resolution of spec §3's "workDir" field: for URL sources the pipeline's working directory IS `destinationPath` (outDir), and for local sources the internal mkdtemp is not known at the agent layer — `destinationPath` is the observable we own for every item, and it is where downloads and frames accumulate. Record this refinement in the task report.
  - `childCpuSeconds`: only when `childPid` set — `spawnSync('ps', ['-o', 'cputime=', '-p', String(pid)])`, parse `[[dd-]hh:]mm:ss` to seconds; absent if `ps` fails or pid is gone. Portable across darwin/linux.
- Response: `content-type: application/json`, no CORS headers (same-machine tooling), GET `/status` only.
- `statusPortFromEnv`: mirror the `intFromEnv` style in `src/agent/slots.ts` but with the distinct semantics in the Interfaces block ('0' means DISABLED here — document the deliberate contrast with `VIDEO_EXTRACT_TASK_TTL_MS=0` meaning no-expiry).

- [ ] **Step 4: Green + suite.**

- [ ] **Step 5: Mutation** — (a) drop both `unref` calls: no test in THIS file catches it (the process-exit test lands in Task 4's lifecycle coverage — note that forward pointer in your report); (b) make `?url=` return all items — the filter test fails; (c) add `"stale": true` to the item payload — the verdict-guard test fails. Restore all.

- [ ] **Step 6: Commit** — `git add src/status/endpoint.ts tests/statusEndpoint.test.ts && git commit -m "feat: localhost status endpoint with request-time samples"`

---

### Task 4: Wire the server — registry, endpoint, statusUrl

**Files:**
- Modify: `src/mcp.ts`
- Test: additions to `tests/mcp.test.ts` and `tests/mcpProcessLifecycle.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3 exactly as produced.
- Produces: task-mode handle replies whose `task.statusMessage` begins `status: <url>` when the endpoint is live; every completed result JSON gains `statusUrl: string | null`; `buildServer(opts?)` gains `statusPort?: number | null` (test seam, overrides env).

Wiring requirements:

1. In `buildServer`: create `const statusRegistry = createStatusRegistry();` and `const statusEndpoint = startStatusEndpoint(statusRegistry, { pid: process.pid, version: '0.3.0', startedAt: Date.now(), concurrency: () => ({ cap: /* pool cap value */, running: pool.running, queued: pool.queued }) }, opts?.statusPort !== undefined ? opts.statusPort : statusPortFromEnv());` — per-server instances, consistent with the no-module-state rule. (Expose the pool's cap: `createSlotPool` currently doesn't reveal `max`; add a readonly `cap` to `SlotPool` — one line plus one line in the existing pool tests.)
2. Both executors register items before execution and connect the hooks: for analyze, extend the existing `runAnalyzeExecution` hook wiring with `onSpawn`/`onSpawnEnded` mapped to `statusRegistry.spawn/spawnEnded`, `onStage` ALSO mirrored to `statusRegistry.stage` (keep the existing statusMessage mapping — two readers, one event); `onItemStart` unchanged. For resolve, pass the new hooks parameter from Task 2. `register()` per item at executor start (ids held in an array by index); `finish(id, itemStatus)` per item from the result array after completion; on wrapper breakage, `finish` with `'wrapper_failed'`.
3. statusUrl in the handle reply: in both `createTask` handlers, after `createTask`, `const su = await Promise.race([statusEndpoint.url, new Promise<null>((r) => setTimeout(r, 1000).unref ? r(null) : r(null))])` — simpler: `await statusEndpoint.url` is fine (it settles on listen/error, both fast; document that). When non-null: `await extra.taskStore.updateTaskStatus(task.taskId, 'working', \`status: ${su}\`)` then re-`getTask` and return the refreshed task so the reply carries it. When null: skip.
4. statusUrl in results: `toResult` gains a second parameter — build the result object as `{ ...r, statusUrl }` before stringify, in all four `storeTaskResult('completed', ...)`/plain paths (it flows through the same executor, so it is ONE place per tool).
5. The `'downloading'` stage now flows into task `statusMessage` for real downloads — no schema change; existing tests keep passing because local-file fixtures never emit it.

Tests to add (follow the file's existing harness patterns):

```ts
// tests/mcp.test.ts additions
it('task handle reply carries the status url; completed result echoes it; endpoint lists the item', async () => {
  // buildServer({ statusPort: 0 }) + connectClient + one local-video analyze task via callToolStream.
  // Assert: first taskCreated message's task.statusMessage matches /^status: http:\/\/127\.0\.0\.1:\d+\/status$/.
  // Await the result; parse; expect(parsed.statusUrl).toMatch(same regex).
  // fetch(parsed.statusUrl): items contain our url with outcome.status 'ok' and tool 'analyze'.
});

it('statusPort null disables the endpoint: no status prefix, statusUrl null, nothing listening', async () => {
  // buildServer({ statusPort: null }); plain call; parsed.statusUrl === null;
  // taskCreated statusMessage (task mode) does NOT begin with 'status:'.
});
```

```ts
// tests/mcpProcessLifecycle.test.ts addition
it('exits promptly after stdin EOF with the status endpoint up (unref holds)', async () => {
  // Same spawn pattern as the existing test, but assert the endpoint was genuinely
  // live first: parse the statusUrl from the call's reply, fetch it once, THEN
  // close stdin and assert exit within the existing deadline. This is the §10
  // "endpoint holds the process open" mutant's killing test.
});
```

- [ ] Steps: failing tests → implement → `npm run build && npx vitest run tests/mcp.test.ts tests/mcpProcessLifecycle.test.ts` → full suite + typecheck → **mutation duty**: (a) drop the endpoint's `unref`s (from Task 3) — the new lifecycle test must fail by timeout/force-kill; (b) make the registry `stage()` also `writeFileSync` somewhere under `destinationPath` — assert which test fails: add a small assertion to the new mcp test that `destinationPath` contains ONLY the expected artifact names after completion (manifest/transcript/frames/video patterns) so a stray status file fails it — this is the §10 "registry writes a file per transition" mutant; restore. Commit `git add src/mcp.ts src/agent/slots.ts tests/mcp.test.ts tests/mcpProcessLifecycle.test.ts tests/slots.test.ts && git commit -m "feat: wire status registry and endpoint into the server, statusUrl in replies"`.

---

### Task 5: The discovery file

**Files:**
- Create: `src/status/discovery.ts`
- Modify: `src/mcp.ts` (register/unregister around server lifecycle)
- Test: `tests/statusDiscovery.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ServerEntry { pid: number; port: number; startedAt: number; version: string; }
export function discoveryPath(): string;                     // $VIDEO_EXTRACT_CACHE_DIR ?? ~/.cache/video-extract-mcp, + /servers.json
export function registerServer(entry: ServerEntry): void;     // atomic write-rename, replaces own pid's entry
export function unregisterServer(pid: number): void;          // best-effort removal
export function liveServers(): ServerEntry[];                 // reads, liveness-checks (process.kill(pid, 0)), prunes dead entries back to disk, returns live
```

Requirements: atomic writes (`writeFileSync` to `servers.json.tmp.<pid>` then `renameSync`); a corrupt/absent file reads as `[]`; `liveServers()` treats ESRCH as dead and EPERM as live (`kill(pid, 0)` semantics); pruning rewrites only when something was actually pruned (readers stay read-only in the steady state — the §7 write-frequency promise). `VIDEO_EXTRACT_CACHE_DIR` env override exists so tests never touch the real home directory — document it as test-facing.

In `src/mcp.ts`: after the endpoint's url resolves non-null, `registerServer({ pid, port, startedAt, version })`; on `process.on('exit')` sync `unregisterServer(process.pid)`; SIGINT/SIGTERM handlers that `process.exit()` (which triggers the exit hook) — install them ONCE per process, guarded, and only when the endpoint is live. Crash-left stale entries are the readers' problem by design (§7).

Tests: register/read round-trip under a stubbed cache dir; liveness pruning with a guaranteed-dead pid (spawn a `node -e ""` child, wait for exit, use its pid); corrupt file → `[]`; concurrent registers from two entries preserve both (write-rename atomicity — simulate by interleaving two `registerServer` calls with different pids); `unregisterServer` removes only its own entry.

- [ ] Steps: failing tests → implement → green → full suite → commit `git add src/status/discovery.ts src/mcp.ts tests/statusDiscovery.test.ts && git commit -m "feat: server discovery registry for cross-session status"`.

---

### Task 6: The CLI — `video-extract status` — and the kill-semantics integration test

**Files:**
- Create: `src/status/statusCli.ts`
- Modify: `src/cli.ts` (subcommand dispatch only)
- Test: `tests/statusCli.test.ts`, `tests/statusKill.integration.test.ts`

**Interfaces:**
- Consumes: `liveServers()` (Task 5), the endpoint payload shape (Task 3).
- Produces: `runStatusCli(argv: string[], out: (line: string) => void): Promise<number>` (exit code; `out` injected for tests), wired in `src/cli.ts`'s `main()` as: `if (process.argv[2] === 'status') { process.exit(await runStatusCli(process.argv.slice(3), (l) => console.log(l))); }` before the existing `parseArgs` path. `--watch` re-renders every 1000ms via ANSI clear; `--json` prints the merged payloads raw; positional args filter by exact url (passed to the endpoint as `?url=`).

Render rules (the agent-facing text — treat like a description string): one line per item — url, stage chain joined with `→`, current stage age as `(<n>s in stage)` or `(done <n>m ago)`, and when a child is live: `· <childCommand> pid <pid> · cpu <n>s`, and when `workDirBytes` present: `· workdir <humanized>`. Footer per server: `server pid <pid> · up <n>m · cap <c> · running <r> · queued <q>`. A dead-servers-only state prints `no live video-extract servers` and exits 0. NO verdict words — the same §10 guard greps the rendered output in tests.

```ts
// tests/statusCli.test.ts sketch (write in full):
// - stub VIDEO_EXTRACT_CACHE_DIR; start a real endpoint (Task 3) with seeded registry;
//   registerServer({pid: process.pid, port, ...}); run runStatusCli([], collect) ->
//   assert the item line contains the url, the stage chain with '→', an age suffix, no verdict words.
// - runStatusCli(['--json'], ...) -> parses as JSON, server block present.
// - runStatusCli(['https://only/this'], ...) -> only that url's line rendered.
// - dead-server entry (exited child pid) -> pruned, 'no live video-extract servers', exit 0.
```

The kill-semantics integration test (§10 — "killing an item's child makes that item fail honestly while the batch continues"):

```ts
// tests/statusKill.integration.test.ts (shape; write in full)
// Mock ../dist/resolve/index.js: item URLs ending '/slow' run
//   `await run('node', ['-e', 'setTimeout(() => {}, 30000)'])` (through the REAL run(),
//   inside the caller's status context) and then return ok with a local makeTestVideo file;
//   other URLs resolve a local file immediately.
// buildServer({ statusPort: 0 }); start an N=2 analyze task (slow + fast), transcript:false.
// Poll the status endpoint until the slow item shows a childPid (bounded retries, <= 10s).
// process.kill(childPid, 'SIGKILL').
// Await the task result: expect task terminal status 'completed';
//   parsed.videos: slow item status !== 'ok' (killed child -> run() resolves code -1/null ->
//   resolver throw -> honest extractor_failed), fast item status 'ok'.
// This is the documented kill workflow end to end: observe pid via the endpoint, kill, batch survives.
```

- [ ] Steps: failing tests → implement → `npm run build` + both new files green → full suite + typecheck → mutation: make the CLI print a `STALE` marker for ages > 60s — the verdict-guard test on rendered output must fail; restore. Commit `git add src/status/statusCli.ts src/cli.ts tests/statusCli.test.ts tests/statusKill.integration.test.ts && git commit -m "feat: video-extract status CLI and kill-semantics integration"`.

---

### Task 7: Version, descriptions, docs

**Files:**
- Modify: `package.json` (+ lockfile via `npm install --package-lock-only`), `src/mcp.ts` (two dictated sentences + version string), `README.md`, `CLAUDE.md`, `docs/follow-ups.md`
- Test: existing suite (description tests updated to the new dictated text)

- [ ] **Step 1: Version 0.3.0** — `package.json`, lockfile, and `src/mcp.ts`'s server info string + the endpoint's `version` argument.

- [ ] **Step 2: Descriptions.** Append EXACTLY this sentence to `ANALYZE_DESCRIPTION` (after the cancellation sentence, before `[LIFETIME]`) and to `RESOLVE_DESCRIPTION` (after the background-task sentence, before `[LIFETIME]`), one space joined, changing nothing else in the frozen strings:

```
In background-task mode the reply also carries statusUrl, a local HTTP address: GET it for every video this server is working on, with stage history, timestamps and raw activity samples (child process CPU, bytes written) -- observations only, no judgments; fetch it twice and compare to tell slow from stuck.
```

Update the description-asserting tests to the amended text.

- [ ] **Step 3: README.** Add a "Watching progress" section after "Background tasks": the CLI (`video-extract status`, `--watch`, `--json`, url filters) with a rendered example (reuse the §6 mock from the spec, verdict-free), the endpoint (statusUrl in task replies, `?url=` filter, `VIDEO_EXTRACT_STATUS_PORT` to pin / `0` to disable), the two-polls-and-diff pattern ("the server reports observations, never judgments — poll twice and compare CPU/bytes to tell a slow download from a stuck one"), and the kill semantics verbatim from §6: killing an item's child fails that item honestly while the batch continues; killing the server pid stops everything and files at destinationPath survive. Env table gains `VIDEO_EXTRACT_STATUS_PORT`. Update the tests badge to the final count.

- [ ] **Step 4: CLAUDE.md** — add to the invariants: the status registry is per-server and in-memory; the only file the feature writes is the discovery registry (start/exit, liveness-pruned); payloads and CLI output carry observables never verdicts (tests grep for verdict words — do not add `stale`/`healthy` fields); the endpoint must stay unref'd (lifecycle test guards it).

- [ ] **Step 5: follow-ups.md** — §H gains: real download percentages by parsing yt-dlp progress output, attaching at the `'downloading'` stage; endpoint history persistence (dead server takes its registry — revisit only if real usage demands it).

- [ ] **Step 6: Gates** — `npm test` green, `npm run typecheck` clean, `npm run matrix` exit 0 unchanged (revert its timestamp churn before staging). The name-guard must pass on every commit.

- [ ] **Step 7: Commit** — `git add package.json package-lock.json src/mcp.ts README.md CLAUDE.md docs/follow-ups.md tests/ && git commit -m "docs: 0.3.0 -- the observable status channel"`

---

## Deferred

yt-dlp download-percentage parsing; status history persistence; per-task abort machinery (follow-ups §H unchanged).
