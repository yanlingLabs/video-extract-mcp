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
import { spawn, spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
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

  it('merges items from TWO distinct live servers into one view (the central promise of the discovery file)', async () => {
    // Coverage gap flagged by review: every other test here calls
    // setupLiveServer() at most once, always keyed to process.pid, so
    // nothing shipped actually proved the "merge every live server" half
    // of the CLI's own job. Two genuinely distinct discovery entries are
    // needed -- registerServer() replaces by pid, so two entries under the
    // SAME pid would just collapse into one. process.pid (this test
    // process itself) and process.ppid (its parent -- the process that
    // launched this vitest worker, alive for the whole run) are two real,
    // live, DISTINCT pids with no extra process to spawn: liveServers()
    // only ever checks kill(pid,0) against the registered pid, and never
    // cross-validates that the pid is what actually bound the registered
    // port, so a real second port (a real second in-process endpoint) is
    // all that's additionally needed.
    freshCacheDir();

    const regA = createStatusRegistry();
    regA.register({ url: 'https://serverA/one', tool: 'analyze', destinationPath: mkdtempSync(join(tmpdir(), 'vem-cli-multi-a-')) });
    const epA = startStatusEndpoint(
      regA, { pid: process.pid, version: '0.3.0', startedAt: Date.now(), concurrency: () => ({ cap: 4, running: 0, queued: 0 }) }, 0,
    );
    const urlA = await epA.url;
    registerServer({ pid: process.pid, port: Number(new URL(urlA!).port), startedAt: Date.now(), version: '0.3.0' });
    open.push(epA);

    const regB = createStatusRegistry();
    regB.register({ url: 'https://serverB/two', tool: 'analyze', destinationPath: mkdtempSync(join(tmpdir(), 'vem-cli-multi-b-')) });
    const epB = startStatusEndpoint(
      regB, { pid: process.ppid, version: '0.3.0', startedAt: Date.now(), concurrency: () => ({ cap: 4, running: 0, queued: 0 }) }, 0,
    );
    const urlB = await epB.url;
    registerServer({ pid: process.ppid, port: Number(new URL(urlB!).port), startedAt: Date.now(), version: '0.3.0' });
    open.push(epB);

    const lines: string[] = [];
    const code = await runStatusCli([], (l) => lines.push(l));

    expect(code).toBe(0);
    const joined = lines.join('\n');
    expect(joined).toContain('https://serverA/one');
    expect(joined).toContain('https://serverB/two');
    // Two live servers -> two footer lines, one per pid (trailing space
    // avoids a numeric-prefix collision, e.g. pid 5 matching inside "pid 58").
    const footers = lines.filter((l) => l.startsWith('server pid'));
    expect(footers).toHaveLength(2);
    expect(footers.some((f) => f.includes(`server pid ${process.pid} `))).toBe(true);
    expect(footers.some((f) => f.includes(`server pid ${process.ppid} `))).toBe(true);
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

  it('the watch loop does not accumulate abort-listeners across ticks (fix round 1: the timer\'s NORMAL-resolution path must remove its own listener too)', async () => {
    // Fix round 1 (coordinator review, Important): `{ once: true }` only
    // self-removes a listener that actually FIRES. Every real watch tick
    // resolves via the timer's NORMAL path (nothing aborts in production
    // usage -- Ctrl-C terminates the process directly, it never touches
    // this AbortSignal), so a version that only cleans up on the abort
    // path leaks one listener per tick, unboundedly, for as long as the
    // process runs (reviewer's own reproduction: 6 listeners after 6
    // seconds). Directly inspectable via node:events' getEventListeners()
    // on the SAME AbortSignal this test hands to runStatusCli --
    // abortableSleep() is module-private, but it operates on exactly this
    // externally-owned signal, so no export is needed to observe its
    // listener hygiene from outside.
    //
    // The correct steady-state while the loop is actively running is
    // exactly ONE listener, not zero: at any instant there is either
    // exactly one CURRENTLY-PENDING sleep with its own listener attached,
    // or (briefly, between a tick's own render finishing and its next
    // abortableSleep() call being made) zero -- confirmed empirically
    // before writing this assertion, including that a single FIXED sample
    // time can land inside that brief render-gap and misleadingly read 0
    // even under correct code, which is why this polls densely across
    // several ticks and tracks the MAXIMUM observed count instead of one
    // fixed-time snapshot. (Also confirmed: sampling immediately AFTER an
    // abort always reads 0 under BOTH the buggy and the fixed code,
    // because the single 'abort' event invokes -- and so self-removes, via
    // each one's own {once:true} -- every listener still attached at that
    // instant, stale or not; that makes "after abort" structurally unable
    // to distinguish the two, which is why this samples WHILE the loop is
    // still running instead of after stopping it.) What must never happen
    // is the max climbing past 1 -- 1 (fixed, every tick) vs 1, 2, 3...
    // (buggy, one more surviving per elapsed tick).
    freshCacheDir();
    const reg = createStatusRegistry();
    reg.register({ url: 'https://x/listeners', tool: 'analyze', destinationPath: mkdtempSync(join(tmpdir(), 'vem-cli-listeners-')) });
    open.push(await setupLiveServer(reg));

    const controller = new AbortController();
    const done = runStatusCli(['--watch'], () => {}, { signal: controller.signal });

    // Dense polling (every 30ms) across ~3.5s -- comfortably more than
    // three WATCH_INTERVAL_MS (1000ms) ticks -- so the ~1000ms-long sleep
    // phase of every tick is sampled many times over (virtually certain to
    // observe it at least once per tick, even allowing for scheduler
    // jitter), while a bug that leaks one listener per tick would be
    // caught the moment any sample exceeds 1, well before the window ends.
    let maxListeners = 0;
    const pollUntil = Date.now() + 3_500;
    while (Date.now() < pollUntil) {
      maxListeners = Math.max(maxListeners, getEventListeners(controller.signal, 'abort').length);
      await new Promise((resolve) => { setTimeout(resolve, 30); });
    }

    controller.abort();
    const code = await done;

    expect(code).toBe(0);
    // Exactly 1: not 0 (which would mean this polling never actually
    // caught a live sleep phase -- an unfalsifiable test) and not >1
    // (accumulation).
    expect(maxListeners).toBe(1);
  }, 10_000);

  it('production entrypoint: a bare `node dist/cli.js status --watch` process genuinely keeps re-rendering (regression: unref must not kill the loop)', async () => {
    // Fix round 1 (coordinator review): an in-process vitest test
    // structurally cannot catch this bug class. vitest's own worker
    // process always has OTHER ref'd handles keeping its event loop alive
    // (the test runner itself, its IPC channel, etc.), so the SAME
    // abortableSleep() code observed "the loop advances" in-process even
    // in the build where its timer was unref'd -- the exact build that,
    // run as a bare `node dist/cli.js status --watch` process with
    // NOTHING else keeping the event loop alive, rendered exactly once
    // and exited in ~0.07s (reviewer's own reproduction). Only a real,
    // separate subprocess can observe whether the loop survives its own
    // pacing timer.
    const cacheDir = mkdtempSync(join(tmpdir(), 'vem-cli-watch-subprocess-cache-'));
    vi.stubEnv('VIDEO_EXTRACT_CACHE_DIR', cacheDir);

    const reg = createStatusRegistry();
    reg.register({ url: 'https://x/watchsubprocess', tool: 'analyze', destinationPath: mkdtempSync(join(tmpdir(), 'vem-cli-watch-subprocess-item-')) });
    const ep = startStatusEndpoint(
      reg, { pid: process.pid, version: '0.3.0', startedAt: Date.now(), concurrency: () => ({ cap: 4, running: 0, queued: 0 }) }, 0,
    );
    const url = await ep.url;
    // This test process's own pid -- alive for the whole test, so the
    // CHILD's own liveServers() call (kill(pid,0)) treats it as live.
    registerServer({ pid: process.pid, port: Number(new URL(url!).port), startedAt: Date.now(), version: '0.3.0' });
    open.push(ep);

    const child = spawn(process.execPath, ['dist/cli.js', 'status', '--watch'], {
      cwd: process.cwd(),
      env: { ...process.env, VIDEO_EXTRACT_CACHE_DIR: cacheDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });

    try {
      // The observation window itself -- WATCH_INTERVAL_MS is 1000ms, so
      // ~2.5s real wall-clock time genuinely elapsing is what "does it
      // loop more than once" means here, not something to poll around.
      await new Promise((resolve) => { setTimeout(resolve, 2_500); });
      // Every render is preceded by the ANSI full-reset byte sequence
      // ('\x1Bc', gated to non-json renders) -- counting its occurrences
      // in the raw piped stdout counts renders. One-sided assertion
      // (>= 2, not an exact count) so scheduler/load variance can't flake
      // this: a single render (the pre-fix bug) is 1, not >= 2, so the
      // bug this guards against is caught regardless of exactly how many
      // ticks a loaded machine manages in 2.5s.
      const renderCount = stdout.split('\x1Bc').length - 1;
      expect(renderCount).toBeGreaterThanOrEqual(2);
    } finally {
      child.kill('SIGKILL');
    }
  }, 15_000);
});
