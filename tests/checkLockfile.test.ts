import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkLockfile, type LockEntry, type Lockfile } from '../scripts/check-lockfile.js';

/**
 * PR #5 arrived with a package-lock.json regenerated on npm 10: every other
 * platform's optional binaries were pruned and nearly every entry had lost its
 * `resolved`/`integrity`. Nothing flagged it. These are the two properties the
 * CI check enforces, on hand-built lockfiles.
 */

const pkg = (name: string, extra: LockEntry = {}): LockEntry => ({
  version: '1.0.0',
  resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
  integrity: `sha512-${name}`,
  ...extra,
});

const lock = (packages: Record<string, LockEntry>): Lockfile => ({ lockfileVersion: 3, packages: { '': { name: 'root' }, ...packages } });

describe('checkLockfile', () => {
  it('accepts a lockfile whose entries are complete', () => {
    expect(checkLockfile(lock({
      'node_modules/a': pkg('a', { optionalDependencies: { 'a-linux': '1.0.0' } }),
      'node_modules/a-linux': pkg('a-linux', { optional: true, os: ['linux'] }),
    }))).toEqual([]);
  });

  it('flags an entry with no integrity hash', () => {
    expect(checkLockfile(lock({
      'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
      'node_modules/b': pkg('b'),
    }))).toEqual(['node_modules/a: missing resolved/integrity']);
  });

  it('flags an entry with no resolved URL', () => {
    expect(checkLockfile(lock({
      'node_modules/a': { version: '1.0.0', integrity: 'sha512-a' },
    }))).toEqual(['node_modules/a: missing resolved/integrity']);
  });

  it('does not require hashes from links or bundled dependencies, which npm never records them for', () => {
    expect(checkLockfile(lock({
      'node_modules/local': { resolved: 'packages/local', link: true },
      'node_modules/a': pkg('a'),
      'node_modules/a/node_modules/bundled': { version: '1.0.0', inBundle: true },
    }))).toEqual([]);
  });

  it('flags an optional platform binary that a package declares but the lockfile dropped', () => {
    expect(checkLockfile(lock({
      'node_modules/a': pkg('a', { optionalDependencies: { 'a-linux': '1.0.0', 'a-win32': '1.0.0' } }),
      'node_modules/a-linux': pkg('a-linux', { optional: true, os: ['linux'] }),
    }))).toEqual(['node_modules/a: optional dependency a-win32 is not in the lockfile']);
  });

  it('finds an optional dependency nested under its parent or hoisted to the root', () => {
    expect(checkLockfile(lock({
      'node_modules/a': pkg('a'),
      'node_modules/a/node_modules/b': pkg('b', { optionalDependencies: { nested: '1.0.0', hoisted: '1.0.0' } }),
      'node_modules/a/node_modules/nested': pkg('nested', { optional: true }),
      'node_modules/hoisted': pkg('hoisted', { optional: true }),
    }))).toEqual([]);
  });

  it('does not look for a dependency inside an unrelated package', () => {
    expect(checkLockfile(lock({
      'node_modules/a': pkg('a', { optionalDependencies: { x: '1.0.0' } }),
      'node_modules/other/node_modules/x': pkg('x', { optional: true }),
      'node_modules/other': pkg('other'),
    }))).toEqual(['node_modules/a: optional dependency x is not in the lockfile']);
  });
});

describe('check-lockfile script', () => {
  const run = (file: string) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-lockfile.ts', file], { encoding: 'utf8' });

  it('exits 0 for this repository\'s own lockfile', () => {
    const r = run('package-lock.json');
    expect(r.status, r.stderr).toBe(0);
  });

  it('exits 1 and names the problems for a damaged lockfile', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'vem-lock-')), 'package-lock.json');
    writeFileSync(f, JSON.stringify(lock({ 'node_modules/a': { version: '1.0.0' } })));
    const r = run(f);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('node_modules/a: missing resolved/integrity');
  });
});
