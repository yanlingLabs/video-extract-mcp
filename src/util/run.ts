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
    // exits. Called bare, with no local try/catch: runWithStatus()
    // (src/status/context.ts) already wraps every callback on `status` in a
    // swallowing proxy at establishment, so that guarantee lives in exactly
    // one place rather than being duplicated at each reader.
    const status = statusCallbacks();
    if (status?.onSpawn && typeof child.pid === 'number') {
      status.onSpawn(child.pid, cmd);
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
      status?.onSpawnEnded?.();
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      status?.onSpawnEnded?.();
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
