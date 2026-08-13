import { spawn } from 'node:child_process';
import { statusCallbacks } from '../status/context.js';

export interface RunOpts { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; }

export async function run(
  cmd: string, args: string[], opts: RunOpts = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Captured once, synchronously, right after spawn(): both the 'close'
    // and 'error' handlers below close over this same reference rather than
    // re-reading statusCallbacks() themselves, so the report is tied to
    // whichever context (if any) was ambient when this run() call was made
    // -- not whatever happens to be ambient whenever the child eventually
    // exits.
    const status = statusCallbacks();
    if (status?.onSpawn && typeof child.pid === 'number') {
      try { status.onSpawn(child.pid, cmd); } catch { /* reporting never breaks work */ }
    }
    let stdout = '', stderr = '';
    const timer = opts.timeoutMs
      ? setTimeout(() => { child.kill('SIGKILL'); }, opts.timeoutMs)
      : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      // A spawn that errored still ends -- the child's lifecycle is over,
      // so any observer waiting on onSpawnEnded must be told either way.
      try { status?.onSpawnEnded?.(); } catch { /* reporting never breaks work */ }
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      try { status?.onSpawnEnded?.(); } catch { /* reporting never breaks work */ }
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
