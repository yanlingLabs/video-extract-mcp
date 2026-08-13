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

  it('a throwing onStage callback is swallowed structurally -- callbacks are wrapped at runWithStatus() establishment, so a bare resolver-style read never throws', async () => {
    // Resolvers (src/resolve/*.ts) call statusCallbacks()?.onStage?.('downloading')
    // with no local try/catch of their own -- the exact shape reproduced here.
    // If the guarantee lived only at each reader (run.ts's own try/catch, as
    // it did before this fix), this bare call would throw straight through
    // and (in a real resolver) land in that resolver's own catch, turning a
    // successful download into a synthetic extractor_failed result. Pinning
    // it here, independent of run()/child_process entirely, proves the fix
    // is structural: ANY reader gets a non-throwing callback by construction.
    await runWithStatus(
      { onStage: () => { throw new Error('reporting must never break work'); } },
      async () => {
        expect(() => statusCallbacks()?.onStage?.('downloading')).not.toThrow();
      },
    );
  });
});
