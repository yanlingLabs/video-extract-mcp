import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync, writeFileSync as fsWriteFileSync, renameSync as fsRenameSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { discoveryPath, registerServer, unregisterServer, liveServers, type ServerEntry } from '../src/status/discovery.js';

// Passthrough mock, same idiom as tests/analyze.integration.test.ts: every
// real fs call behaves identically for every OTHER test in this file
// (mkdtempSync, readFileSync, writeFileSync, statSync all still hit the
// real filesystem), but writeFileSync/renameSync are additionally spy-
// wrapped so the write-mechanism test below can inspect exactly which
// paths discovery.ts's internals actually wrote to, without needing any
// export beyond the four the brief's interface specifies.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, writeFileSync: vi.fn(real.writeFileSync), renameSync: vi.fn(real.renameSync) };
});

/** VIDEO_EXTRACT_CACHE_DIR is TEST-FACING (see discovery.ts's own doc
 *  comment on discoveryPath): every test in this file uses it to point the
 *  whole discovery file at a throwaway mkdtemp directory, so nothing here
 *  ever reads or writes the real machine's home directory. */
function freshCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vem-discovery-'));
  vi.stubEnv('VIDEO_EXTRACT_CACHE_DIR', dir);
  return dir;
}

const entry = (over: Partial<ServerEntry> = {}): ServerEntry => (
  { pid: process.pid, port: 4321, startedAt: Date.now(), version: '0.3.0', ...over }
);

// Deliberately NOT vi.restoreAllMocks()/vi.resetAllMocks(): both would tear
// down the vi.mock('node:fs', ...) passthrough above (it isn't a
// vi.spyOn-backed mock, so "restore" has no original to fall back to and
// instead collapses it to a no-op, which would silently break every OTHER
// test's real fs access for the rest of the file). vi.unstubAllEnvs() is
// the only global reset needed; the one process.kill spy this file uses is
// restored locally, at the end of its own test, instead.
afterEach(() => { vi.unstubAllEnvs(); });

describe('discoveryPath', () => {
  it('is $VIDEO_EXTRACT_CACHE_DIR/servers.json when the override is set', () => {
    const dir = freshCacheDir();
    expect(discoveryPath()).toBe(join(dir, 'servers.json'));
  });

  it('falls back to ~/.cache/video-extract-mcp/servers.json when unset -- pure path computation, no I/O against it', () => {
    vi.stubEnv('VIDEO_EXTRACT_CACHE_DIR', '');
    expect(discoveryPath()).toBe(join(homedir(), '.cache', 'video-extract-mcp', 'servers.json'));
  });
});

describe('registerServer / liveServers round-trip', () => {
  it('a registered live entry (this test process itself) reads back with every field intact', () => {
    freshCacheDir();
    const e = entry({ port: 5555 });
    registerServer(e);
    expect(liveServers()).toEqual([e]);
  });

  it('registering the same pid again replaces, not duplicates, its entry', () => {
    freshCacheDir();
    registerServer(entry({ port: 1 }));
    registerServer(entry({ port: 2 }));
    const got = liveServers();
    expect(got).toHaveLength(1);
    expect(got[0]!.port).toBe(2);
  });

  it('two different pids registered back to back both survive (read-modify-write preserves prior entries)', () => {
    const dir = freshCacheDir();
    registerServer(entry({ pid: 999_001, port: 111 }));
    registerServer(entry({ pid: 999_002, port: 222 }));
    // Read raw, not via liveServers(): these fabricated pids are (almost
    // certainly) not real live processes, so a liveness-filtered read would
    // conflate "got pruned by liveness" with "was never written" -- this
    // test is about the write-rename round-trip specifically, not liveness.
    const raw = JSON.parse(readFileSync(join(dir, 'servers.json'), 'utf8')) as ServerEntry[];
    expect(raw.map((r) => r.pid).sort((a, b) => a - b)).toEqual([999_001, 999_002]);
  });
});

describe('unregisterServer', () => {
  it('removes only its own entry, leaving others intact', () => {
    const dir = freshCacheDir();
    registerServer(entry({ pid: 999_001, port: 111 }));
    registerServer(entry({ pid: 999_002, port: 222 }));
    unregisterServer(999_001);
    const raw = JSON.parse(readFileSync(join(dir, 'servers.json'), 'utf8')) as ServerEntry[];
    expect(raw.map((r) => r.pid)).toEqual([999_002]);
  });
});

describe('corrupt or absent file reads as [], never throws', () => {
  it('an absent file (nothing ever written)', () => {
    freshCacheDir();
    expect(() => liveServers()).not.toThrow();
    expect(liveServers()).toEqual([]);
  });

  it('invalid JSON', () => {
    const dir = freshCacheDir();
    writeFileSync(join(dir, 'servers.json'), '{not valid json');
    expect(() => liveServers()).not.toThrow();
    expect(liveServers()).toEqual([]);
  });

  it('valid JSON that is not an array', () => {
    const dir = freshCacheDir();
    writeFileSync(join(dir, 'servers.json'), JSON.stringify({ oops: 'not an array' }));
    expect(liveServers()).toEqual([]);
  });

  it('malformed elements inside an otherwise-valid array are dropped, not thrown -- and never reach liveness', () => {
    // Load-bearing, not incidental: a non-numeric pid reaching isAlive()
    // would make process.kill throw ERR_INVALID_ARG_TYPE, a code that is
    // neither ESRCH nor EPERM -- isAlive's own fail-toward-alive default
    // would then keep it forever. Structural filtering in readEntries()
    // must remove it before liveness ever sees it.
    const dir = freshCacheDir();
    const validEntry = entry({ port: 2 }); // captured once: two separate entry() calls would carry two different Date.now() startedAt values
    writeFileSync(join(dir, 'servers.json'), JSON.stringify([
      { pid: 'not-a-number', port: 1, startedAt: 1, version: '0.3.0' },
      validEntry,
    ]));
    expect(liveServers()).toEqual([validEntry]);
  });
});

describe('liveness pruning', () => {
  it('prunes a guaranteed-dead pid and persists the prune to disk (not just the in-memory return value)', () => {
    const dir = freshCacheDir();
    // Brief's own recipe: spawn a real child, wait for it to exit, reuse
    // its pid -- guaranteed ESRCH, not a fabricated number that might
    // collide with something real.
    const dead = spawnSync(process.execPath, ['-e', '""']);
    registerServer(entry({ pid: dead.pid, port: 111 }));
    registerServer(entry({ port: 222 })); // this test process's own pid -- genuinely alive, alongside
    const got = liveServers();
    expect(got.map((e) => e.pid)).toEqual([process.pid]);
    // Positive check beyond in-memory filtering: a "prune only in memory,
    // never persist" mutant would pass the assertion above (liveServers()'s
    // RETURN value is correct either way) while leaving the dead entry on
    // disk forever, silently re-appearing to every other reader (this
    // server's own next poll, or a completely different process). Reading
    // the file directly, bypassing liveServers(), is what catches that.
    const raw = JSON.parse(readFileSync(join(dir, 'servers.json'), 'utf8')) as ServerEntry[];
    expect(raw.map((e) => e.pid)).toEqual([process.pid]);
  });

  it('treats EPERM (exists, but cannot be signalled) as alive, not dead', () => {
    // Real EPERM requires a process we don't own (e.g. pid 1 as non-root),
    // which is not portable across CI (root-in-container makes kill(1,0)
    // succeed with no throw at all, silently invalidating the premise).
    // process.kill is called as a live property access on every isAlive()
    // invocation specifically so it CAN be spied on like this -- see
    // discovery.ts's own doc comment on isAlive.
    freshCacheDir();
    registerServer(entry({ pid: 424_242, port: 111 }));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 424_242) {
        const err = new Error('EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return true;
    }) as typeof process.kill);
    try {
      expect(liveServers().map((e) => e.pid)).toEqual([424_242]);
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('steady-state read-only (§7 write-frequency promise)', () => {
  it('liveServers() does not rewrite the file when its liveness loop finds nothing to prune', async () => {
    const dir = freshCacheDir();
    registerServer(entry({ port: 333 }));
    const path = join(dir, 'servers.json');
    const beforeMtime = statSync(path).mtimeMs;
    const beforeContent = readFileSync(path, 'utf8');
    // Real clock delay, comfortably above filesystem mtime resolution, so a
    // wrongly-triggered write is guaranteed to land at an observably later
    // mtime rather than being masked by two writes landing in one tick.
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    const firstPoll = liveServers();
    const secondPoll = liveServers(); // a second poll, as a CLI --watch tick would make
    expect(firstPoll).toEqual(secondPoll);
    expect(statSync(path).mtimeMs).toBe(beforeMtime);
    expect(readFileSync(path, 'utf8')).toBe(beforeContent);
  });
});

describe('atomic write mechanism', () => {
  it('writes only via a servers.json.tmp.<pid> sibling then renames over the real path -- never a direct write', () => {
    // A mutant that wrote straight to discoveryPath() (skipping the
    // tmp-then-rename dance) would produce the exact same FINAL bytes on
    // disk as the real implementation -- the round-trip tests above would
    // still pass. This is the one test that observes the write MECHANISM
    // itself, which is the only place that mutant is visible: a concurrent
    // reader could see a partially-written file mid-write, but that race is
    // not reliably reproducible in a deterministic unit test (see the task
    // report).
    const dir = freshCacheDir();
    const path = join(dir, 'servers.json');
    const writeMock = vi.mocked(fsWriteFileSync);
    const renameMock = vi.mocked(fsRenameSync);
    const writesBefore = writeMock.mock.calls.length;
    const renamesBefore = renameMock.mock.calls.length;

    registerServer(entry({ port: 777 }));

    const writesDuring = writeMock.mock.calls.slice(writesBefore);
    const renamesDuring = renameMock.mock.calls.slice(renamesBefore);
    expect(writesDuring.length).toBeGreaterThan(0);
    for (const call of writesDuring) {
      const target = String(call[0]);
      expect(target).not.toBe(path);
      expect(target).toMatch(/servers\.json\.tmp\.\d+$/);
    }
    expect(renamesDuring.length).toBeGreaterThan(0);
    for (const call of renamesDuring) {
      expect(String(call[0])).toMatch(/servers\.json\.tmp\.\d+$/);
      expect(String(call[1])).toBe(path);
    }
  });
});

describe('end-to-end via a real spawned server (src/mcp.ts wiring)', () => {
  it('registers on start and unregisters on SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vem-discovery-e2e-'));
    const path = join(dir, 'servers.json');
    const child = spawn(process.execPath, ['dist/mcp.js'], {
      cwd: process.cwd(),
      env: { ...process.env, VIDEO_EXTRACT_CACHE_DIR: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const readRaw = (): ServerEntry[] => {
      try { return JSON.parse(readFileSync(path, 'utf8')) as ServerEntry[]; } catch { return []; }
    };
    try {
      // Registration is asynchronous relative to process start (the
      // endpoint's ephemeral port must bind first) -- bounded poll, not a
      // fixed sleep, matching this repo's own established precedent
      // (tests/mcp.test.ts's queued-then-cancelled bounded-retry test).
      let registered: ServerEntry | undefined;
      for (let i = 0; i < 50; i++) {
        registered = readRaw().find((e) => e.pid === child.pid);
        if (registered) break;
        await new Promise((resolve) => { setTimeout(resolve, 100); });
      }
      expect(registered).toBeDefined();
      expect(registered!.port).toBeGreaterThan(0);
      expect(registered!.version).toBe('0.3.0');

      // SIGTERM, deliberately, not stdin EOF: this is the signal-handler
      // chain this task actually adds (the SIGTERM listener calls
      // process.exit(), which fires the 'exit' hook that calls
      // unregisterServer synchronously). Stdin EOF only proves Node's own
      // natural-exit path, already covered by tests/mcpProcessLifecycle.
      // test.ts -- it would pass even if the SIGTERM/SIGINT wiring were
      // entirely absent.
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;

      let stillPresent = true;
      for (let i = 0; i < 20; i++) {
        stillPresent = readRaw().some((e) => e.pid === child.pid);
        if (!stillPresent) break;
        await new Promise((resolve) => { setTimeout(resolve, 100); });
      }
      expect(stillPresent).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 15_000);
});
