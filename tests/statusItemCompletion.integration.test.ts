// tests/statusItemCompletion.integration.test.ts
//
// Final whole-branch review, Important finding 2: a completed batch item
// used to read as still-running on /status until its SLOWEST SIBLING also
// finished -- src/mcp.ts called statusRegistry.finish() only after
// analyzeVideoTool's own Promise.all resolved, so a fast item that had
// already released its pool slot still showed up in the endpoint with
// frozen bytes, no childPid, no CPU and a climbing "in stage" age -- the
// exact signature the status channel's own docs teach an agent to read as
// stuck. Proven END TO END here (unit-level coverage of the hook itself,
// independent of src/mcp.ts's wiring, lives in tests/analyzeTool.test.ts):
// a fast item's completion must be visible via the REAL /status endpoint
// while its slow sibling, in the SAME batch, is still running.
//
// Dist-imported and resolve()-mocked, the same shape as
// tests/statusKill.integration.test.ts and for the identical reason: every
// module in buildServer's transitive graph must resolve to ONE set of
// compiled instances, or the status context's AsyncLocalStorage singleton
// (src/status/context.ts) silently splits into two disconnected ones. The
// slow item here is a plain setTimeout inside the mocked resolve(), not a
// real spawned child (unlike statusKill's kill test) -- this finding is
// about PROMISE-SETTLEMENT ordering, not process lifecycle, so no child
// process, and so no kill-cleanup, is needed at all.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { makeTestVideo } from '../dist/media/ffmpeg.js';

const FAST_URL = 'https://example.test/video/fast-item';
const SLOW_URL = 'https://example.test/video/slow-item';
const SLOW_DELAY_MS = 1500;

// Assigned in the test body before the tool call that triggers the mocked
// resolve() below -- same lazy-read-at-call-time property
// tests/statusKill.integration.test.ts's own slowVideoPath/fastVideoPath
// rely on. One shared fixture is enough: content is irrelevant to this
// finding, only resolve()'s own timing is.
let videoPath = '';

vi.mock('../dist/resolve/index.js', () => ({
  resolve: async (url: string) => {
    if (url.endsWith('/slow-item')) await new Promise((res) => { setTimeout(res, SLOW_DELAY_MS); });
    return {
      status: 'ok' as const, filePath: videoPath, platform: 'test', title: url,
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
  await client.listTools(); // required for callToolStream() to reach the real task path
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

describe('a completed batch item is visible on /status before its slower sibling finishes (spec §5, final review Important 2)', () => {
  it('item 1 (fast) shows an outcome while item 2 (slow), in the same batch, is still running', async () => {
    const videoDir = mkdtempSync(join(tmpdir(), 'norma-itemdone-video-'));
    videoPath = await makeTestVideo(join(videoDir, 'v.mp4'), 2);

    const server = buildServer({ statusPort: 0 });
    const client = await connectClient(server);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-itemdone-dest-'));

    const stream = client.experimental.tasks.callToolStream({
      name: 'analyze_video',
      arguments: {
        destinationPath: destDir,
        videos: [
          { pathOrUrl: FAST_URL, transcript: false, frames: 'none' },
          { pathOrUrl: SLOW_URL, transcript: false, frames: 'none' },
        ],
      },
    }) as AsyncGenerator<StreamMsg>;

    const first = await stream.next();
    const firstMsg = first.value as StreamMsg;
    expect(firstMsg.type).toBe('taskCreated');
    const urlMatch = /^status: (http:\/\/127\.0\.0\.1:\d+\/status)$/.exec(firstMsg.task?.statusMessage ?? '');
    expect(urlMatch).not.toBeNull();
    const statusUrl = urlMatch![1]!;

    type Snapshot = { items: Array<{ url: string; outcome?: { status: string } }> };
    const fetchSnapshot = async (): Promise<Snapshot> => (await fetch(statusUrl)).json() as Promise<Snapshot>;

    // Bounded poll (well inside SLOW_DELAY_MS, which is what makes the
    // window observable at all) for the moment the FAST item shows an
    // outcome -- never a fixed sleep, matching this branch's own
    // established polling convention (tests/mcp.test.ts, tests/
    // statusDiscovery.test.ts, tests/statusKill.integration.test.ts).
    let observed: Snapshot | undefined;
    const deadline = Date.now() + SLOW_DELAY_MS - 200;
    while (Date.now() < deadline) {
      const snap = await fetchSnapshot();
      const fast = snap.items.find((it) => it.url === FAST_URL);
      if (fast?.outcome !== undefined) { observed = snap; break; }
      await sleep(20);
    }

    expect(observed).toBeDefined();
    const fastItem = observed!.items.find((it) => it.url === FAST_URL);
    const slowItem = observed!.items.find((it) => it.url === SLOW_URL);
    expect(fastItem?.outcome?.status).toBe('ok');
    // The decisive assertion: at the SAME instant the fast item is already
    // done, its slow sibling -- still inside resolve()'s own SLOW_DELAY_MS
    // setTimeout -- must NOT show an outcome yet. Under the pre-fix code
    // (finish() driven off Promise.all) this would only ever be observed
    // once BOTH items are done, so this assertion is what a revert to that
    // shape fails.
    expect(slowItem?.outcome).toBeUndefined();

    // Drain the rest of the stream so the slow item's own real completion
    // (and the task's terminal state) is awaited before the test returns --
    // nothing left pending, no dangling timer outliving this test.
    let finalContent: Array<{ type: string; text: string }> | undefined;
    for await (const msg of stream) {
      if (msg.type === 'result') finalContent = msg.result!.content;
    }
    expect(finalContent).toBeDefined();
    const parsed = JSON.parse(finalContent![0]!.text) as { videos: Array<{ status: string }> };
    expect(parsed.videos.map((v) => v.status)).toEqual(['ok', 'ok']);

    await client.close();
  }, 20_000);
});
