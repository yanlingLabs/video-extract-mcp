import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The server must report the version it actually is.
 *
 * This has drifted twice. First as three independent literals -- the status
 * endpoint saying '0.3.0' while McpServer still said '0.2.0'. That was fixed
 * by factoring them into one constant, which fixed only half of it: at 0.4.0
 * the three agreed with each other and all three lied about the package,
 * because package.json was bumped and the hand-maintained literal was not.
 *
 * So this asserts against package.json rather than against a literal -- a
 * test carrying its own copy of the version would drift in exactly the same
 * way as the constant it is supposed to guard, and would have passed
 * throughout both incidents.
 *
 * Driven through the built dist/ over stdio, because that is the artifact
 * that ships and the path where a relative package.json lookup can miss.
 */
function packageVersion(): string {
  return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

interface Handshake { version: string; name: string; cacheDir: string }

function handshake(): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    // Hermetic: the discovery entry goes to a throwaway cache dir, never the
    // user's real one.
    const cacheDir = mkdtempSync(join(tmpdir(), 'vem-ver-'));
    // fileURLToPath, NOT url.pathname: this repo's own checkout path
    // contains a space, which pathname percent-encodes into a path that
    // does not exist -- the spawn then fails and the handshake just times
    // out with nothing to explain it.
    const server = fileURLToPath(new URL('../dist/mcp.js', import.meta.url));
    const p = spawn(process.execPath, [server], {
      env: { ...process.env, VIDEO_EXTRACT_CACHE_DIR: cacheDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    // A child that dies must fail loudly with its stderr rather than
    // silently burning the timeout.
    p.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}: ${err.slice(-400)}`));
      }
    });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('handshake timed out')); }, 20_000);
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      for (const line of out.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { serverInfo?: { name: string; version: string } } };
          if (msg.id === 1 && msg.result?.serverInfo) {
            clearTimeout(timer);
            const info = msg.result.serverInfo;
            p.kill('SIGKILL');
            resolve({ version: info.version, name: info.name, cacheDir });
            return;
          }
        } catch { /* partial line */ }
      }
    });
    p.on('error', reject);
    p.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }) + '\n');
  });
}

describe('the version the server reports', () => {
  it('matches package.json, so a release bump cannot leave it lying', async () => {
    const { version, name } = await handshake();
    expect(version).toBe(packageVersion());
    expect(name).toBe('norma-video');
    // Guard the guard: a build that somehow reported an empty or placeholder
    // version would otherwise sail through if package.json matched it.
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  }, 30_000);

  it('stamps that same version into the discovery entry an operator reads', async () => {
    // The status CLI renders this field to answer "what is actually
    // running?" -- the one question a stale version makes unanswerable.
    const { version, cacheDir } = await handshake();
    const dir = join(cacheDir, 'servers');
    const entries = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(entries.length).toBeGreaterThan(0);
    const entry = JSON.parse(readFileSync(join(dir, entries[0]!), 'utf8')) as { version: string };
    expect(entry.version).toBe(version);
    expect(entry.version).toBe(packageVersion());
  }, 30_000);
});
