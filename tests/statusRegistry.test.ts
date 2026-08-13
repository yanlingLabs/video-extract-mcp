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
