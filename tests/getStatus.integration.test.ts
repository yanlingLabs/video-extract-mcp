import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { createCallStore } from '../src/agent/callStore.js';

/**
 * Recovering a result after the client stopped waiting.
 *
 * The failure this exists for is real and was observed in a client's own MCP
 * log: it sends `notifications/cancelled` when its wall-clock limit expires
 * and moves on, while the server keeps working. The analysis finishes, the
 * files are written, and the reply has nowhere to go.
 *
 * The id has to come from the CALLER. A server-minted id would be handed back
 * in the reply, which is exactly what was lost.
 */

let prevPath: string | undefined;
afterEach(() => {
  if (prevPath !== undefined) process.env['PATH'] = prevPath;
  prevPath = undefined;
});

/** Fake yt-dlp so nothing touches the network. */
function fakeYtDlp(): void {
  const binDir = mkdtempSync(join(tmpdir(), 'vem-gsbin-'));
  writeFileSync(join(binDir, 'yt-dlp'), [
    '#!/bin/sh',
    `echo '{"title":"fake","duration":5,"extractor":"youtube","requested_subtitles":null}'`,
    'exit 0',
  ].join('\n'));
  chmodSync(join(binDir, 'yt-dlp'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

async function connect(): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = buildServer({ statusPort: null });
  await server.connect(b);
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
  await client.connect(a);
  return client;
}

const parse = (r: unknown): { calls: Array<Record<string, unknown>> } =>
  JSON.parse(((r as { content: Array<{ text: string }> }).content[0]!).text) as { calls: Array<Record<string, unknown>> };

describe('get_status', () => {
  it('hands back the finished call under the id the CALLER chose', async () => {
    fakeYtDlp();
    const client = await connect();
    const dest = mkdtempSync(join(tmpdir(), 'vem-gsdest-'));
    const callId = 'my-own-id-abc123';

    const original = await client.callTool({
      name: 'resolve_video',
      arguments: { destinationPath: dest, callId, videos: [{ url: 'https://example.invalid/v' }] },
    });

    const looked = await client.callTool({ name: 'get_status', arguments: { callIds: [callId] } });
    const c = parse(looked).calls[0]! as { callId: string; calls: Array<{ state: string; result: unknown }> };

    expect(c.callId).toBe(callId);
    expect(c.calls[0]!.state).toBe('finished');
    // Byte-identical to what the original call returned: a lookup that
    // reconstructed the reply could drift from the real one.
    const originalPayload = JSON.parse(((original as { content: Array<{ text: string }> }).content[0]!).text) as unknown;
    expect(c.calls[0]!.result).toEqual(originalPayload);
    await client.close();
  }, 60_000);

  it('reports an id it has never seen as unknown, and points at the files', async () => {
    // Never-seen, expired, and belonging-to-a-restarted-server are genuinely
    // indistinguishable here, so the answer must not pick one -- and must say
    // where the durable result actually lives.
    const client = await connect();
    const r = await client.callTool({ name: 'get_status', arguments: { callIds: ['no-such-id'] } });
    const c = parse(r).calls[0]! as { state: string; note: string };

    expect(c.state).toBe('unknown');
    expect(c.note).toMatch(/expired/i);
    expect(c.note).toMatch(/restarted/i);
    expect(c.note).toMatch(/destinationPath/);
    await client.close();
  }, 30_000);

  it('answers several ids in one call, mixing known and unknown', async () => {
    fakeYtDlp();
    const client = await connect();
    const dest = mkdtempSync(join(tmpdir(), 'vem-gsdest2-'));
    await client.callTool({
      name: 'resolve_video',
      arguments: { destinationPath: dest, callId: 'known-1', videos: [{ url: 'https://example.invalid/a' }] },
    });

    const r = await client.callTool({ name: 'get_status', arguments: { callIds: ['known-1', 'missing-2'] } });
    const calls = parse(r).calls;

    expect(calls.length).toBe(2);
    expect(calls[0]!['callId']).toBe('known-1');
    expect(calls[1]!['state']).toBe('unknown');
    await client.close();
  }, 60_000);

  it('leaves the tool reply unchanged when no callId is passed', async () => {
    // Additive: a caller that ignores this feature must see exactly what it
    // saw before.
    fakeYtDlp();
    const client = await connect();
    const dest = mkdtempSync(join(tmpdir(), 'vem-gsdest3-'));
    const r = await client.callTool({
      name: 'resolve_video',
      arguments: { destinationPath: dest, videos: [{ url: 'https://example.invalid/v' }] },
    });
    const payload = JSON.parse(((r as { content: Array<{ text: string }> }).content[0]!).text) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(['statusUrl', 'videos']);
    await client.close();
  }, 60_000);
});

describe('the call store itself', () => {
  it('keeps a reused id as separate records rather than overwriting', () => {
    // Overwriting would silently discard a result the caller may still ask
    // for; merging would invent a call that never happened.
    const s = createCallStore(0);
    s.start('dup', 'resolve');
    s.finish('dup', { first: true });
    s.start('dup', 'analyze');
    s.finish('dup', { second: true });

    const got = s.get('dup');
    expect(got.length).toBe(2);
    expect(got.map((r) => r.reply)).toEqual([{ first: true }, { second: true }]);
  });

  it('expires a record only after it FINISHED, never mid-flight', () => {
    // TTL from completion: a long call must not expire while it is still
    // running, which is exactly the case this feature exists to serve.
    let clock = 1_000;
    const s = createCallStore(100, () => clock);
    s.start('slow', 'analyze');
    clock += 10_000;                       // far past the TTL, still running
    expect(s.get('slow').length).toBe(1);

    s.finish('slow', { done: true });
    expect(s.get('slow').length).toBe(1);  // fresh
    clock += 101;
    expect(s.get('slow').length).toBe(0);  // now expired
  });

  it('never expires anything when the TTL is 0', () => {
    let clock = 0;
    const s = createCallStore(0, () => clock);
    s.start('keep', 'resolve');
    s.finish('keep', { ok: true });
    clock += 10 ** 9;
    expect(s.get('keep').length).toBe(1);
  });
});
