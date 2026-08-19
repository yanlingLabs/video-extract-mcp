/**
 * Replies kept by caller-supplied call id, so a result survives a client that
 * stopped waiting.
 *
 * The failure this exists for: a client with a wall-clock limit on tool calls
 * sends `notifications/cancelled` and moves on, but the server keeps working
 * (observed directly in a real client's own MCP log). The analysis finishes,
 * the files are written, and the reply has nowhere to go. The caller is left
 * with no handle on work that genuinely succeeded.
 *
 * ## The id must come from the CALLER
 *
 * A server-minted id would be returned in the reply -- the very thing that
 * was lost. Only an id the caller already knows survives a dropped answer, so
 * `callId` is an input, never an output.
 *
 * ## Separate from the status registry, on purpose
 *
 * `src/status/registry.ts` reports observables and never verdicts, which is
 * what keeps the status channel honest. This is a different thing: it holds
 * what a tool call would have RETURNED, verbatim, so a later lookup and the
 * original reply cannot drift apart. Keeping them apart keeps that rule
 * intact rather than bending it.
 *
 * Per-server and in-memory, like the registry and the task store: a restarted
 * server has no record, which is why every "unknown" answer points at the
 * files, which are the durable result.
 */

export interface CallRecord {
  callId: string;
  tool: 'analyze' | 'resolve';
  startedAt: number;
  finishedAt?: number;
  /** The reply object the tool produced -- stored verbatim. */
  reply?: unknown;
}

export interface CallStore {
  start(callId: string, tool: 'analyze' | 'resolve'): void;
  finish(callId: string, reply: unknown): void;
  /** Every record for an id: a reused id returns more than one, never a merge. */
  get(callId: string): CallRecord[];
  /** Records dropped so far to the cap or the TTL. */
  evicted(): number;
}

/** Matches the status registry's own bound, for the same reason. */
const MAX_RECORDS = 500;

export function createCallStore(ttlMs: number, now: () => number = Date.now): CallStore {
  const records: CallRecord[] = [];
  let evicted = 0;

  /** TTL runs from COMPLETION, so a long-running call is never expired mid-flight. */
  const expired = (r: CallRecord): boolean =>
    ttlMs > 0 && r.finishedAt !== undefined && now() - r.finishedAt > ttlMs;

  const prune = (): void => {
    for (let i = records.length - 1; i >= 0; i--) {
      if (expired(records[i]!)) { records.splice(i, 1); evicted++; }
    }
    while (records.length > MAX_RECORDS) { records.shift(); evicted++; }
  };

  return {
    start(callId, tool) {
      prune();
      // A reused id is kept alongside, not overwritten: overwriting would
      // silently discard a result the caller may still be about to ask for.
      records.push({ callId, tool, startedAt: now() });
    },
    finish(callId, reply) {
      // The most recent unfinished record for this id -- the call that just
      // ended, even if the id was reused while it ran.
      for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i]!;
        if (r.callId === callId && r.finishedAt === undefined) {
          r.finishedAt = now();
          r.reply = reply;
          return;
        }
      }
    },
    get(callId) {
      prune();
      return records.filter((r) => r.callId === callId).map((r) => ({ ...r }));
    },
    evicted: () => evicted,
  };
}
