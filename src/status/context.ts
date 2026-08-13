import { AsyncLocalStorage } from 'node:async_hooks';

export interface StatusCallbacks {
  onStage?: (stage: string) => void;
  onSpawn?: (pid: number, command: string) => void;
  onSpawnEnded?: () => void;
}

/** The one sanctioned module-level instance in the status feature: an
 *  AsyncLocalStorage is context PROPAGATION, not shared mutable state --
 *  each runWithStatus() call sees only its own store. Established at the
 *  agent layer around one item's execution; read by src/util/run.ts and
 *  the three resolver download sites, which is what lets spawn/download
 *  reporting reach 8 run()-calling modules with zero signature changes.
 *
 *  Callbacks stored in the context are wrapped at establishment (see
 *  safe()/runWithStatus below); readers may invoke them bare. This is what
 *  makes the guarantee structural rather than a per-call-site convention: a
 *  throwing caller-supplied callback can never propagate back into a
 *  resolver or run() and masquerade as a pipeline failure, no matter how
 *  many readers this context grows to. */
const als = new AsyncLocalStorage<StatusCallbacks>();

/** Wraps an optional callback so invoking it can never throw -- the single
 *  place this guarantee is enforced, once, at establishment, rather than
 *  duplicated at every statusCallbacks() read site (run.ts, the three
 *  resolver emits, and any future one). `undefined` stays `undefined`, so
 *  `status?.onSpawn` optional-chaining at call sites is unaffected. */
function safe<A extends unknown[]>(fn?: (...a: A) => void): ((...a: A) => void) | undefined {
  return fn ? (...a: A) => { try { fn(...a); } catch { /* reporting never breaks work */ } } : undefined;
}

export function runWithStatus<T>(cb: StatusCallbacks, fn: () => Promise<T>): Promise<T> {
  return als.run(
    { onStage: safe(cb.onStage), onSpawn: safe(cb.onSpawn), onSpawnEnded: safe(cb.onSpawnEnded) },
    fn,
  );
}
export function statusCallbacks(): StatusCallbacks | undefined {
  return als.getStore();
}
