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
 *  reporting reach 8 run()-calling modules with zero signature changes. */
const als = new AsyncLocalStorage<StatusCallbacks>();

export function runWithStatus<T>(cb: StatusCallbacks, fn: () => Promise<T>): Promise<T> {
  return als.run(cb, fn);
}
export function statusCallbacks(): StatusCallbacks | undefined {
  return als.getStore();
}
