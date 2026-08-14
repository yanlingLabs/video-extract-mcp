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

  // Beyond the brief's Step 1 (added here, not a new file): empirically,
  // `srv.listen(port, ...)` throws SYNCHRONOUSLY (RangeError
  // ERR_SOCKET_BAD_PORT) for a port outside 0-65535, unlike EADDRINUSE which
  // arrives asynchronously via 'error'. Verified directly on this host
  // before writing the implementation (see task report). Without a guard
  // around the listen() call itself, this path would violate "never throws"
  // for any direct caller of startStatusEndpoint (not just ones that went
  // through statusPortFromEnv's own range clamp) -- same contract as the
  // EADDRINUSE test above, different trigger, so it deserves its own test
  // per this branch's own precedent (Task 1's id-uniqueness gap) of adding
  // a test when a real gap in the brief's own suite is found.
  it('an out-of-range pinned port degrades to null, never throws (sync ERR_SOCKET_BAD_PORT)', async () => {
    const ep = startStatusEndpoint(createStatusRegistry(), serverInfo(), 70_000); open.push(ep);
    expect(await ep.url).toBeNull();
  });

  it('completed items carry no workDirBytes and the request stays fast even with a large, repeatedly-shared directory (final review, Important 4)', async () => {
    // Final whole-branch review, Important finding 4: decorateItem used to
    // walk EVERY item's destinationPath, completed ones included, and a
    // completed item's byte count is static -- re-walking it on every poll
    // is pure waste that scales with the registry's cap (500), not the
    // concurrency cap. Measured live: 500 completed items x 40 files cost
    // 75ms on its own. This test uses fewer, larger directories (cheaper to
    // set up) but the same shape: many completed items sharing one
    // expensive-to-walk directory, so a regression to "decorate everything"
    // shows up as a clear, generously-margined timing failure, not a flaky
    // one.
    const bigDir = mkdtempSync(join(tmpdir(), 'vem-status-completed-big-'));
    for (let i = 0; i < 3000; i++) writeFileSync(join(bigDir, `f${i}.bin`), '');
    const smallDir = mkdtempSync(join(tmpdir(), 'vem-status-running-small-'));
    writeFileSync(join(smallDir, 'blob.bin'), Buffer.alloc(4096));

    const reg = createStatusRegistry();
    const completedCount = 60;
    for (let i = 0; i < completedCount; i++) {
      const id = reg.register({ url: `https://x/completed-${i}`, tool: 'analyze', destinationPath: bigDir });
      reg.finish(id, 'ok');
    }
    const runningId = reg.register({ url: 'https://x/running', tool: 'analyze', destinationPath: smallDir });
    void runningId;

    const ep = startStatusEndpoint(reg, serverInfo(), 0); open.push(ep);
    const url = await ep.url;

    const t0 = performance.now();
    const body = await (await fetch(url!)).json() as { items: Array<{ url: string; outcome?: unknown; workDirBytes?: number }> };
    const elapsedMs = performance.now() - t0;

    const completedItems = body.items.filter((i) => i.url.startsWith('https://x/completed-'));
    expect(completedItems).toHaveLength(completedCount);
    // Key absence, not falsiness (CLAUDE.md's own testing convention) --
    // JSON.stringify already drops an undefined-valued property, so this is
    // exactly what a real client sees on the wire.
    for (const item of completedItems) expect('workDirBytes' in item).toBe(false);

    const runningItem = body.items.find((i) => i.url === 'https://x/running')!;
    expect(runningItem.outcome).toBeUndefined();
    expect(runningItem.workDirBytes).toBe(4096);

    // Generously margined (this branch's own established convention for
    // timing assertions -- see tests/mcpProcessLifecycle.test.ts): the old,
    // decorate-everything code walks bigDir sixty times over for a total
    // cost in the hundreds of milliseconds to seconds; the fix walks it
    // zero times.
    expect(elapsedMs).toBeLessThan(500);
  });

  it('a RUNNING item past the workdir scan cap reports no workDirBytes -- omitted, not a wrong partial number (final review, Important 4)', async () => {
    // "Bound the walk... if you cap, the payload must not silently imply
    // completeness; consider omitting the field rather than reporting a
    // partial number, since a wrong number is worse than an absent one
    // under this project's rules" -- this item is still RUNNING (no
    // outcome), so it is not skipped by the fix above; its own directory is
    // what trips the entry cap.
    const hugeDir = mkdtempSync(join(tmpdir(), 'vem-status-cap-'));
    for (let i = 0; i < 2_500; i++) writeFileSync(join(hugeDir, `f${i}.bin`), '');
    const reg = createStatusRegistry();
    reg.register({ url: 'https://x/capped', tool: 'analyze', destinationPath: hugeDir });
    const ep = startStatusEndpoint(reg, serverInfo(), 0); open.push(ep);
    const url = await ep.url;
    const body = await (await fetch(url!)).json() as { items: Array<{ url: string; workDirBytes?: number }> };
    const item = body.items.find((i) => i.url === 'https://x/capped')!;
    expect('workDirBytes' in item).toBe(false);
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
