import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync,
  writeFileSync as fsWriteFileSync, renameSync as fsRenameSync, unlinkSync as fsUnlinkSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  serversDir, serverFilePath, registerServer, unregisterServer, liveServers, type ServerEntry,
} from '../src/status/discovery.js';

// Passthrough mock, same idiom as tests/analyze.integration.test.ts: every
// real fs call behaves identically for every OTHER test in this file
// (mkdtempSync, readFileSync, writeFileSync, statSync, mkdirSync all still
// hit the real filesystem), but writeFileSync/renameSync/unlinkSync are
// additionally spy-wrapped so the write-mechanism and steady-state tests
// below can inspect exactly which paths discovery.ts's internals actually
// touched, without needing any export beyond the ones the module already has.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    writeFileSync: vi.fn(real.writeFileSync),
    renameSync: vi.fn(real.renameSync),
    unlinkSync: vi.fn(real.unlinkSync),
  };
});

/** VIDEO_EXTRACT_CACHE_DIR is TEST-FACING (see discovery.ts's own doc
 *  comment). Every test in this file uses it to point the whole discovery
 *  directory at a throwaway mkdtemp directory, so nothing here ever reads
 *  or writes the real machine's home directory. */
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

describe('serversDir / serverFilePath', () => {
  it('serversDir() is $VIDEO_EXTRACT_CACHE_DIR/servers when the override is set', () => {
    const dir = freshCacheDir();
    expect(serversDir()).toBe(join(dir, 'servers'));
  });

  it('falls back to ~/.cache/video-extract-mcp/servers when unset -- pure path computation, no I/O against it', () => {
    vi.stubEnv('VIDEO_EXTRACT_CACHE_DIR', '');
    expect(serversDir()).toBe(join(homedir(), '.cache', 'video-extract-mcp', 'servers'));
  });

  it('serverFilePath(pid) names a <pid>.json file inside serversDir()', () => {
    freshCacheDir();
    expect(serverFilePath(4122)).toBe(join(serversDir(), '4122.json'));
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

  it('two different pids registered back to back both survive, each in its OWN file (no shared state to race over)', () => {
    freshCacheDir();
    registerServer(entry({ pid: 999_001, port: 111 }));
    registerServer(entry({ pid: 999_002, port: 222 }));
    // Read each pid's own file directly, not via liveServers(): these
    // fabricated pids are (almost certainly) not real live processes, so a
    // liveness-filtered read would conflate "got pruned by liveness" with
    // "was never written" -- this test is about the per-file write
    // mechanism specifically, not liveness.
    const a = JSON.parse(readFileSync(serverFilePath(999_001), 'utf8')) as ServerEntry;
    const b = JSON.parse(readFileSync(serverFilePath(999_002), 'utf8')) as ServerEntry;
    expect(a.pid).toBe(999_001);
    expect(b.pid).toBe(999_002);
  });
});

describe('unregisterServer', () => {
  it('removes only its own entry, leaving others intact', () => {
    freshCacheDir();
    registerServer(entry({ pid: 999_001, port: 111 }));
    registerServer(entry({ pid: 999_002, port: 222 }));
    unregisterServer(999_001);
    expect(existsSync(serverFilePath(999_001))).toBe(false);
    expect(existsSync(serverFilePath(999_002))).toBe(true);
  });

  it('unregistering a pid that was never registered is a silent no-op, never throws', () => {
    freshCacheDir();
    expect(() => { unregisterServer(123_456); }).not.toThrow();
  });
});

describe('corrupt or absent files read as [], never throw', () => {
  it('an absent servers/ directory (nothing ever registered)', () => {
    freshCacheDir();
    expect(() => liveServers()).not.toThrow();
    expect(liveServers()).toEqual([]);
  });

  it('invalid JSON in a pid file', () => {
    freshCacheDir();
    mkdirSync(serversDir(), { recursive: true });
    writeFileSync(serverFilePath(424_242), '{not valid json');
    expect(() => liveServers()).not.toThrow();
    expect(liveServers()).toEqual([]);
  });

  it('valid JSON that is not a recognizable ServerEntry', () => {
    freshCacheDir();
    mkdirSync(serversDir(), { recursive: true });
    writeFileSync(serverFilePath(424_242), JSON.stringify({ oops: 'not a server entry' }));
    expect(liveServers()).toEqual([]);
  });

  it('a malformed file alongside a valid one is dropped, not thrown -- and never reaches liveness, without affecting the valid entry', () => {
    // Load-bearing, not incidental: a non-numeric pid reaching isAlive()
    // would make process.kill throw ERR_INVALID_ARG_TYPE, a code that is
    // neither ESRCH nor EPERM -- isAlive's own fail-toward-alive default
    // would then keep it forever. Structural filtering in readEntry() must
    // remove it before liveness ever sees it, and -- unlike the old
    // shared-array design -- it can only ever affect its OWN file, never
    // another pid's.
    freshCacheDir();
    mkdirSync(serversDir(), { recursive: true });
    writeFileSync(join(serversDir(), 'not-a-pid.json'), JSON.stringify({ pid: 'not-a-number', port: 1, startedAt: 1, version: '0.3.0' }));
    const validEntry = entry({ port: 2 });
    registerServer(validEntry);
    expect(liveServers()).toEqual([validEntry]);
  });

  it('a stray .tmp file left by an interrupted write is skipped, never parsed', () => {
    freshCacheDir();
    mkdirSync(serversDir(), { recursive: true });
    writeFileSync(`${serverFilePath(424_242)}.tmp`, JSON.stringify(entry({ pid: 424_242 })));
    expect(liveServers()).toEqual([]);
  });
});

describe('liveness pruning', () => {
  it('prunes a guaranteed-dead pid and persists the prune to disk (its own file is removed, not just excluded in memory)', () => {
    freshCacheDir();
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
    // RETURN value is correct either way) while leaving the dead entry's
    // file on disk forever, silently re-appearing to every other reader
    // (this server's own next poll, or a completely different process).
    expect(existsSync(serverFilePath(dead.pid!))).toBe(false);
    expect(existsSync(serverFilePath(process.pid))).toBe(true);
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
  it('liveServers() does not write, rename or unlink anything when every registered entry is still alive', async () => {
    const dir = freshCacheDir();
    registerServer(entry({ port: 333 }));
    const path = serverFilePath(process.pid);
    const beforeMtime = statSync(path).mtimeMs;
    const beforeContent = readFileSync(path, 'utf8');
    // Snapshotted AFTER registerServer's own one write+rename above, so the
    // delta asserted below covers only the two liveServers() polls that
    // follow. Zero calls is a hard, deterministic fact regardless of what
    // timestamp resolution the host filesystem happens to offer.
    const writesBefore = vi.mocked(fsWriteFileSync).mock.calls.length;
    const renamesBefore = vi.mocked(fsRenameSync).mock.calls.length;
    const unlinksBefore = vi.mocked(fsUnlinkSync).mock.calls.length;
    // Real clock delay, comfortably above filesystem mtime resolution, so a
    // wrongly-triggered write is guaranteed to land at an observably later
    // mtime rather than being masked by two writes landing in one tick.
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    const firstPoll = liveServers();
    const secondPoll = liveServers(); // a second poll, as a CLI --watch tick would make
    expect(firstPoll).toEqual(secondPoll);
    expect(vi.mocked(fsWriteFileSync).mock.calls.length).toBe(writesBefore);
    expect(vi.mocked(fsRenameSync).mock.calls.length).toBe(renamesBefore);
    expect(vi.mocked(fsUnlinkSync).mock.calls.length).toBe(unlinksBefore);
    expect(statSync(path).mtimeMs).toBe(beforeMtime);
    expect(readFileSync(path, 'utf8')).toBe(beforeContent);
    void dir;
  });
});

describe('atomic write mechanism', () => {
  it('writes only via a <pid>.json.tmp sibling then renames over the real path -- never a direct write', () => {
    // A mutant that wrote straight to serverFilePath() (skipping the
    // tmp-then-rename dance) would produce the exact same FINAL bytes on
    // disk as the real implementation -- the round-trip tests above would
    // still pass. This is the one test that observes the write MECHANISM
    // itself, which is the only place that mutant is visible: a concurrent
    // reader could see a partially-written file mid-write, but that race is
    // not reliably reproducible in a deterministic unit test.
    freshCacheDir();
    const path = serverFilePath(process.pid);
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
      expect(target).toBe(`${path}.tmp`);
    }
    expect(renamesDuring.length).toBeGreaterThan(0);
    for (const call of renamesDuring) {
      expect(String(call[0])).toBe(`${path}.tmp`);
      expect(String(call[1])).toBe(path);
    }
  });
});

describe('simultaneous registration (final review, Important 3)', () => {
  it('N servers starting at genuinely the same instant all register -- none silently lost to a write race', async () => {
    // The reviewer's own repro: real, separate OS processes launched
    // concurrently (spawn() calls started together via Promise.all, not
    // sequential awaits), each running the real compiled server against a
    // SHARED cache dir -- this is what makes the starts genuinely
    // simultaneous rather than merely close together. Against the old
    // shared-`servers.json` design this reliably lost entries (reviewer
    // measured 3->1, 5->4); the per-pid-file design removes the race by
    // construction, so this asserts the strong property directly: ALL N
    // present, not "usually most of them."
    const dir = mkdtempSync(join(tmpdir(), 'vem-discovery-concurrent-'));
    const N = 5;
    const children = Array.from({ length: N }, () => spawn(process.execPath, ['dist/mcp.js'], {
      cwd: process.cwd(),
      env: { ...process.env, VIDEO_EXTRACT_CACHE_DIR: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }));

    try {
      const pids = children.map((c) => c.pid);
      expect(pids.every((p) => typeof p === 'number')).toBe(true);

      // Bounded poll (never a fixed sleep) for every child's own pid to
      // show up as a LIVE entry -- liveServers() itself does the pid
      // liveness check, so this also proves each entry is genuinely usable,
      // not just present on disk mid-write.
      let seen: ServerEntry[] = [];
      for (let i = 0; i < 100; i++) {
        vi.stubEnv('VIDEO_EXTRACT_CACHE_DIR', dir);
        seen = liveServers();
        if (pids.every((p) => seen.some((e) => e.pid === p))) break;
        await new Promise((resolve) => { setTimeout(resolve, 100); });
      }

      expect(seen.map((e) => e.pid).sort((a, b) => a - b)).toEqual([...pids].sort((a, b) => a! - b!));
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  }, 20_000);
});

describe('end-to-end via a real spawned server (src/mcp.ts wiring)', () => {
  it('registers on start and unregisters on SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vem-discovery-e2e-'));
    const child = spawn(process.execPath, ['dist/mcp.js'], {
      cwd: process.cwd(),
      env: { ...process.env, VIDEO_EXTRACT_CACHE_DIR: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const readRaw = (pid: number): ServerEntry | null => {
      try { return JSON.parse(readFileSync(join(dir, 'servers', `${pid}.json`), 'utf8')) as ServerEntry; } catch { return null; }
    };
    try {
      // Registration is asynchronous relative to process start (the
      // endpoint's ephemeral port must bind first) -- bounded poll, not a
      // fixed sleep, matching this repo's own established precedent
      // (tests/mcp.test.ts's queued-then-cancelled bounded-retry test).
      let registered: ServerEntry | null = null;
      for (let i = 0; i < 50; i++) {
        registered = readRaw(child.pid!);
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
        stillPresent = readRaw(child.pid!) !== null;
        if (!stillPresent) break;
        await new Promise((resolve) => { setTimeout(resolve, 100); });
      }
      expect(stillPresent).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 15_000);
});
