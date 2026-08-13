/**
 * Concurrency slot pool for analyze_video item executions (spec §6).
 * Plain and task calls both run through it -- a plain call burns the same
 * CPU and model memory, so exempting it would make the cap fiction
 * (spec §12.2). resolve_video never uses it.
 */
export interface SlotPool {
  run<T>(fn: () => Promise<T>, onQueued?: (ahead: number) => void): Promise<T>;
  readonly running: number;
  readonly queued: number;
  readonly cap: number;
}

interface Waiter { start: () => void; onQueued?: (ahead: number) => void }

export function createSlotPool(max: number): SlotPool {
  let running = 0;
  const waiters: Waiter[] = [];
  const pump = () => {
    while (running < max && waiters.length > 0) {
      const next = waiters.shift()!;
      running++;
      next.start();
    }
    // Everyone still waiting just moved up; tell them where they stand.
    // Final whole-branch review, Minor finding 6: "ahead" means items
    // GENUINELY ahead of you -- every currently-running item, plus whoever
    // is still queued in front of you (0-based index `i` in the
    // now-shrunk `waiters` array, since `running` above has already been
    // incremented for everything the while loop just promoted). The old
    // `i + 1` formula reported 1-based QUEUE POSITION instead, which only
    // equals items-ahead at cap 1 (where `running` is always exactly 1
    // whenever anything is queued at all -- see the pool invariant note in
    // run() below); at the project's own default cap of 4, the first
    // queued item was told "1 ahead" while 4 were actually running.
    // O(n) re-report per release: O(n^2) per full drain (~10^5 callbacks for 500-deep queue).
    waiters.forEach((w, i) => w.onQueued?.(running + i));
  };
  return {
    get running() { return running; },
    get queued() { return waiters.length; },
    cap: max,
    run<T>(fn: () => Promise<T>, onQueued?: (ahead: number) => void): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        // Ordering: running-- MUST come before resolve/reject/pump().
        // If pump() ran first and a waiter's onQueued callback threw, the current caller would hang.
        const start = () => fn().then(
          (v) => { running--; resolve(v); pump(); },
          (e) => { running--; reject(e); pump(); },
        );
        if (running < max && waiters.length === 0) {
          running++;
          start();
        } else {
          // Pool invariant: whenever anything is queued (waiters
          // non-empty) at any point control returns to caller code,
          // `running === max` -- pump() greedily promotes waiters the
          // instant a slot frees, with no synchronous gap in which
          // `running` could sit below `max` while a waiter still waits.
          // So "ahead" here is every running slot (== max, once queued at
          // all) plus this item's own 0-based position among the OTHER
          // waiters already queued ahead of it (waiters.length - 1, since
          // the push below already counted this item itself).
          waiters.push({ start, onQueued });
          onQueued?.(running + waiters.length - 1);
        }
      });
    },
  };
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;  // unparseable -> default
  return n < 1 ? 1 : n;                       // explicit nonsense -> floor 1
}

/** VIDEO_EXTRACT_MAX_CONCURRENCY, default 4 (spec §6). */
export function analyzeConcurrencyFromEnv(): number {
  return intFromEnv('VIDEO_EXTRACT_MAX_CONCURRENCY', 4);
}

/**
 * VIDEO_EXTRACT_TASK_TTL_MS, default 30 minutes -- handle lifetime ONLY
 * (spec §9). Final whole-branch review, Important finding 4: explicit `0`
 * (or any other non-positive value) means NO expiry -- returns `undefined`,
 * which `createTask({ ttl: undefined })` (this function's only call site,
 * src/mcp.ts) makes the task store treat exactly like an omitted ttl: the
 * SDK's own CreateTaskOptions.ttl doc comment states "If null, the task has
 * unlimited lifetime until manually cleaned up", and InMemoryTaskStore.
 * createTask computes `taskParams.ttl ?? null` before deciding whether to
 * arm a cleanup timer at all -- `undefined` coerces to that same `null`,
 * verified against the installed SDK (in-memory.js).
 *
 * This function used to delegate to intFromEnv above, whose floor-1 rule
 * turned an explicit `0` into a 1ms ttl -- combined with the SDK client's
 * own >=1-pollInterval delay before its first status check (task-1-report.md
 * fact (b)), that guaranteed the cleanup timer fired and deleted the task
 * row before any plain call could ever see a result: VIDEO_EXTRACT_TASK_TTL_MS=0
 * bricked every call. Floor-1 made sense as "explicit nonsense -> fall back
 * to a sane positive number" for the concurrency reader below, which has no
 * comparable "unlimited" meaning for zero/negative -- that reader (and
 * intFromEnv itself) are deliberately left untouched; only this TTL-specific
 * reader's floor branch changes, and it now floors to "no expiry" rather
 * than to "expire almost immediately", since the same 1ms-ttl brick applies
 * to any non-positive value, not just the literal 0 the finding named.
 */
export function taskTtlMsFromEnv(): number | undefined {
  const raw = process.env['VIDEO_EXTRACT_TASK_TTL_MS']?.trim();
  if (!raw) return 1_800_000;
  const n = Number(raw);
  if (!Number.isInteger(n)) return 1_800_000;  // unparseable -> default
  return n < 1 ? undefined : n;                // explicit non-positive -> no expiry
}
