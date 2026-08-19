/**
 * Finished per-video results, keyed by the URL or path they were asked for,
 * so a result survives a client that stopped waiting.
 *
 * The failure this exists for is real and was observed in a client's own MCP
 * log: when its wall-clock limit expires it sends `notifications/cancelled`
 * and moves on, while the server keeps working. The analysis finishes, the
 * files are written, and the reply has nowhere to go.
 *
 * ## Why the URL is the key
 *
 * An earlier design had the caller invent a `callId` and pass it in. That
 * worked, but it only helped a caller who had thought to supply one BEFORE
 * discovering it would be needed -- and the moment recovery matters is
 * exactly the moment it is too late to go back and add it. The URL or path
 * is already required on every call, so the caller cannot fail to have it,
 * and no ceremony is required to earn recovery.
 *
 * Keyed EXACTLY as it was given: no normalizing between youtu.be and
 * youtube.com forms, no stripping of query parameters. A caller asking after
 * its own earlier call passes the same string it passed then, and inventing
 * equivalences would risk answering about a different video.
 *
 * ## Separate from the status registry, on purpose
 *
 * `src/status/registry.ts` reports observables and never verdicts, which is
 * what keeps the status channel honest, and it already tracks what is
 * RUNNING (keyed by url, with stage history). This holds what finished calls
 * RETURNED, verbatim, so a later lookup and the original reply cannot drift
 * apart. Keeping them apart leaves that rule intact rather than bending it.
 *
 * Per-server and in-memory, like the registry and the task store: a restarted
 * server has no record, which is why an unknown answer points at the files.
 */

export interface ResultRecord {
  url: string;
  tool: 'analyze' | 'resolve';
  finishedAt: number;
  /** The item's own result object, exactly as the tool returned it. */
  result: unknown;
}

export interface ResultStore {
  record(url: string, tool: 'analyze' | 'resolve', result: unknown): void;
  /** Every record for a url: the same video analyzed twice returns both. */
  get(url: string): ResultRecord[];
  evicted(): number;
}

/** Matches the status registry's own bound, for the same reason. */
const MAX_RECORDS = 500;

export function createResultStore(ttlMs: number, now: () => number = Date.now): ResultStore {
  const records: ResultRecord[] = [];
  let evicted = 0;

  const prune = (): void => {
    if (ttlMs > 0) {
      for (let i = records.length - 1; i >= 0; i--) {
        if (now() - records[i]!.finishedAt > ttlMs) { records.splice(i, 1); evicted++; }
      }
    }
    while (records.length > MAX_RECORDS) { records.shift(); evicted++; }
  };

  return {
    record(url, tool, result) {
      prune();
      // Appended, never replacing an earlier record for the same url: the
      // same video may legitimately be analyzed twice with different
      // parameters, and discarding the first would lose a result the caller
      // may still be about to ask for.
      records.push({ url, tool, finishedAt: now(), result });
    },
    get(url) {
      prune();
      return records.filter((r) => r.url === url).map((r) => ({ ...r }));
    },
    evicted: () => evicted,
  };
}
