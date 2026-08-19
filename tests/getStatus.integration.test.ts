import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { createResultStore } from '../src/agent/resultStore.js';

/**
 * Recovering a result after the client stopped waiting.
 *
 * The failure this exists for is real and was observed in a client's own MCP
 * log: it sends `notifications/cancelled` when its wall-clock limit expires
 * and moves on, while the server keeps working. The analysis finishes, the
 * files are written, and the reply has nowhere to go.
 *
 * Looked up by the VIDEO, not by an id the caller had to invent beforehand.
 * Recovery matters exactly when nobody prepared for it, and the url or path
 * is required on every call, so a caller cannot fail to have one.
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

const payload = (r: unknown): Record<string, unknown> =>
  JSON.parse(((r as { content: Array<{ text: string }> }).content[0]!).text) as Record<string, unknown>;
const lookup = (r: unknown): Array<Record<string, unknown>> =>
  payload(r)['videos'] as Array<Record<string, unknown>>;

const URL_A = 'https://example.invalid/a';
const URL_B = 'https://example.invalid/b';

describe('get_status', () => {
  it('returns a finished video\'s result under the URL it was asked for', async () => {
    fakeYtDlp();
    const client = await connect();
    const dest = mkdtempSync(join(tmpdir(), 'vem-gsdest-'));

    const original = await client.callTool({
      name: 'resolve_video',
      arguments: { destinationPath: dest, videos: [{ url: URL_A }] },
    });

    const found = lookup(await client.callTool({ name: 'get_status', arguments: { videos: [URL_A] } }))[0]!;

    expect(found['url']).toBe(URL_A);
    expect(found['state']).toBe('finished');
    // The item's own result, identical to what the original call returned for
    // it: a lookup that rebuilt the reply could drift from the real one.
    const originalItem = (payload(original)['videos'] as unknown[])[0];
    const results = found['results'] as Array<{ result: unknown }>;
    expect(results[0]!.result).toEqual(originalItem);
    await client.close();
  }, 60_000);

  it('needs nothing to have been prepared in advance', async () => {
    // The whole point of keying on the video: this call passes no id, no
    // handle, nothing -- exactly like a caller who did not know it would need
    // to recover anything.
    fakeYtDlp();
    const client = await connect();
    const dest = mkdtempSync(join(tmpdir(), 'vem-gsdest2-'));
    await client.callTool({ name: 'resolve_video', arguments: { destinationPath: dest, videos: [{ url: URL_A }] } });

    const found = lookup(await client.callTool({ name: 'get_status', arguments: { videos: [URL_A] } }))[0]!;
    expect(found['state']).toBe('finished');
    await client.close();
  }, 60_000);

  it('recovers an analyze_video result too, not just resolve_video', async () => {
    // analyze_video is the tool that actually gets timed out -- it is the one
    // that takes minutes -- so recovery has to work there, and a test that
    // only exercised resolve_video would let that rot.
    const { makeTestVideo } = await import('../src/media/ffmpeg.js');
    const client = await connect();
    const src = mkdtempSync(join(tmpdir(), 'vem-gsvid-'));
    const video = await makeTestVideo(join(src, 'v.mp4'), 1);
    const dest = mkdtempSync(join(tmpdir(), 'vem-gsdesta-'));

    const original = await client.callTool({
      name: 'analyze_video',
      arguments: { destinationPath: dest, videos: [{ pathOrUrl: video, frames: 'none', transcript: false }] },
    });

    // Looked up by the LOCAL PATH, which is what was passed -- the tool takes
    // either, so recovery must accept either.
    const found = lookup(await client.callTool({ name: 'get_status', arguments: { videos: [video] } }))[0]!;
    expect(found['state']).toBe('finished');
    const results = found['results'] as Array<{ tool: string; result: unknown }>;
    expect(results[0]!.tool).toBe('analyze');
    expect(results[0]!.result).toEqual((payload(original)['videos'] as unknown[])[0]);
    await client.close();
  }, 120_000);

  it('reports a video it has never seen as unknown, and points at the files', async () => {
    // Never-asked-for, expired, and belonging-to-a-restarted-server are
    // genuinely indistinguishable here, so the answer must not pick one --
    // and must say where the durable result actually lives.
    const client = await connect();
    const found = lookup(await client.callTool({ name: 'get_status', arguments: { videos: ['https://nope.invalid/x'] } }))[0]!;

    expect(found['state']).toBe('unknown');
    expect(found['note']).toMatch(/expired/i);
    expect(found['note']).toMatch(/restarted/i);
    expect(found['note']).toMatch(/destinationPath/);
    await client.close();
  }, 30_000);

  it('answers several videos in one call, mixing known and unknown', async () => {
    fakeYtDlp();
    const client = await connect();
    const dest = mkdtempSync(join(tmpdir(), 'vem-gsdest3-'));
    await client.callTool({ name: 'resolve_video', arguments: { destinationPath: dest, videos: [{ url: URL_A }] } });

    const found = lookup(await client.callTool({ name: 'get_status', arguments: { videos: [URL_A, URL_B] } }));

    expect(found.length).toBe(2);
    expect(found[0]!['state']).toBe('finished');
    expect(found[1]!['state']).toBe('unknown');
    await client.close();
  }, 60_000);

  it('matches the URL exactly as given, without inventing equivalences', async () => {
    // youtu.be and youtube.com forms, or a stripped ?si= parameter, would be
    // a guess about which video is meant. Answering about the wrong one is
    // worse than answering "unknown".
    fakeYtDlp();
    const client = await connect();
    const dest = mkdtempSync(join(tmpdir(), 'vem-gsdest4-'));
    await client.callTool({ name: 'resolve_video', arguments: { destinationPath: dest, videos: [{ url: URL_A }] } });

    const found = lookup(await client.callTool({ name: 'get_status', arguments: { videos: [`${URL_A}?si=tracking`] } }))[0]!;
    expect(found['state']).toBe('unknown');
    await client.close();
  }, 60_000);

  it('leaves both tools\' replies exactly as they were', async () => {
    // Purely additive: nothing about an ordinary call changed shape.
    fakeYtDlp();
    const client = await connect();
    const dest = mkdtempSync(join(tmpdir(), 'vem-gsdest5-'));
    const r = await client.callTool({ name: 'resolve_video', arguments: { destinationPath: dest, videos: [{ url: URL_A }] } });
    expect(Object.keys(payload(r)).sort()).toEqual(['statusUrl', 'videos']);
    await client.close();
  }, 60_000);
});

describe('the result store itself', () => {
  it('keeps both results when the same video is analyzed twice', () => {
    // Legitimate: the same video at different ranges or frame settings.
    // Replacing would lose a result the caller may still ask for.
    const s = createResultStore(0);
    s.record(URL_A, 'analyze', { first: true });
    s.record(URL_A, 'analyze', { second: true });

    expect(s.get(URL_A).map((r) => r.result)).toEqual([{ first: true }, { second: true }]);
  });

  it('expires a record once the TTL has passed', () => {
    let clock = 1_000;
    const s = createResultStore(100, () => clock);
    s.record(URL_A, 'resolve', { ok: true });
    expect(s.get(URL_A).length).toBe(1);
    clock += 101;
    expect(s.get(URL_A).length).toBe(0);
  });

  it('never expires anything when the TTL is 0', () => {
    let clock = 0;
    const s = createResultStore(0, () => clock);
    s.record(URL_A, 'resolve', { ok: true });
    clock += 10 ** 9;
    expect(s.get(URL_A).length).toBe(1);
  });
});
