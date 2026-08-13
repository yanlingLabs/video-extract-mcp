import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildServer, TOOL_NAMES } from '../src/mcp.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';
import { createSlotPool, type SlotPool } from '../src/agent/slots.js';

// A real MCP Client wired to a freshly-built server over the SDK's own
// InMemoryTransport. This is what makes "testing an MCP server without a
// client is awkward" (task-16-brief.md) tractable without hand-rolling a
// reimplementation of the SDK's own JSON-Schema conversion / validation
// dispatch: connecting a real Client lets every test below go through the
// SAME code path a real agent's MCP client would, for both schema
// acceptance/rejection and full handler execution. Each test builds its own
// server+client pair (buildServer() has no side effects at construction
// time) so no state -- registered tools, connection state -- ever bleeds
// across tests.
async function connectClient(server: McpServer): Promise<Client> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'norma-test-client', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// Verified directly against the installed SDK (1.30.0) before writing these
// helpers, via a standalone spike script -- see task-16-report.md: an
// invalid tool call does NOT reject/throw on the client's callTool()
// promise. McpServer's own CallToolRequestSchema handler catches the
// McpError it throws internally and converts it into an ordinary, resolved
// CallToolResult with isError:true and the message as content[0].text. A
// test written as `await expect(client.callTool(...)).rejects.toThrow()`
// would therefore never observe a rejection and would hang/fail -- these
// helpers exist specifically so every test below asserts the REAL, observed
// success/failure shape instead of the more "obvious" but wrong assumption.
// callTool()'s declared return type is a union of two branches (a normal
// content-bearing result vs. a task-handle result), and BOTH branches carry
// a `[x: string]: unknown` catchall index signature (verified directly
// against the SDK's own client/index.d.ts). That combination defeats plain
// `'content' in result` narrowing for the purpose of reading `.content`'s
// real type afterwards -- the index signature makes 'content' a "valid key"
// on the task-handle branch too (typed unknown), so the narrowed access
// resolves to `SomeArray | unknown`, which TypeScript collapses to
// `unknown`. The `in` check below still does its real job at RUNTIME (both
// tools are now task-registered with taskSupport:'optional', but every call
// here is a PLAIN client.callTool() -- the server's automatic task-polling
// wrapper (task-1-report.md's linchpin) resolves that into an ordinary
// content-bearing CallToolResult before the client ever sees a task handle,
// so the content-bearing branch is always what comes back); the `as
// CallToolResult` cast right after it is what recovers the real static type
// once that runtime shape is confirmed.
async function callToolOk(client: Client, params: Parameters<Client['callTool']>[0]): Promise<CallToolResult['content']> {
  const result = await client.callTool(params);
  if (!('content' in result)) throw new Error('expected a content-bearing CallToolResult, got a task result');
  const r = result as CallToolResult;
  if (r.isError) throw new Error(`expected tool success, got isError with content: ${JSON.stringify(r.content)}`);
  return r.content;
}

async function callToolExpectError(client: Client, params: Parameters<Client['callTool']>[0]): Promise<CallToolResult['content']> {
  const result = await client.callTool(params);
  if (!('content' in result)) throw new Error('expected a content-bearing CallToolResult, got a task result');
  const r = result as CallToolResult;
  if (!r.isError) throw new Error(`expected isError, got a successful result: ${JSON.stringify(r.content)}`);
  return r.content;
}

/** Requires the first content block to be the 'text' variant and returns its text. */
function firstText(content: CallToolResult['content']): string {
  const first = content[0];
  if (!first || first.type !== 'text') throw new Error(`expected a text content block, got ${JSON.stringify(first)}`);
  return first.text;
}

/** Every v0.2 tool call is now `{destinationPath, videos: [...]}` and every
 *  reply is `{videos: [...]}` -- one entry per item, in order, even at N=1
 *  (task-5-brief.md Step 1: "reads via parsed.videos[0]"). This is a
 *  deliberate break from 0.1.0's flat single-object reply; only the ON-DISK
 *  layout stays byte-identical at N=1 (see the 'v0.2 batch schema' describe
 *  below), not the JSON reply shape. */
function firstVideo<T>(content: CallToolResult['content']): T {
  return (JSON.parse(firstText(content)) as { videos: T[] }).videos[0]!;
}

// task-8-brief.md's own Step-1 tests, kept verbatim (byte-for-byte the same
// assertions). The four-tool surface this replaces (analyze_video,
// resolve_video, get_frame, get_clip) is gone; get_frame/get_clip remain as
// internal helpers in src/primitives.ts (see task-9) but are no longer
// reachable through this server at all.
describe('v2 surface', () => {
  it('exposes exactly two tools', () => {
    expect([...TOOL_NAMES].sort()).toEqual(['analyze_video', 'resolve_video']);
  });
  it('no longer exposes get_frame or get_clip', () => {
    expect(TOOL_NAMES).not.toContain('get_frame');
    expect(TOOL_NAMES).not.toContain('get_clip');
  });
  it('builds without throwing', () => {
    expect(() => buildServer()).not.toThrow();
  });

  it('registers EXACTLY the two documented tools -- no more, no fewer, none renamed', async () => {
    // The three tests above only inspect the TOOL_NAMES constant, which
    // could silently drift from what is actually wired up with
    // server.registerTool (a typo'd name string, a tool left out, an extra
    // leftover tool). This asks the live, connected server what it actually
    // registered (via a real client's listTools(), the same call a real MCP
    // client makes) and compares that to the constant -- so a renamed or
    // dropped tool fails here even though it would sail through the
    // constant-only checks above.
    const client = await connectClient(buildServer());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    await client.close();
  });

  it('marks both tools as NOT read-only (Fix 4c): both write to the filesystem, and resolve_video moves a caller-owned file in one branch', async () => {
    // The SDK defines readOnlyHint as "the tool does not modify its
    // environment" -- both tools write metadata/manifest/transcript/frame
    // files to destinationPath, so readOnlyHint:true was a false claim
    // clients make trust decisions on. Reads the LIVE schema via
    // listTools(), not a hardcoded constant compared to itself.
    const client = await connectClient(buildServer());
    const { tools } = await client.listTools();
    for (const name of TOOL_NAMES) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`${name} not found in listTools()`);
      expect(tool.annotations?.readOnlyHint).toBe(false);
    }
    await client.close();
  });
});

describe('resolve_video', () => {
  it('rejects a call missing the required url', async () => {
    const client = await connectClient(buildServer());
    const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-rv-'));
    const content = await callToolExpectError(client, { name: 'resolve_video', arguments: { destinationPath: dir, videos: [{}] } });
    expect(firstText(content)).toContain('url');
    await client.close();
  });

  it('rejects a call missing the required destinationPath', async () => {
    const client = await connectClient(buildServer());
    const content = await callToolExpectError(client, { name: 'resolve_video', arguments: { videos: [{ url: 'https://x/v' }] } });
    expect(firstText(content)).toContain('destinationPath');
    await client.close();
  });

  it('rejects an empty videos array (min(1) is its own schema literal, separate from analyze_video\'s)', async () => {
    const client = await connectClient(buildServer());
    const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-rv-empty-'));
    await callToolExpectError(client, { name: 'resolve_video', arguments: { destinationPath: dir, videos: [] } });
    await client.close();
  });

  it("start/end descriptions state the both-or-neither requirement (task-9 Step 6): passing only one is ignored and fetches the whole video", async () => {
    // Task 8's review found neither tool's description said what happens
    // when a range is only half-specified. resolve_video's own range gate
    // (src/resolve/ytdlp.ts:241 -- wantsRange requires BOTH opts.start and
    // opts.end -- and src/agent/resolveTool.ts:82's local-trim fallback,
    // gated the same way) silently treats a lone start or end as no range
    // at all and returns the whole video. Reads the description straight
    // off the LIVE registered schema via listTools(), NOT a hardcoded
    // string also written in this file -- a constant compared to itself
    // would pass regardless of what src/mcp.ts actually says, which is
    // exactly the trap this test is written to avoid. v0.2 nests start/end
    // under the per-item schema (videos[].start/end, not a top-level
    // field) -- the exact JSON-Schema shape (array -> items -> properties)
    // was confirmed empirically against a live listTools() response before
    // writing this path, not assumed.
    const client = await connectClient(buildServer());
    const { tools } = await client.listTools();
    const resolveVideo = tools.find((t) => t.name === 'resolve_video');
    if (!resolveVideo) throw new Error('resolve_video not found in listTools()');
    const videosSchema = resolveVideo.inputSchema.properties?.videos as
      { items?: { properties?: Record<string, { description?: string }> } } | undefined;
    const itemProps = videosSchema?.items?.properties;
    const startDesc = itemProps?.start?.description ?? '';
    const endDesc = itemProps?.end?.description ?? '';
    expect(startDesc).toMatch(/either alone is ignored/i);
    expect(startDesc.toLowerCase()).toContain('whole video');
    expect(endDesc).toMatch(/either alone is ignored/i);
    expect(endDesc.toLowerCase()).toContain('whole video');
    await client.close();
  });

  it('accepts a valid call and resolves a REAL local synthetic video end-to-end, downloading it when returnVideo is requested', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'norma-mcp-resolve-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 6);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-mcp-resolve-dest-'));
    const client = await connectClient(buildServer());
    const content = await callToolOk(client, {
      name: 'resolve_video',
      arguments: { destinationPath: destDir, videos: [{ url: video, returnVideo: true }] },
    });
    const result = firstVideo<{
      status: string; duration: number; platform: string; videoPath: string; metadataPath: string;
    }>(content);
    expect(result.status).toBe('ok');
    // Exact, not "greater than zero": makeTestVideo(_, 6) probes to exactly
    // 6.0s (verified precedent: tests/primitives.test.ts's own 9s-fixture
    // comment), so a resolver that silently mis-measured or hardcoded a
    // duration would be caught here, not just "no duration at all".
    expect(result.duration).toBe(6);
    // 'local', not e.g. a fabricated 'direct' or 'youtube': proves resolve()'s
    // real bare-filesystem-path branch actually ran, rather than a stub that
    // fabricated a plausible-looking platform string.
    expect(result.platform).toBe('local');
    expect(existsSync(result.videoPath)).toBe(true);
    expect(existsSync(result.metadataPath)).toBe(true);
    await client.close();
  }, 30_000);

  it('does NOT download media by default -- metadata only (spec §2.1, the tool description\'s central claim)', async () => {
    // Same real video as above, but returnVideo is omitted. This exercises
    // the schema's own `returnVideo` default reaching resolveVideoTool
    // through a live client call -- tests/resolveTool.test.ts already proves
    // resolveVideoTool's own default at the function-call level, but not
    // that the MCP schema actually wires it through unchanged.
    const srcDir = mkdtempSync(join(tmpdir(), 'norma-mcp-resolve-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 6);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-mcp-resolve-dest2-'));
    const client = await connectClient(buildServer());
    const content = await callToolOk(client, {
      name: 'resolve_video',
      arguments: { destinationPath: destDir, videos: [{ url: video }] },
    });
    const result = firstVideo<{ status: string; videoPath?: string; nextSteps?: string }>(content);
    expect(result.status).toBe('ok');
    expect(result.videoPath).toBeUndefined();
    expect(result.nextSteps).toMatch(/returnVideo/);
    await client.close();
  }, 30_000);
});

describe('analyze_video', () => {
  it('rejects a call missing the required pathOrUrl', async () => {
    const client = await connectClient(buildServer());
    const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-'));
    const content = await callToolExpectError(client, { name: 'analyze_video', arguments: { destinationPath: dir, videos: [{}] } });
    expect(firstText(content)).toContain('pathOrUrl');
    await client.close();
  });

  it('rejects a call missing the required destinationPath', async () => {
    const client = await connectClient(buildServer());
    const content = await callToolExpectError(client, { name: 'analyze_video', arguments: { videos: [{ pathOrUrl: 'https://x/v' }] } });
    expect(firstText(content)).toContain('destinationPath');
    await client.close();
  });

  it('accepts frames: "even"', async () => {
    // "Accepts" means the SCHEMA lets the call through (isError:false from
    // the MCP layer) -- not that the underlying analysis succeeds. The path
    // below is deliberately unresolvable so the handler fails fast, which is
    // exactly what proves this wasn't rejected at validation: a schema
    // bounce and a handler-level failure return different isError shapes,
    // and only callToolOk (isError:false) is consistent with the former
    // never happening.
    const client = await connectClient(buildServer());
    const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-even-'));
    const badPath = join(tmpdir(), 'norma-mcp-test-does-not-exist', 'nope.mp4');
    const content = await callToolOk(client, {
      name: 'analyze_video',
      arguments: { destinationPath: dir, videos: [{ pathOrUrl: badPath, frames: 'even' }] },
    });
    const result = firstVideo<{ status: string }>(content);
    expect(result.status).not.toBe('ok');
    await client.close();
  }, 15_000);

  it('rejects frames: "dense" (not one of the enum values)', async () => {
    const client = await connectClient(buildServer());
    const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-dense-'));
    const content = await callToolExpectError(client, {
      name: 'analyze_video',
      arguments: { destinationPath: dir, videos: [{ pathOrUrl: 'https://x/v', frames: 'dense' }] },
    });
    expect(firstText(content)).toContain('frames');
    await client.close();
  });

  it('maxFrames: 0 with no frames given aliases to frames: "none" (Fix 3)', async () => {
    // Pre-fix, mcp.ts's frames field carried `.default('key')`, so `frames`
    // was NEVER undefined by the time resolveFrameMode ran and the
    // zero-budget alias (spec §2.2) could never be reached through this
    // server at all -- even though resolveFrameMode itself has always
    // handled it correctly (tests/typesV2.test.ts:8). Asserted at the claim
    // level, through a REAL call and the manifest actually written to disk,
    // not by calling resolveFrameMode directly.
    const srcDir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-zero-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 6);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-zero-'));
    const client = await connectClient(buildServer());
    const content = await callToolOk(client, {
      name: 'analyze_video',
      arguments: { destinationPath: destDir, videos: [{ pathOrUrl: video, maxFrames: 0, transcript: false }] },
    });
    const result = firstVideo<{ status: string; frameCount: number; manifestPath: string }>(content);
    expect(result.status).toBe('ok');
    expect(result.frameCount).toBe(0);
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as { processing: { frameMode: string } };
    expect(manifest.processing.frameMode).toBe('none');
    await client.close();
  }, 30_000);

  it('an explicit frames value wins over maxFrames: 0 (Fix 3 nuance): "even" is not silently downgraded to "none"', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-explicit-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 6);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-explicit-'));
    const client = await connectClient(buildServer());
    const content = await callToolOk(client, {
      name: 'analyze_video',
      arguments: { destinationPath: destDir, videos: [{ pathOrUrl: video, frames: 'even', maxFrames: 0, transcript: false }] },
    });
    const result = firstVideo<{ status: string; manifestPath: string }>(content);
    expect(result.status).toBe('ok');
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as { processing: { frameMode: string } };
    expect(manifest.processing.frameMode).toBe('even');
    await client.close();
  }, 30_000);

  it('accepts a syntactically valid call and runs the REAL handler through a clean early-failure path (no network, no models)', async () => {
    // Deliberately does not exercise the full pipeline (model loading,
    // downloads) -- analyzeVideo's own step 1 is resolve(), and a
    // nonexistent local-looking path (ending in a media extension, so
    // DirectMediaResolver claims it) fails there in ~tens of ms: Node's
    // fetch() throws synchronously on a non-absolute-URL string, no socket
    // ever opens (verified: see task-16-report.md). This still proves real,
    // non-stubbed wiring end to end: the handler must actually call
    // analyzeVideoTool/analyzeVideo (not fabricate a result) for the
    // manifest written to disk to carry this exact pathOrUrl back out as
    // source.url.
    const client = await connectClient(buildServer());
    const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-fail-'));
    const badPath = join(tmpdir(), 'norma-mcp-test-does-not-exist', 'nope.mp4');
    const content = await callToolOk(client, {
      name: 'analyze_video',
      arguments: { destinationPath: dir, videos: [{ pathOrUrl: badPath }] },
    });
    const result = firstVideo<{
      status: string; frameCount: number; framePaths: unknown[]; warnings: unknown[]; manifestPath: string;
    }>(content);
    expect(result.status).not.toBe('ok');
    expect(result.frameCount).toBe(0);
    expect(result.framePaths).toEqual([]);
    expect(result.warnings).toEqual([]);
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as { source: { url: string } };
    expect(manifest.source.url).toBe(badPath);
    await client.close();
  }, 15_000);

  it('cleans up the working directory without breaking the coarse-to-fine handoff (Fix 6, deferred #18 leak half)', async () => {
    // A REAL local-source, default-frame-mode ('key') call end to end --
    // exactly the scenario deferred #18 describes: analyzeVideo runs against
    // its own private mkdtempSync'd directory (outDir left unset for a local
    // source) and leaves a re-encoded work.mp4 behind there once done. This
    // is the brief's own explicit test: every path the REPLY and the
    // MANIFEST point at must still exist afterward -- that is what stops
    // the cleanup from deleting a file either one still references. The
    // "leak is actually fixed" half (the ephemeral copy itself is gone) is
    // proven at the unit level in tests/analyzeTool.test.ts, which has
    // visibility into the ephemeral path a real end-to-end call does not.
    const srcDir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-cleanup-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 6);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-cleanup-'));
    const client = await connectClient(buildServer());
    const content = await callToolOk(client, {
      name: 'analyze_video',
      arguments: { destinationPath: destDir, videos: [{ pathOrUrl: video, maxFrames: 2, transcript: false }] },
    });
    const result = firstVideo<{
      status: string; videoPath?: string; framePaths: string[]; manifestPath: string;
    }>(content);
    expect(result.status).toBe('ok');
    // The local source itself: never duplicated, never destroyed.
    expect(result.videoPath).toBe(video);
    expect(existsSync(result.videoPath!)).toBe(true);
    // Every frame thumbnail the reply names.
    expect(result.framePaths.length).toBeGreaterThan(0);
    for (const p of result.framePaths) expect(existsSync(p)).toBe(true);
    // And the manifest on disk agrees with the reply, not just the reply
    // with itself.
    expect(existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
      source: { filePath?: string }; frames: Array<{ image: string }>;
    };
    expect(manifest.source.filePath).toBe(video);
    for (const f of manifest.frames) expect(existsSync(f.image)).toBe(true);
    await client.close();
  }, 60_000);
});

describe('v0.2 batch schema', () => {
  it('rejects an empty videos array', async () => {
    const client = await connectClient(buildServer());
    const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-batch-empty-'));
    const content = await callToolExpectError(client, {
      name: 'analyze_video',
      arguments: { destinationPath: dir, videos: [] },
    });
    // Not just isError:true (callToolExpectError already asserts that) --
    // the message should actually be about the empty array, not some other
    // validation failure it coincidentally also triggers.
    expect(firstText(content).toLowerCase()).toContain('videos');
    await client.close();
  });

  it('rejects a call missing destinationPath', async () => {
    const client = await connectClient(buildServer());
    const content = await callToolExpectError(client, {
      name: 'analyze_video',
      arguments: { videos: [{ pathOrUrl: 'https://x/v' }] },
    });
    expect(firstText(content)).toContain('destinationPath');
    await client.close();
  });

  it('N=1 layout is byte-identical to 0.1.0: manifest.json at destinationPath root', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'norma-mcp-n1-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 6);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-mcp-n1-'));
    const client = await connectClient(buildServer());
    await callToolOk(client, {
      name: 'analyze_video',
      arguments: { destinationPath: destDir, videos: [{ pathOrUrl: video, frames: 'even', maxFrames: 1, transcript: false }] },
    });
    // Literal path, not read back from the reply's own manifestPath field --
    // this is checking the actual on-disk LOCATION the N=1 flat layout
    // promises, independent of whatever the reply claims about itself.
    expect(existsSync(join(destDir, 'manifest.json'))).toBe(true);
    await client.close();
  }, 30_000);

  it('N=2 produces video-1/ and video-2/ with independent manifests', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'norma-mcp-n2-src-'));
    // Distinct durations so the two manifests can only agree by actually
    // being independent, not by one silently overwriting or aliasing the
    // other (mirrors tests/analyzeTool.test.ts's own N=2 discriminator).
    const videoA = await makeTestVideo(join(srcDir, 'a.mp4'), 6);
    const videoB = await makeTestVideo(join(srcDir, 'b.mp4'), 3);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-mcp-n2-'));
    const client = await connectClient(buildServer());
    const content = await callToolOk(client, {
      name: 'analyze_video',
      arguments: {
        destinationPath: destDir,
        videos: [
          { pathOrUrl: videoA, frames: 'even', maxFrames: 1, transcript: false },
          { pathOrUrl: videoB, frames: 'even', maxFrames: 1, transcript: false },
        ],
      },
    });
    const parsed = JSON.parse(firstText(content)) as {
      videos: Array<{ status: string; manifestPath: string; duration: number }>;
    };
    expect(parsed.videos).toHaveLength(2);
    expect(parsed.videos[0]!.manifestPath).toBe(join(destDir, 'video-1', 'manifest.json'));
    expect(parsed.videos[1]!.manifestPath).toBe(join(destDir, 'video-2', 'manifest.json'));
    expect(existsSync(parsed.videos[0]!.manifestPath)).toBe(true);
    expect(existsSync(parsed.videos[1]!.manifestPath)).toBe(true);
    expect(parsed.videos[0]!.status).toBe('ok');
    expect(parsed.videos[1]!.status).toBe('ok');
    const m1 = JSON.parse(readFileSync(parsed.videos[0]!.manifestPath, 'utf8')) as { source: { duration: number } };
    const m2 = JSON.parse(readFileSync(parsed.videos[1]!.manifestPath, 'utf8')) as { source: { duration: number } };
    expect(m1.source.duration).not.toBe(m2.source.duration); // kills the shared-directory mutant
    await client.close();
  }, 60_000);
});

describe('resolve_video is exempt from the analyze pool (spec §6)', () => {
  it('a metadata-only resolve completes while the cap-1 pool is fully occupied', async () => {
    // A cap-1 pool whose slot we hold well past resolve_video's own
    // plain-call floor: EVERY plain call against a taskSupport:'optional'
    // tool takes at least ~1 pollInterval end to end, because the server's
    // automatic task-polling wrapper (handleAutomaticTaskPolling in
    // server/mcp.js -- see task-1-report.md) sleeps a full pollInterval
    // before its first status check, regardless of how fast the underlying
    // work actually finishes. Final whole-branch review, Important finding
    // 2: src/mcp.ts's own createTask calls now pass pollInterval: 150
    // (down from the store's 1000ms default), so that floor is ~150ms, not
    // ~1000ms, as of this branch -- HOLD_PAD_MS pads the REAL analyze work
    // (which may itself finish in well under a second on a tiny local
    // video with frames:'even', which loads no vision model) by a further
    // 2500ms after it settles, so the pool slot stays occupied for a
    // duration that cannot plausibly race resolve_video's own ~150-300ms
    // floor, independent of real pipeline/model-load speed on whatever
    // machine runs this.
    const HOLD_PAD_MS = 2500;
    const inner = createSlotPool(1);
    const pool: SlotPool = {
      get running() { return inner.running; },
      get queued() { return inner.queued; },
      cap: inner.cap,
      run: (fn, onQueued) => inner.run(async () => {
        const r = await fn();
        await new Promise((res) => setTimeout(res, HOLD_PAD_MS));
        return r;
      }, onQueued),
    };
    const server = buildServer({ analyzeSlots: pool });
    const client = await connectClient(server);

    const srcDir = mkdtempSync(join(tmpdir(), 'norma-mcp-exempt-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 3);
    const analyzeDir = mkdtempSync(join(tmpdir(), 'norma-mcp-exempt-av-'));

    let analyzeDone = false;
    const analyzePromise = callToolOk(client, {
      name: 'analyze_video',
      arguments: { destinationPath: analyzeDir, videos: [{ pathOrUrl: video, frames: 'even', maxFrames: 1, transcript: false }] },
    }).then((c) => { analyzeDone = true; return c; });

    // Give the detached task executor a moment to synchronously reach
    // pool.run() (a handful of microtask hops behind createTask's own
    // await, well under this) and genuinely acquire the slot before this
    // test goes looking for it -- not a race against the assertions below
    // (those are protected by HOLD_PAD_MS), just making sure the slot is
    // demonstrably held first.
    await new Promise((res) => setTimeout(res, 100));
    expect(pool.running).toBe(1);

    const resolveDir = mkdtempSync(join(tmpdir(), 'norma-mcp-exempt-rv-'));
    const resolveContent = await callToolOk(client, {
      name: 'resolve_video',
      arguments: { destinationPath: resolveDir, videos: [{ url: video }] },
    });

    // LOAD-BEARING: pool.running is still 1 (analyze's slot has not been
    // released) at the moment resolve's call returns. A mutant that routes
    // resolve_video through the same pool could only return AFTER queueing
    // behind analyze (cap 1, already fully occupied) and waiting for its
    // slot to free -- which is exactly what HOLD_PAD_MS makes impossible to
    // finish before this read, so a routed-through-pool mutant would
    // observe running:0 here instead. analyzeDone/queued are corroborating,
    // not load-bearing on their own (a mutant could in principle still
    // clear queued back to 0 by the time resolve's own poll notices), but
    // all three failing together is a stronger signal than any one alone.
    expect(pool.running).toBe(1);
    expect(analyzeDone).toBe(false);
    expect(pool.queued).toBe(0);

    const parsed = JSON.parse(firstText(resolveContent)) as { videos: Array<{ status: string }> };
    expect(parsed.videos[0]!.status).toBe('ok');

    await analyzePromise; // let the held slot drain so the test exits cleanly
    await client.close();
  }, 30_000);
});

describe('plain calls gate through the slot pool (spec §12.2 -- the queue-bypass mutant)', () => {
  it('two concurrent plain analyze calls on a cap-1 injected pool never overlap', async () => {
    const events: string[] = [];
    const inner = createSlotPool(1);
    const spy: SlotPool = {
      get running() { return inner.running; }, get queued() { return inner.queued; }, cap: inner.cap,
      run: (fn, onQ) => inner.run(async () => { events.push('start'); const r = await fn(); events.push('end'); return r; }, onQ),
    };
    const server = buildServer({ analyzeSlots: spy });
    const client = await connectClient(server);

    const srcDir = mkdtempSync(join(tmpdir(), 'norma-mcp-gate-src-'));
    const videoA = await makeTestVideo(join(srcDir, 'a.mp4'), 3);
    const videoB = await makeTestVideo(join(srcDir, 'b.mp4'), 3);

    async function callAnalyze(c: Client, pathOrUrl: string): Promise<CallToolResult['content']> {
      const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-gate-av-'));
      return callToolOk(c, {
        name: 'analyze_video',
        arguments: { destinationPath: dir, videos: [{ pathOrUrl, frames: 'even', maxFrames: 1, transcript: false }] },
      });
    }

    await Promise.all([callAnalyze(client, videoA), callAnalyze(client, videoB)]);
    expect(events).toEqual(['start', 'end', 'start', 'end']);   // strictly sequential
    await client.close();
  }, 30_000);
});

describe('status channel wiring (Task 4)', () => {
  /** Shape of client.experimental.tasks.callToolStream()'s yielded messages,
   *  narrowed to the fields these tests read -- mirrors
   *  tests/taskLifecycle.test.ts's own inline StreamMsg alias. */
  type StreamMsg = {
    type: string;
    task?: { taskId: string; status: string; statusMessage?: string };
    result?: { content: Array<{ type: string; text: string }> };
  };

  it('task handle reply carries the status url; completed result echoes it; endpoint lists the item; destinationPath holds only expected artifacts', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'norma-mcp-status-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 3);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-mcp-status-'));
    const server = buildServer({ statusPort: 0 });
    const client = await connectClient(server);
    // callToolStream needs the client's own task-tool cache populated first
    // -- client.experimental.tasks.isToolTask() reads _cachedKnownTaskTools,
    // populated only by listTools() (tests/taskLifecycle.test.ts's own
    // documented gate). This file's shared connectClient deliberately omits
    // this call (its ~20 other tests only ever make plain client.callTool()
    // calls, which need no such cache per task-1-report.md's fact (a)), so
    // it is called here inline instead of widening that shared helper.
    await client.listTools();

    const stream = client.experimental.tasks.callToolStream({
      name: 'analyze_video',
      arguments: { destinationPath: destDir, videos: [{ pathOrUrl: video, frames: 'even', maxFrames: 1, transcript: false }] },
    }) as AsyncGenerator<StreamMsg>;
    const first = await stream.next();
    const firstMsg = first.value as StreamMsg;
    expect(firstMsg.type).toBe('taskCreated');
    // src/mcp.ts's createTask handler stamps this BEFORE the background
    // executor even starts (see its own comment for why), so this is
    // deterministic, not a race against the executor's first real
    // statusMessage update.
    expect(firstMsg.task?.statusMessage).toMatch(/^status: http:\/\/127\.0\.0\.1:\d+\/status$/);

    let finalContent: Array<{ type: string; text: string }> | undefined;
    for await (const msg of stream) {
      if (msg.type === 'result') finalContent = msg.result!.content;
    }
    expect(finalContent).toBeDefined();
    const parsed = JSON.parse(finalContent![0]!.text) as {
      videos: Array<{ status: string }>; statusUrl: string | null;
    };
    // Top-level, not per-item: toResult(r, statusUrl) spreads it alongside `videos`.
    expect(parsed.statusUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/status$/);
    expect(parsed.videos[0]!.status).toBe('ok');

    const body = await (await fetch(parsed.statusUrl!)).json() as {
      items: Array<{ url: string; tool: string; outcome?: { status: string } }>;
    };
    const item = body.items.find((i) => i.url === video);
    expect(item).toBeDefined();
    expect(item!.tool).toBe('analyze');
    expect(item!.outcome?.status).toBe('ok');

    // §10 "registry writes a file per transition" mutant guard: with a
    // local source, frames:'even', maxFrames:1, transcript:false, the ONLY
    // artifacts this call can legitimately produce under destinationPath
    // are the manifest and its relocated frame image(s) -- flat, basename
    // preserved (src/agent/analyzeTool.ts's relocateFrame; the local source
    // itself is never copied in, and transcript:false means no
    // transcript.json). A registry that wrote a status file per stage
    // transition anywhere under destinationPath fails this.
    const entries = readdirSync(destDir);
    expect(entries.length).toBeGreaterThan(0);
    for (const name of entries) expect(name).toMatch(/^manifest\.json$|^even_\d{4}\.jpg$/);

    await client.close();
  }, 30_000);

  it('statusPort null disables the endpoint: no status prefix, statusUrl null, and nothing is listening', async () => {
    const server = buildServer({ statusPort: null });
    const client = await connectClient(server);
    await client.listTools();
    const badPath = join(tmpdir(), 'norma-mcp-status-disabled-does-not-exist', 'nope.mp4');

    // Plain call: statusUrl must be null in the result, regardless of the item's own outcome.
    const dir1 = mkdtempSync(join(tmpdir(), 'norma-mcp-status-disabled-'));
    const content = await callToolOk(client, {
      name: 'analyze_video',
      arguments: { destinationPath: dir1, videos: [{ pathOrUrl: badPath }] },
    });
    const parsed = JSON.parse(firstText(content)) as { statusUrl: string | null };
    expect(parsed.statusUrl).toBeNull();

    // Task mode: the taskCreated statusMessage must not carry a status:
    // prefix -- it should be whatever InMemoryTaskStore.createTask leaves it
    // as (undefined) rather than this wiring stamping one in.
    const dir2 = mkdtempSync(join(tmpdir(), 'norma-mcp-status-disabled2-'));
    const stream = client.experimental.tasks.callToolStream({
      name: 'analyze_video',
      arguments: { destinationPath: dir2, videos: [{ pathOrUrl: badPath }] },
    }) as AsyncGenerator<StreamMsg>;
    const first = await stream.next();
    const firstMsg = first.value as StreamMsg;
    expect(firstMsg.type).toBe('taskCreated');
    expect(firstMsg.task?.statusMessage ?? '').not.toMatch(/^status:/);
    for await (const _msg of stream) { /* drain so nothing is left dangling */ }

    await client.close();
  }, 15_000);

  it('a queued-then-cancelled batch eventually finishes its registry entries as wrapper_failed -- not a permanent gap (review fix)', async () => {
    // Coordinator review finding: src/mcp.ts's ids.forEach(...finish(...,
    // 'wrapper_failed')) blocks had ZERO test coverage -- deleting both left
    // every pre-existing test green. This pins the mechanism directly: a
    // saturated cap-1 pool, a 2-item batch cancelled while fully queued
    // (both items, so the forEach is proven to cover every registered id,
    // not just the first), and a BOUNDED POLL (never a fixed sleep, so this
    // cannot flake on a slow machine) proving the registry entries
    // EVENTUALLY reach outcome.status:'wrapper_failed' once the pool drains
    // far enough for each item to reach its own slot and checkCancelled()
    // to fire -- exactly the "eventual, self-healing, not a permanent
    // ghost" behavior the reworded .catch() comment now documents (the
    // earlier wording overstated immediacy/permanence -- see the task
    // report's fix round).
    const HOLD_PAD_MS = 1200;
    const inner = createSlotPool(1);
    const pool: SlotPool = {
      get running() { return inner.running; },
      get queued() { return inner.queued; },
      cap: inner.cap,
      run: (fn, onQueued) => inner.run(async () => {
        const r = await fn();
        await new Promise((res) => setTimeout(res, HOLD_PAD_MS));
        return r;
      }, onQueued),
    };
    const server = buildServer({ statusPort: 0, analyzeSlots: pool });
    const client = await connectClient(server);
    await client.listTools();

    // Task A: occupies the pool's only slot for HOLD_PAD_MS after its own
    // near-instant (fast-failing local path) work resolves.
    const badA = join(tmpdir(), 'norma-mcp-wf-a-does-not-exist', 'nope.mp4');
    const destA = mkdtempSync(join(tmpdir(), 'norma-mcp-wf-a-'));
    const streamA = client.experimental.tasks.callToolStream({
      name: 'analyze_video',
      arguments: { destinationPath: destA, videos: [{ pathOrUrl: badA }] },
    }) as AsyncGenerator<StreamMsg>;
    const firstA = await streamA.next();
    expect((firstA.value as StreamMsg).type).toBe('taskCreated');
    // Give the detached task executor a moment to synchronously reach
    // pool.run() and genuinely acquire the slot (this file's own
    // established precedent -- see "resolve_video is exempt..." above).
    await new Promise((res) => setTimeout(res, 100));
    expect(pool.running).toBe(1);

    // Task B: a 2-item batch submitted while A holds the only slot -- both
    // items genuinely queue, neither starts. Queueing decisions happen
    // synchronously inside pool.run(), before createTask's own handler
    // returns (this file's "a queued task cancels fully" precedent in
    // tests/taskLifecycle.test.ts), so this is deterministic, not a race.
    const badB1 = join(tmpdir(), 'norma-mcp-wf-b1-does-not-exist', 'nope.mp4');
    const badB2 = join(tmpdir(), 'norma-mcp-wf-b2-does-not-exist', 'nope.mp4');
    const destB = mkdtempSync(join(tmpdir(), 'norma-mcp-wf-b-'));
    const streamB = client.experimental.tasks.callToolStream({
      name: 'analyze_video',
      arguments: { destinationPath: destB, videos: [{ pathOrUrl: badB1 }, { pathOrUrl: badB2 }] },
    }) as AsyncGenerator<StreamMsg>;
    const firstB = await streamB.next();
    const firstBMsg = firstB.value as StreamMsg;
    expect(firstBMsg.type).toBe('taskCreated');
    const taskIdB = firstBMsg.task!.taskId;
    expect(pool.queued).toBe(2);

    const urlMatch = /^status: (http:\/\/127\.0\.0\.1:\d+\/status)$/.exec(firstBMsg.task?.statusMessage ?? '');
    expect(urlMatch).not.toBeNull();
    const statusUrl = urlMatch![1]!;

    // Cancel B while fully queued -- accepted (store.executing has no entry
    // for B yet; neither item has started).
    const cancelOutcome = await client.experimental.tasks.cancelTask(taskIdB).then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, e: String(e) }),
    );
    expect(cancelOutcome.ok).toBe(true);

    // Immediately after cancellation, B's registry entries are NOT yet
    // finished -- still outcome: undefined, indistinguishable from a
    // healthy queued item, because A still holds the pool's only slot. This
    // is the transient STALE window the reworded .catch() comment now
    // documents explicitly, instead of the earlier "permanent ghost" framing
    // the review found overstated.
    const soonBody = await (await fetch(statusUrl)).json() as {
      items: Array<{ url: string; outcome?: { status: string } }>;
    };
    const soonB = soonBody.items.filter((i) => i.url === badB1 || i.url === badB2);
    expect(soonB).toHaveLength(2);
    for (const item of soonB) expect(item.outcome).toBeUndefined();

    // Bounded-retry poll (never a fixed sleep) until the pool drains past A,
    // B's queued items are promoted, each individually detects the
    // cancellation via checkCancelled(), and the .catch() finishes ALL of
    // B's registered ids -- proving the mechanism actually fires, not
    // merely that no prior test happened to exercise it.
    let finalItems: Array<{ url: string; outcome?: { status: string } }> = [];
    for (let i = 0; i < 100; i++) {
      const body = await (await fetch(statusUrl)).json() as {
        items: Array<{ url: string; outcome?: { status: string } }>;
      };
      finalItems = body.items.filter((it) => it.url === badB1 || it.url === badB2);
      if (finalItems.length === 2 && finalItems.every((it) => it.outcome !== undefined)) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(finalItems).toHaveLength(2);
    for (const item of finalItems) expect(item.outcome?.status).toBe('wrapper_failed');

    // Drain A to its own natural completion so nothing lingers.
    for await (const _msg of streamA) { /* drain to completion */ }
    await client.close();
  }, 30_000);
});
