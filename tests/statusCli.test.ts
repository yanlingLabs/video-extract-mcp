// tests/statusCli.test.ts
//
// task-6-brief.md: `video-extract status` merges every LIVE server's status
// (src/status/discovery.ts's liveServers(), already liveness-verified and
// pruned) into one rendered view. Same posture as tests/statusEndpoint.test.ts
// -- observables, never verdicts -- but pinned against the RENDERED TEXT
// here, not the JSON payload: the endpoint's own guard (statusEndpoint.test.ts)
// only proves the payload is clean; a CLI that fed that same clean payload
// through a verdict-adding renderer would slip straight past it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createStatusRegistry, type StatusRegistry } from '../src/status/registry.js';
import { startStatusEndpoint, type StatusEndpoint } from '../src/status/endpoint.js';
import { registerServer } from '../src/status/discovery.js';
import { runStatusCli } from '../src/status/statusCli.js';

/** Isolates every test's discovery file from both the real home directory
 *  AND from every other concurrently-running test file's servers -- the
 *  vitest.config.ts baseline is SHARED across the whole suite (every
 *  buildServer()-calling test registers into it), so without a fresh
 *  per-test override, "no live servers" and exact-item-count assertions
 *  below would be at the mercy of whatever else happens to be running.
 *  Mirrors tests/statusDiscovery.test.ts's own freshCacheDir() exactly. */
function freshCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vem-cli-cache-'));
  vi.stubEnv('VIDEO_EXTRACT_CACHE_DIR', dir);
  return dir;
}

/** Wires a seeded registry to a REAL, live endpoint (Task 3) and registers
 *  it into the (per-test, isolated) discovery file (Task 5) under THIS test
 *  process's own real, live pid -- so liveServers()'s own kill(pid,0) check
 *  passes trivially, matching the brief's own sketch
 *  ("registerServer({pid: process.pid, port, ...})"). */
async function setupLiveServer(reg: StatusRegistry): Promise<StatusEndpoint> {
  const ep = startStatusEndpoint(
    reg,
    { pid: process.pid, version: '0.3.0', startedAt: Date.now(), concurrency: () => ({ cap: 4, running: 1, queued: 0 }) },
    0,
  );
  const url = await ep.url;
  const port = Number(new URL(url!).port);
  registerServer({ pid: process.pid, port, startedAt: Date.now(), version: '0.3.0' });
  return ep;
}

describe('video-extract status CLI', () => {
  const open: StatusEndpoint[] = [];
  afterEach(() => { open.splice(0).forEach((e) => e.close()); vi.unstubAllEnvs(); });

  it('renders one line per item -- url, an arrow-joined stage chain, an age suffix -- plus a footer, with no verdict words', async () => {
    freshCacheDir();
    const reg = createStatusRegistry();
    const itemDir = mkdtempSync(join(tmpdir(), 'vem-cli-item-'));
    const id = reg.register({ url: 'https://x/a', tool: 'analyze', destinationPath: itemDir });
    reg.stage(id, 'resolving');
    reg.stage(id, 'downloading');
    open.push(await setupLiveServer(reg));

    const lines: string[] = [];
    const code = await runStatusCli([], (l) => lines.push(l));

    expect(code).toBe(0);
    const itemLine = lines.find((l) => l.includes('https://x/a'));
    expect(itemLine).toBeDefined();
    expect(itemLine).toContain('resolving → downloading');
    expect(itemLine).toMatch(/\(\d+s in stage\)/);

    // Footer per server (brief's literal template).
    const footerLine = lines.find((l) => l.startsWith('server pid'));
    expect(footerLine).toBeDefined();
    expect(footerLine).toMatch(/^server pid \d+ · up \d+m · cap \d+ · running \d+ · queued \d+$/);

    // §10 guard, on the RENDERED TEXT (the endpoint's own guard only covers
    // the JSON payload -- this is the CLI's own copy of that promise).
    expect(lines.join('\n').toLowerCase()).not.toMatch(/stale|stuck|healthy|percent/);
  });

  it('a live child and known workdir bytes both render their optional clauses', async () => {
    freshCacheDir();
    const reg = createStatusRegistry();
    const itemDir = mkdtempSync(join(tmpdir(), 'vem-cli-child-'));
    writeFileSync(join(itemDir, 'blob.bin'), Buffer.alloc(2048));
    const id = reg.register({ url: 'https://x/child', tool: 'analyze', destinationPath: itemDir });
    reg.stage(id, 'downloading');
    reg.spawn(id, process.pid, 'yt-dlp'); // a real, live pid -> childCpuSeconds resolves (mirrors statusEndpoint.test.ts)
    open.push(await setupLiveServer(reg));

    const lines: string[] = [];
    await runStatusCli([], (l) => lines.push(l));

    const itemLine = lines.find((l) => l.includes('https://x/child'));
    expect(itemLine).toBeDefined();
    expect(itemLine).toContain(`· yt-dlp pid ${process.pid}`);
    expect(itemLine).toMatch(/· cpu \d+(\.\d+)?s/);
    expect(itemLine).toContain('· workdir');
  });

  it('an item with no stage history yet renders as queued -- no fabricated ahead-count', async () => {
    // The registry (src/status/registry.ts) has no "N ahead" field -- only
    // the per-task MCP statusMessage does, which this CLI never reads (it
    // only ever talks to the /status endpoint). A registered-but-not-yet-
    // started item is real and reachable (registerItems() in src/mcp.ts
    // registers every item up front, before either executor starts), so
    // this is not a hypothetical case.
    freshCacheDir();
    const reg = createStatusRegistry();
    const itemDir = mkdtempSync(join(tmpdir(), 'vem-cli-queued-'));
    reg.register({ url: 'https://x/queued', tool: 'analyze', destinationPath: itemDir });
    open.push(await setupLiveServer(reg));

    const lines: string[] = [];
    await runStatusCli([], (l) => lines.push(l));

    expect(lines.find((l) => l.includes('https://x/queued'))).toBe('https://x/queued  queued');
  });

  it('--json prints the merged raw per-server payloads as one JSON array; the server block is present', async () => {
    freshCacheDir();
    const reg = createStatusRegistry();
    const itemDir = mkdtempSync(join(tmpdir(), 'vem-cli-json-'));
    reg.register({ url: 'https://x/b', tool: 'analyze', destinationPath: itemDir });
    open.push(await setupLiveServer(reg));

    const lines: string[] = [];
    const code = await runStatusCli(['--json'], (l) => lines.push(l));

    expect(code).toBe(0);
    expect(lines).toHaveLength(1); // one JSON blob, not one line per item
    const parsed = JSON.parse(lines[0]!) as Array<{
      server: { pid: number }; items: Array<{ url: string }>; evicted: number;
    }>;
    expect(parsed).toHaveLength(1); // one live server
    expect(parsed[0]!.server).toBeDefined();
    expect(parsed[0]!.server.pid).toBe(process.pid);
    expect(parsed[0]!.items.some((i) => i.url === 'https://x/b')).toBe(true);
  });

  it('a positional url argument filters to only that url (passed to the endpoint as ?url=)', async () => {
    freshCacheDir();
    const reg = createStatusRegistry();
    reg.register({ url: 'https://only/this', tool: 'analyze', destinationPath: mkdtempSync(join(tmpdir(), 'vem-cli-f1-')) });
    reg.register({ url: 'https://other/that', tool: 'analyze', destinationPath: mkdtempSync(join(tmpdir(), 'vem-cli-f2-')) });
    open.push(await setupLiveServer(reg));

    const lines: string[] = [];
    await runStatusCli(['https://only/this'], (l) => lines.push(l));

    const joined = lines.join('\n');
    expect(joined).toContain('https://only/this');
    expect(joined).not.toContain('https://other/that');
  });

  it('a dead server entry is pruned; with nothing left live, prints the exact no-servers line and exits 0', async () => {
    freshCacheDir();
    // Brief's own recipe (mirrors tests/statusDiscovery.test.ts): spawn a
    // real child, let it exit, reuse its pid -- guaranteed ESRCH.
    const dead = spawnSync(process.execPath, ['-e', '""']);
    registerServer({ pid: dead.pid, port: 9, startedAt: Date.now(), version: '0.3.0' });

    const lines: string[] = [];
    const code = await runStatusCli([], (l) => lines.push(l));

    expect(code).toBe(0);
    expect(lines).toEqual(['no live video-extract servers']);
  });

  it('a stage aged well past a minute still renders with no verdict words (pins the conditional verdict-marker guard)', async () => {
    // Mutation duty (task-6-brief.md): "make the CLI print a STALE marker
    // for ages > 60s -- the verdict-guard test on rendered output must
    // fail." That mutant is CONDITIONAL on age -- a guard test built only
    // from fresh (few-seconds-old) fixtures would never actually execute
    // the mutated branch and would stay green regardless. This fixture
    // backdates Date.now() for exactly the two stage() calls (registry.ts
    // stamps `at: Date.now()` internally, with no way to inject a
    // timestamp through the public API), so the rendered age is genuinely
    // >60s under real wall-clock time once restored.
    freshCacheDir();
    const reg = createStatusRegistry();
    const itemDir = mkdtempSync(join(tmpdir(), 'vem-cli-old-'));
    const id = reg.register({ url: 'https://x/old', tool: 'analyze', destinationPath: itemDir });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 61_000);
    reg.stage(id, 'resolving');
    reg.stage(id, 'downloading');
    nowSpy.mockRestore();
    open.push(await setupLiveServer(reg));

    const lines: string[] = [];
    await runStatusCli([], (l) => lines.push(l));

    const itemLine = lines.find((l) => l.includes('https://x/old'));
    expect(itemLine).toBeDefined();
    const ageMatch = /\((\d+)s in stage\)/.exec(itemLine!);
    expect(ageMatch).not.toBeNull();
    expect(Number(ageMatch![1])).toBeGreaterThan(60);
    expect(lines.join('\n').toLowerCase()).not.toMatch(/stale|stuck|healthy|percent/);
  });

  it('--watch re-renders until the injected abort signal fires, then stops cleanly (no leaked timer)', async () => {
    // --watch loops forever in real usage (Ctrl-C ends it via Node's
    // default un-handled-SIGINT behavior -- no listener installed for that
    // here, so nothing to leak across tests). A test cannot deliver a real
    // Ctrl-C to itself deterministically, so runStatusCli accepts an
    // optional injected AbortSignal for exactly this: the disclosed,
    // beyond-the-brief addition recorded in task-6-report.md.
    freshCacheDir();
    const reg = createStatusRegistry();
    const itemDir = mkdtempSync(join(tmpdir(), 'vem-cli-watch-'));
    reg.register({ url: 'https://x/watch', tool: 'analyze', destinationPath: itemDir });
    open.push(await setupLiveServer(reg));

    const lines: string[] = [];
    const controller = new AbortController();
    const done = runStatusCli(['--watch'], (l) => lines.push(l), { signal: controller.signal });

    // Bounded poll for the first render, never a fixed sleep (this
    // codebase's own established convention -- tests/statusDiscovery.test.ts,
    // tests/mcp.test.ts).
    for (let i = 0; i < 100 && lines.length === 0; i++) {
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    controller.abort();
    const code = await done;

    expect(code).toBe(0);
    expect(lines.some((l) => l.includes('https://x/watch'))).toBe(true);
  });
});
