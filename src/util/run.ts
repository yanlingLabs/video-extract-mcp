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
    // A spawn that never gets a pid (ENOENT/EACCES class) makes Node fire
    // BOTH 'error' and 'close' -- confirmed, not hypothetical. Without a
    // guard, both handlers below would each call onSpawnEnded, reporting
    // one failed spawn's end twice. Scoped to this run() call's own Promise
    // executor, so it guards exactly the one child this call owns: within a
    // context spanning more than one spawn (e.g. analyze.ts's per-frame OCR
    // loop degrading past repeated failed tesseract spawns), a phantom
    // second "ended" from THIS spawn could otherwise land after a LATER,
    // unrelated spawn's own onSpawn already set that spawn's childPid --
    // wrongly clearing a live, killable child from the status view. No
    // inner try/catch here (unlike an earlier draft of this fix): every
    // callback on `status` is already wrapped by safe() at runWithStatus()
    // establishment (src/status/context.ts), so a local try/catch around
    // status?.onSpawnEnded?.() would be unreachable dead code -- the same
    // redundancy reasoning already applied to the onSpawn call above.
    let ended = false;
    const endOnce = () => { if (!ended) { ended = true; status?.onSpawnEnded?.(); } };
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
      // endOnce(), not a bare call: 'close' may still fire after this for
      // the exact same spawn (see the comment above endOnce's definition).
      endOnce();
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      endOnce();
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
