import { readFileSync } from 'node:fs';
import { isMainModule } from '../src/util/entry.js';

/**
 * CI guard for package-lock.json damage that looks like an ordinary diff.
 *
 * PR #5 came with a lockfile regenerated on npm 10 (the npm bundled with
 * Node 22, which this project supports): regenerating from an existing
 * node_modules pruned every other platform's optional binaries, and the
 * contributor's install also stripped `resolved`/`integrity` from nearly
 * every entry. Merged, the first would break installs on other platforms and
 * the second would stop `npm ci` from verifying anything it downloads.
 *
 * Two properties, both true of every lockfile npm 11 writes:
 *  - every installed entry records where it came from and its hash (links and
 *    bundled dependencies are the documented exceptions);
 *  - every optional dependency a locked package declares is itself locked --
 *    npm 11 locks all platforms' binaries, whichever platform ran the install.
 */

export interface LockEntry {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  inBundle?: boolean;
  optional?: boolean;
  os?: string[];
  optionalDependencies?: Record<string, string>;
}

export interface Lockfile { lockfileVersion?: number; packages?: Record<string, LockEntry> }

/** Node's lookup: `<dir>/node_modules/<name>`, walking up to the root. */
function isLocked(packages: Record<string, LockEntry>, from: string, name: string): boolean {
  let dir = from;
  for (;;) {
    if (`${dir ? `${dir}/` : ''}node_modules/${name}` in packages) return true;
    if (!dir) return false;
    const i = dir.lastIndexOf('/node_modules/');
    dir = i < 0 ? '' : dir.slice(0, i);
  }
}

export function checkLockfile(lock: Lockfile): string[] {
  const packages = lock.packages ?? {};
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '' || entry.link) continue;
    if (!entry.inBundle && (!entry.resolved || !entry.integrity)) {
      problems.push(`${key}: missing resolved/integrity`);
    }
    for (const name of Object.keys(entry.optionalDependencies ?? {})) {
      if (!isLocked(packages, key, name)) problems.push(`${key}: optional dependency ${name} is not in the lockfile`);
    }
  }
  return problems;
}

function main(): void {
  const file = process.argv[2] ?? 'package-lock.json';
  const problems = checkLockfile(JSON.parse(readFileSync(file, 'utf8')) as Lockfile);
  if (problems.length === 0) {
    console.log(`${file}: ok`);
    return;
  }
  console.error(`${file}: ${problems.length} problem(s). Regenerate it with npm 11 or newer.`);
  for (const p of problems) console.error(`  ${p}`);
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main();
