// tests/statusKill.integration.test.ts
//
// The documented "stop a stuck job" workflow (spec §6/§10), proven end to
// end: observe a live item's child pid via the status endpoint, SIGKILL it,
// and confirm that item fails HONESTLY (extractor_failed, not a silent
// success) while its sibling in the SAME batch still completes 'ok' and the
// task itself still reaches 'completed' -- "killing an item's child makes
// that item fail honestly while the batch continues" (design doc §6), which
// is EXISTING pipeline behavior from Tasks 1-5 (the registry, the status
// context, run.ts's onSpawn reporting, src/mcp.ts's wiring); nothing in
// src/ is added by this test file. This is the one integration test that
// proves the whole chain -- not just that each piece individually works.
//
// Dist-imported throughout (buildServer, run, makeTestVideo), matching
// tests/analyze.integration.test.ts's own established precedent -- but for
// a SECOND, load-bearing reason specific to this test, not just the
// worker-relative-path reason that precedent documents: src/util/run.ts
// reads the ambient status context via src/status/context.ts's
// AsyncLocalStorage singleton. If ANY module in this test's chain resolved
// against src/ instead of dist/ (e.g. importing run() from
// '../src/util/run.js' while buildServer comes from '../dist/mcp.js'), it
// would read a DIFFERENT, disconnected AsyncLocalStorage instance than the
// one src/status/context.ts's runWithStatus() (established inside
// dist/agent/analyzeTool.js) populates -- statusCallbacks() would return
// undefined, onSpawn would never fire, and the childPid poll below would
// simply time out. Mocking '../dist/resolve/index.js' (not '../src/...')
// is what keeps buildServer's WHOLE transitive graph -- mcp.js ->
// analyzeTool.js -> analyze.js -> resolve/index.js -> util/run.js ->
// status/context.js -- resolving to one consistent set of compiled module
// instances.
//
// vi.mock() factories are hoisted above every import in this file
// (vitest's own transform); buildServer is imported DYNAMICALLY, after the
// mock is registered, matching tests/taskLifecycleResolveCancel.test.ts's
// own proven pattern for this exact situation (a static top-of-file import
// would resolve mcp.js's transitive dependency on resolve/index.js before
// the mock is in place).
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { makeTestVideo } from '../dist/media/ffmpeg.js';

const SLOW_URL = 'https://example.test/video/slow';
const FAST_URL = 'https://example.test/video/fast';

// Assigned in the test body, BEFORE the tool call that triggers the mocked
// resolve() below -- the factory closure reads these at CALL time (when
// resolve() actually runs), which is well after assignment, the same
// lazy-factory property tests/taskLifecycleResolveCancel.test.ts already
// relies on for its own module-scoped RESOLVE_DELAY_MS constant. Pre-made
// once, outside the mock, rather than inside it on every call: simpler,
// avoids an extra (legitimate, but irrelevant-to-this-test) ffmpeg spawn
// racing the slow item's own child inside the same status context.
let slowVideoPath = '';
let fastVideoPath = '';

vi.mock('../dist/resolve/index.js', () => ({
  resolve: async (url: string) => {
    if (url.endsWith('/slow')) {
      // Through the REAL run() (dist/util/run.js), inside the CALLER's
      // status context (established by runWithStatus() around this item's
      // execution, several frames up the call stack in
      // dist/agent/analyzeTool.js) -- this is what makes the child's pid
      // observable via the status endpoint below, exactly like a real
      // yt-dlp/ffmpeg spawn would be.
      const { run } = await import('../dist/util/run.js');
      const result = await run('node', ['-e', 'setTimeout(() => {}, 30000)']);
      if (result.code !== 0) {
        // Killed child -> run() resolves (not rejects) with code -1/null
        // (src/util/run.ts: `code: code ?? -1` on the 'close' event) --
        // this throw is what turns that into the resolver-level failure
        // src/analyze.ts's own outer try/catch absorbs into an honest
        // 'extractor_failed' manifest, never a silent success and never an
        // unhandled rejection.
        throw new Error(`slow child exited abnormally (code ${String(result.code)})`);
      }
      return {
        status: 'ok' as const, filePath: slowVideoPath, platform: 'test', title: 'slow',
        duration: 2, resolvedBy: 'direct' as const,
        captions: { manual: null, auto: null }, languageHint: null, rangeApplied: false,
      };
    }
    // Every other URL (the 'fast' sibling): resolves a local file
    // immediately, no child spawned at all.
    return {
      status: 'ok' as const, filePath: fastVideoPath, platform: 'test', title: 'fast',
      duration: 2, resolvedBy: 'direct' as const,
      captions: { manual: null, auto: null }, languageHint: null, rangeApplied: false,
    };
  },
}));

const { buildServer } = await import('../dist/mcp.js');

async function connectClient(server: McpServer): Promise<Client> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'norma-test-client', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  // Required for client.experimental.tasks.callToolStream() to reach the
  // real task-augmented path at all (tests/taskLifecycle.test.ts's own
  // documented gate: isToolTask() reads a cache populated only by
  // listTools()) -- without it every call below would silently fall back
  // to the plain, non-task path (no 'taskCreated', no taskId to poll).
  await client.listTools();
  return client;
}

type StreamMsg = {
  type: string;
  task?: { taskId: string; status: string; statusMessage?: string };
  result?: { content: Array<{ type: string; text: string }> };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

describe('kill semantics: an observed child dies, its item fails honestly, the batch survives (spec §6)', () => {
  it('SIGKILL on a childPid observed via the status endpoint: killed item != ok, sibling item ok, task completes', async () => {
    const videoDir = mkdtempSync(join(tmpdir(), 'norma-kill-videos-'));
    slowVideoPath = await makeTestVideo(join(videoDir, 'slow.mp4'), 2);
    fastVideoPath = await makeTestVideo(join(videoDir, 'fast.mp4'), 2);

    const server = buildServer({ statusPort: 0 });
    const client = await connectClient(server);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-kill-dest-'));

    const stream = client.experimental.tasks.callToolStream({
      name: 'analyze_video',
      arguments: {
        destinationPath: destDir,
        videos: [
          { pathOrUrl: SLOW_URL, transcript: false, frames: 'none' },
          { pathOrUrl: FAST_URL, transcript: false, frames: 'none' },
        ],
      },
    }) as AsyncGenerator<StreamMsg>;

    const first = await stream.next();
    const firstMsg = first.value as StreamMsg;
    expect(firstMsg.type).toBe('taskCreated');
    // src/mcp.ts's createTask handler stamps this BEFORE the background
    // executor even starts (Task 4), so this is deterministic -- not a
    // race against the executor's own first real status update.
    const urlMatch = /^status: (http:\/\/127\.0\.0\.1:\d+\/status)$/.exec(firstMsg.task?.statusMessage ?? '');
    expect(urlMatch).not.toBeNull();
    const statusUrl = urlMatch![1]!;

    // Observe the slow item's live child pid via the endpoint -- bounded
    // retries, <=10s (never a fixed sleep), matching this branch's own
    // established polling convention (tests/mcp.test.ts, tests/
    // statusDiscovery.test.ts).
    let childPid: number | undefined;
    for (let i = 0; i < 100; i++) {
      const body = await (await fetch(statusUrl)).json() as {
        items: Array<{ url: string; childPid?: number }>;
      };
      const slowItem = body.items.find((it) => it.url === SLOW_URL);
      if (slowItem?.childPid !== undefined) { childPid = slowItem.childPid; break; }
      await sleep(100);
    }
    expect(childPid).toBeDefined();

    process.kill(childPid!, 'SIGKILL');

    let finalContent: Array<{ type: string; text: string }> | undefined;
    let terminalStatus: string | undefined;
    for await (const msg of stream) {
      if (msg.type === 'taskStatus') terminalStatus = msg.task!.status;
      if (msg.type === 'result') finalContent = msg.result!.content;
    }

    // Spec §8: task-failed is reserved for the wrapper itself breaking --
    // one item's child dying must not fail the whole task.
    expect(terminalStatus).toBe('completed');
    expect(finalContent).toBeDefined();
    const parsed = JSON.parse(finalContent![0]!.text) as { videos: Array<{ status: string }> };
    expect(parsed.videos).toHaveLength(2);
    // Killed child -> run() resolves code -1/null -> resolver throw ->
    // src/analyze.ts's outer catch -> honest 'extractor_failed', never 'ok'.
    expect(parsed.videos[0]!.status).not.toBe('ok');
    // The sibling, in the SAME batch, completed normally -- the batch survives.
    expect(parsed.videos[1]!.status).toBe('ok');

    await client.close();
  }, 30_000);
});
