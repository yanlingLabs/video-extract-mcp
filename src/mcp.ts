#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { CallToolResult, Task } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { analyzeVideoTool, itemDir, type AnalyzeToolArgs, type AnalyzeToolResult } from './agent/analyzeTool.js';
import { resolveVideoTool, type ResolveToolArgs } from './agent/resolveTool.js';
import { createSlotPool, analyzeConcurrencyFromEnv, taskTtlMsFromEnv, type SlotPool } from './agent/slots.js';
import { createStatusRegistry, type StatusRegistry } from './status/registry.js';
import { startStatusEndpoint, statusPortFromEnv } from './status/endpoint.js';
import { registerServer, unregisterServer } from './status/discovery.js';
import { isMainModule } from './util/entry.js';

export const TOOL_NAMES = ['resolve_video', 'analyze_video'] as const;

// Task 4: statusUrl is a TOP-LEVEL field on every completed result (not
// per-item) -- `null` when the endpoint is disabled. `null`, unlike
// `undefined`, survives JSON.stringify, which is what makes "statusUrl:
// null when disabled" actually reach the wire rather than being silently
// dropped as an absent key. Required, not optional, so a future call site
// cannot forget to pass it and silently omit the field.
const toResult = <T extends object>(r: T, statusUrl: string | null): CallToolResult =>
  ({ content: [{ type: 'text', text: JSON.stringify({ ...r, statusUrl }, null, 2) }] });

const PLATFORMS =
  'Known-working sources: YouTube, TikTok, Facebook and Reels, X/Twitter, Instagram, '
  + 'Twitch, Vimeo, Reddit, WeChat Channels, and direct .mp4/.m3u8 URLs. Many other '
  + 'sites work through generic extraction; some will not, and those return a clear '
  + 'failure status rather than throwing.';

const LIFETIME =
  'Artifacts written to destinationPath are NEVER deleted by this tool -- pick a '
  + 'temp directory if you want them ephemeral. In background-task mode the task '
  + 'handle expires (default 30 minutes) and dies with the server process, but the '
  + 'files are the durable result and survive both.';

// Task 7 (spec §9): one sentence, dictated verbatim by the plan, appended to
// BOTH tool descriptions -- factored into a shared constant for the same
// reason LIFETIME/PLATFORMS/BATCHING already are (one source, no risk of the
// two copies drifting apart). Do not edit this string for style; it is
// frozen text, same as the rest of ANALYZE_DESCRIPTION/RESOLVE_DESCRIPTION.
const STATUS_NOTE =
  'In background-task mode the reply also carries statusUrl, a local HTTP '
  + 'address: GET it for every video this server is working on, with stage '
  + 'history, timestamps and raw activity samples (child process CPU, bytes '
  + 'written) -- observations only, no judgments; fetch it twice and compare '
  + 'to tell slow from stuck.';

const BATCHING =
  'videos is an array: pass one item for a single video, several to process a batch '
  + 'in one call. One video writes directly into destinationPath; several each write '
  + 'into destinationPath/video-1/, video-2/ ... in array order. Results come back as '
  + 'one entry per item, in order, each with its own status -- one video failing '
  + 'never fails the others.';

const SERVER_INSTRUCTIONS =
  'Video extraction for AI agents, in two tools. resolve_video looks videos up and, by '
  + 'default, returns only metadata -- title, creator, duration and chapters -- without '
  + 'downloading anything heavy; pass returnVideo: true per item when you want the media '
  + 'file. analyze_video does the real work: transcript plus important, deduplicated '
  + 'keyframes. Both take a videos array (one item is the common case) and write output '
  + 'to a directory you choose (destinationPath), returning a compact summary plus file '
  + 'paths rather than dumping everything into the conversation. Both also support MCP '
  + 'background tasks: called as a task, they return a handle immediately and push '
  + 'status notifications while the work runs -- useful because a full analysis of a '
  + 'long video takes minutes. A good habit on a long video is to call resolve_video '
  + 'first, read the chapter list, then analyze only the section that matters.';

const analyzeItemSchema = z.object({
  pathOrUrl: z.string().describe('A video URL, or a path to a video file already on this machine. Both are accepted.'),
  start: z.number().optional().describe('Start second of the range to analyze. Provide with end; either alone is ignored. Note that if pathOrUrl is a clip previously fetched with a range, times are relative to that clip, which starts at 0.'),
  end: z.number().optional().describe('End second of the range. Set equal to start for a single instant (requires frames: "even").'),
  frames: z.enum(['key', 'even', 'none']).optional().describe('"key" (default): the most informative frames, deduplicated. "even": uniform sampling across the range. "none": no frames (transcript only).'),
  maxFrames: z.number().optional().describe('Maximum frames to return. With frames "even" this sets density across the range. 0 with frames omitted means the same as frames: "none". Default 35.'),
  transcript: z.boolean().optional().default(true).describe('Produce a transcript. Set false to skip transcription entirely when you only want frames.'),
  language: z.string().optional().describe('Language hint such as "zh", "ja" or "en". Usually inferred from the platform; supply it when the source carries no language metadata or the guess is wrong.'),
});

// Note: `frames` deliberately carries no `.default('key')` -- the 0.1.0 Fix 3
// invariant. A schema-level default would mean `frames` is NEVER undefined
// by the time it reaches resolveFrameMode (src/types.ts), which would make
// the maxFrames:0-with-frames-omitted alias to frames:'none' unreachable
// through this server (tests/mcp.test.ts pins this). `maxFrames` similarly
// carries no `.default(35)`: src/analyze.ts:77's own `opts.maxFrames ?? 35`
// already supplies that default deeper in the pipeline, so an omitted
// maxFrames still behaves as 35 without the schema needing to duplicate it.
const ANALYZE_DESCRIPTION =
  'Given video URLs or local video files, returns for each its transcript and a small '
  + 'set of important, deduplicated keyframes -- not every frame, just the ones that '
  + 'carry information (scene changes, on-screen text, visual novelty). Output is '
  + 'written to destinationPath: per video a manifest, the transcript, and the frame '
  + 'images; the reply is one compact summary per video plus those paths, with a '
  + 'transcript included inline when it is short. The transcript comes from the '
  + "platform's own captions whenever the video has any -- human-written ones first, "
  + "otherwise the platform's automatic ones -- and speech is transcribed locally only "
  + 'for videos with no captions at all; transcript.source tells you which you got. '
  + BATCHING + ' Use start/end per item to analyze only part of a video -- for supported '
  + 'sources only that section is downloaded, and the transcript covers just that '
  + 'section (the single-instant recipe below is the one exception: nothing is trimmed '
  + 'there, so a transcript, if requested, covers the whole video). frames controls how '
  + 'frames are chosen per item; for a single exact frame, set start and end to the same '
  + 'second with frames: "even", maxFrames: 1 and transcript: false. On failure an item '
  + 'returns a status that is not "ok" with a readable reason, rather than throwing -- '
  + "always check each item's status first, and check its warnings: any optional stage "
  + 'that failed and was skipped past records an entry there, so an empty transcript can '
  + 'be told apart from a video that simply has no speech. Called as a background task, '
  + 'this returns a handle immediately; progress arrives as status messages like '
  + '"video 2/3: transcribing" or "queued, 1 ahead" (analyses run through a concurrency '
  + 'pool, default 4 at once, VIDEO_EXTRACT_MAX_CONCURRENCY to change; ~1.1 GB peak per '
  + 'concurrent analysis, so total footprint is about concurrency x 1.1 GB -- plan for '
  + '~4.5 GB at the default cap of 4, and VIDEO_EXTRACT_MAX_CONCURRENCY=1 restores the '
  + 'old flat under-2GB behavior). A queued task can be cancelled; a task '
  + 'whose work has already started cannot -- it will refuse, finish, and deliver its '
  + 'result. ' + STATUS_NOTE + ' ' + LIFETIME + " Each item's result also carries videoPath, the local file it "
  + 'worked from, which you can pass straight back in to inspect another moment without '
  + 're-downloading. ' + PLATFORMS;

const resolveItemSchema = z.object({
  url: z.string().describe('Page or direct video URL.'),
  returnVideo: z.boolean().optional().default(false).describe('Download the media file as well as its metadata. Default false -- metadata only.'),
  start: z.number().optional().describe('Start second of the section to fetch. Only meaningful with returnVideo: true. Provide with end; either alone is ignored and the whole video is fetched.'),
  end: z.number().optional().describe('End second of the section to fetch. Only meaningful with returnVideo: true. Provide with start; either alone is ignored and the whole video is fetched.'),
  comments: z.boolean().optional().default(false).describe('Also fetch comments into the metadata file. Off by default: can be very slow on popular videos.'),
});

const RESOLVE_DESCRIPTION =
  'Looks up videos and writes what it finds to destinationPath. By DEFAULT it returns '
  + 'metadata only and does NOT download media: per video the title, creator, duration, '
  + 'chapter list (when the platform provides one), a short description preview, and a '
  + 'path to the full metadata file. That is the cheap way to decide what to do next. '
  + "Set returnVideo: true on an item to also download that video's media file -- a "
  + 'real download that takes real time. With returnVideo: true you may also pass '
  + 'start/end (both together; either alone is ignored and fetches the whole video) to '
  + 'fetch only a section; for supported sources only that section is downloaded, and a '
  + 'fetched clip STARTS AT 0 rather than at the original timestamp (the result says '
  + 'so, and gives the offset). ' + BATCHING + ' Use this tool when you only need to know '
  + 'what videos are, or when you want video files without any analysis. Called as a '
  + 'background task it returns a handle immediately and reports status while it runs; '
  + 'resolve work is never queued behind analyses. ' + STATUS_NOTE + ' ' + LIFETIME + ' ' + PLATFORMS + ' Comments are '
  + 'off by default and can be slow to fetch on popular videos; when enabled they are '
  + 'written to the metadata file, never returned inline.';

// Task 6: honest cancellation (spec §8/§13, task-1-report.md's fact (c)).
// Queued-cancel is enforced here -- inside the pool-wrapped fn, which only
// ever runs once a slot is actually granted (never while genuinely queued
// in the pool's own waiters list -- see slots.ts) -- because that is the
// one place execution can still be intercepted before the task becomes
// non-cancellable (see HonestCancelStore below). checkCancelled consults
// the task's OWN status through the same extra.taskStore wrapper the rest
// of the handler uses.
//
// Ordering fix (post-commit review finding, task-6-report.md "Fix report"
// section): onItemStart marks store.executing FIRST, synchronously, before
// checkCancelled's own await -- not after, as originally shipped. The
// original order (check, then mark once fn() itself ran) left a genuine
// TOCTOU window: a cancel landing between the check resolving false and the
// mark actually happening would be ACCEPTED (executing not yet set) even
// though the item was already committed to running to completion moments
// later -- probed deterministically (60/60) once that interleaving is
// engineered, though naturally occurring under normal timing in 0/40 trials.
// Marking first closes it: once a slot is granted, the task is committed to
// running (barring a cancellation already recorded from its genuinely-queued
// window, which checkCancelled below still detects), so refusing cancellation
// from that instant on is the honest choice even before the item's real work
// has literally started.
class TaskCancelledError extends Error {
  constructor() { super('task was cancelled before this item started'); this.name = 'TaskCancelledError'; }
}

/**
 * Shared by BOTH the Critical-1 (premature-expiry) and Important-3
 * (zombie-process) final-whole-branch-review fixes on HonestCancelStore
 * below: reaches into InMemoryTaskStore's own private `cleanupTimers:
 * Map<string, NodeJS.Timeout>` bookkeeping (verified against the installed
 * SDK, node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/
 * stores/in-memory.js -- `private` in the SDK's own .d.ts, so this needs a
 * cast). Deliberately the narrowest, most stable thing available to depend
 * on: a plain identity map whose existence the class's own public
 * `cleanup()` method already implies, versus the alternative of mutating
 * the *returned* Task's `.ttl` field and relying on it being the SAME
 * object reference the store keeps internally -- an aliasing detail
 * `getTask`'s own defensive `{ ...stored.task }` copy shows is not a
 * contract this same file otherwise honors. If this field is ever renamed,
 * every call below fails loudly (TypeError on the very next task creation)
 * rather than silently reverting to the old, wrong behavior -- worth
 * knowing given the SDK's `@experimental` tag on this whole module.
 */
function cleanupTimerFor(store: InMemoryTaskStore, taskId: string): NodeJS.Timeout | undefined {
  return (store as unknown as { cleanupTimers: Map<string, NodeJS.Timeout> }).cleanupTimers.get(taskId);
}

/** Spec §8: cancellation is honest or absent. Queued tasks cancel fully;
 *  a task whose work has started refuses -- a task that reports cancelled
 *  while quietly finishing its download is exactly the dishonesty class
 *  this project exists to kill. */
class HonestCancelStore extends InMemoryTaskStore {
  readonly executing = new Set<string>();

  // Final whole-branch review, CRITICAL finding 1: the base class's own
  // createTask (in-memory.js) arms its cleanup timer AT CREATION, before
  // any real work has run -- a task whose work outlives the configured ttl
  // (default 30 minutes; reachable by one long analysis or a batch queued
  // behind the concurrency cap) had its row deleted MID-FLIGHT:
  // storeTaskResult('completed', ...) then throws "Task ... not found"
  // (swallowed by this file's own inner try/catch, same as a genuine
  // cancellation race), the task never reaches a terminal state, and a
  // plain caller sees "Task not found" for work that went on to succeed on
  // disk seconds later (reviewer probe: scratch/probe2-ttl-inflight.ts,
  // TTL 1.5s vs 4s of work). Spec §9 is explicit that the handle's lifetime
  // counts from COMPLETION, not creation -- storeTaskResult and
  // updateTaskStatus already implement exactly that re-arm-on-terminal-
  // transition behavior (untouched below), so this override's only job is
  // to stop the ORIGINAL, pre-completion timer from ever being armed.
  //
  // The base class's createTask body is entirely synchronous (no `await`
  // anywhere in it, despite being declared `async`), so by the time
  // `super.createTask()`'s returned promise settles, the timer this method
  // is about to cancel has already been registered in cleanupTimers, with
  // ZERO wall-clock time elapsed -- setTimeout callbacks run on the
  // macrotask queue, never inside a microtask flush, so there is no window
  // in which it could fire first, even at ttl:1. `task.ttl` itself is left
  // completely untouched by this override, so it still holds whatever the
  // base class decided the real ttl is -- exactly what the terminal-
  // transition re-arm logic reads to arm the correct timer, counting from
  // completion, once the task actually finishes.
  override async createTask(
    taskParams: Parameters<InMemoryTaskStore['createTask']>[0],
    requestId: Parameters<InMemoryTaskStore['createTask']>[1],
    request: Parameters<InMemoryTaskStore['createTask']>[2],
    sessionId?: Parameters<InMemoryTaskStore['createTask']>[3],
  ): Promise<Task> {
    const task = await super.createTask(taskParams, requestId, request, sessionId);
    const armed = cleanupTimerFor(this, task.taskId);
    if (armed) {
      clearTimeout(armed);
      (this as unknown as { cleanupTimers: Map<string, NodeJS.Timeout> }).cleanupTimers.delete(task.taskId);
    }
    return task;
  }

  // Final whole-branch review, IMPORTANT finding 3: every cleanup timer the
  // base class arms is a plain, ref'd setTimeout, which alone keeps the
  // Node event loop -- and so the whole stdio server process -- alive
  // until it fires (default ttl 30 minutes). A session that made even one
  // call otherwise lingers for the full TTL after stdin EOF, for no reason
  // a client could ever observe or benefit from (reviewer probe:
  // scratch/probe5-linger.mjs -- no call exits ~102ms; one call at the
  // default TTL is still alive at 12s).
  //
  // A transport/server-close hook (Protocol's own public `onclose`,
  // reachable uncast via `server.server.onclose` -- see buildServer below)
  // was the other option the review named, and was tried first. It does
  // NOT work for this pinned SDK: confirmed both by reading
  // StdioServerTransport (server/stdio.js), which registers only
  // 'data'/'error' listeners on stdin and NEVER 'end' or 'close', and
  // empirically (scratch/onclose-probe.mjs -- server.server.onclose is set,
  // stdin is closed, and it never fires). Nothing in the pinned SDK calls
  // the transport's own close() -- and so nothing ever invokes `onclose` --
  // on a clean stdio EOF at all; only a read-buffer parse error reaches it.
  // That rules out a close-hook fix for this specific SDK/transport
  // combination, leaving unref as the only fix that actually reaches the
  // real bug. `.unref()` only affects whether a timer can keep an
  // otherwise-idle process alive on its own -- it still fires normally, on
  // schedule, in any process (a test run, a future non-stdio transport)
  // that has other work keeping its event loop open anyway, so this cannot
  // change *when* a handle expires, only whether a fully-idle process waits
  // around for it.
  private unrefCleanupTimer(taskId: string): void {
    cleanupTimerFor(this, taskId)?.unref();
  }

  override async updateTaskStatus(
    taskId: string, status: Parameters<InMemoryTaskStore['updateTaskStatus']>[1],
    statusMessage?: string, sessionId?: string,
  ): Promise<void> {
    if (status === 'cancelled' && this.executing.has(taskId)) {
      throw new Error("this task's work has already started and cannot be cancelled; it will finish and deliver its result");
    }
    await super.updateTaskStatus(taskId, status, statusMessage, sessionId);
    this.unrefCleanupTimer(taskId);
  }

  // The base class's OTHER terminal-transition entry point (the one this
  // file's own createTask handlers call directly on every successful
  // completion or failure) -- it re-arms a cleanup timer exactly like
  // updateTaskStatus's terminal branch does, so it needs the identical
  // unref treatment.
  override async storeTaskResult(
    taskId: string, status: Parameters<InMemoryTaskStore['storeTaskResult']>[1],
    result: Parameters<InMemoryTaskStore['storeTaskResult']>[2], sessionId?: string,
  ): Promise<void> {
    await super.storeTaskResult(taskId, status, result, sessionId);
    this.unrefCleanupTimer(taskId);
  }
}

type Store = HonestCancelStore;
const label = (i: number, n: number, msg: string) => (n === 1 ? msg : `video ${i + 1}/${n}: ${msg}`);

/**
 * Task 4: registers every item up front, before any execution starts, so
 * the SAME ids array is visible both to the per-item hook wiring below AND
 * to createTask's own outer .catch() -- which needs it to finish() registry
 * entries even when the whole call rejects (wrapper breakage, or a
 * queued-cancel that leaves items registered but never run -- see the
 * .catch() at each createTask call site below). destinationPath per item is
 * the item's OWN working directory (itemDir), not the shared parent
 * destinationPath, so the endpoint's workDirBytes sampling reflects each
 * item alone in a batch rather than the whole call's combined footprint.
 */
function registerItems(
  statusRegistry: StatusRegistry, tool: 'analyze' | 'resolve', destinationPath: string,
  urls: string[], taskId: string,
): number[] {
  const n = urls.length;
  return urls.map((url, i) => statusRegistry.register({
    url, tool, taskId, destinationPath: itemDir(destinationPath, i, n),
  }));
}

function runAnalyzeExecution(
  args: AnalyzeToolArgs, pool: SlotPool, statusRegistry: StatusRegistry, ids: number[],
  onUpdate?: (message: string) => void, onItemStart?: (itemIndex: number) => void,
  checkCancelled?: () => Promise<boolean>,
): Promise<AnalyzeToolResult> {
  const n = args.videos.length;
  return analyzeVideoTool(args, {
    run: (fn, onQueued) => pool.run(async () => {
      // Mark FIRST, before the checkCancelled await -- see the ordering-fix
      // comment above this function. onItemStart's itemIndex argument is
      // unused by its only real caller (store.executing.add(task.taskId)
      // ignores which item started), so an index-less call is safe; it is
      // invoked directly here rather than threaded through
      // analyzeVideoTool's own onItemStart hook (which would fire only
      // after checkCancelled and fn() itself ran -- too late to close the
      // race this exists to close).
      onItemStart?.(-1);
      if (await checkCancelled?.()) throw new TaskCancelledError();
      return fn();
    }, onQueued),
    // Task 4: onStage ALSO mirrors into the status registry -- two readers
    // of the one event, not a replacement for the existing statusMessage
    // mapping (the brief's own "two readers, one event" framing).
    onStage: (i, s) => { statusRegistry.stage(ids[i]!, s); onUpdate?.(label(i, n, s)); },
    onQueued: (i, ahead) => onUpdate?.(label(i, n, `queued, ${ahead} ahead`)),
    onSpawn: (i, pid, cmd) => statusRegistry.spawn(ids[i]!, pid, cmd),
    onSpawnEnded: (i) => statusRegistry.spawnEnded(ids[i]!),
    // Final whole-branch review, Important finding 2: finishes THIS item
    // the instant its own promise settles (analyzeVideoTool's per-item
    // chain -- see that file's own comment), instead of only once every
    // item in the batch has. The forEach below, after runAnalyzeExecution
    // resolves, stays in place as a backstop for any id this seam somehow
    // misses; registry.finish() is idempotent (first write wins), so
    // running both is harmless, not a double-write hazard.
    onItemDone: (i, status) => statusRegistry.finish(ids[i]!, status),
  });
}

// Task 5: the version string stamped into the status endpoint's own
// `StatusServerInfo` (below) and the discovery registry's `ServerEntry` --
// factored into one constant, rather than independent '0.3.0' literals,
// specifically so a future edit to one cannot silently drift from the
// other; the two describe the exact same server. Task 7 folds McpServer's
// own `serverInfo.version` (below) into the same constant too, closing the
// skew Task 4's report flagged (the endpoint read '0.3.0' while McpServer
// still read '0.2.0') -- all three now name one server, one version.
const STATUS_VERSION = '0.3.0';

// Task 5: cross-session discovery (src/status/discovery.ts). Installed at
// most ONCE per OS process no matter how many times buildServer() runs --
// the existing test suite alone calls it 35+ times across
// tests/mcp.test.ts and tests/taskLifecycle*.test.ts, all inside the same
// process. A second install would mean N duplicate 'exit' listeners (each
// harmlessly re-filtering an already-filtered list) and N duplicate
// SIGINT/SIGTERM listeners each independently calling process.exit(0) --
// wasteful, and the kind of listener-accumulation Node warns about past 10.
//
// Guarded with a plain module-level flag rather than e.g. `once: true`
// event options, because THREE listeners (exit + SIGINT + SIGTERM) need to
// go up together exactly once, not independently.
//
// The 'exit' handler runs synchronously by Node's own contract -- no async
// work is possible inside an 'exit' listener at all -- which is exactly
// what unregisterServer's all-sync-fs-calls implementation provides.
// SIGINT/SIGTERM call process.exit() explicitly: registering a listener for
// either suppresses Node's default terminate-the-process behavior, so
// without an explicit exit() call the process would hang waiting for
// something else to end it. Verified empirically (see task report) that a
// bare SIGINT/SIGTERM listener does NOT, on its own, keep the event loop
// alive the way an active timer or socket handle would -- Node's internal
// signal watcher is unref'd -- so installing these cannot reintroduce the
// 0.2.0 zombie-process class tests/mcpProcessLifecycle.test.ts guards
// against, and does not interfere with that file's own stdin-EOF exit path
// (a different signal entirely).
let discoveryExitHandlersInstalled = false;
function installDiscoveryExitHandlersOnce(): void {
  if (discoveryExitHandlersInstalled) return;
  discoveryExitHandlersInstalled = true;
  process.on('exit', () => { unregisterServer(process.pid); });
  const onTerminatingSignal = (): void => { process.exit(0); };
  process.on('SIGINT', onTerminatingSignal);
  process.on('SIGTERM', onTerminatingSignal);
}

/**
 * Exposes the finished engine to AI agents over MCP. Both tools are
 * registered with `server.experimental.tasks.registerToolTask` (not the
 * plain `registerTool` the 0.1.x surface used) and
 * `execution: { taskSupport: 'optional' }` -- this single registration
 * serves both an ordinary synchronous `client.callTool()` and a
 * task-augmented background call from the same handler triple
 * (`createTask`/`getTask`/`getTaskResult`), rather than needing two
 * separate code paths. The fact this whole design leans on -- that a plain
 * call against an 'optional' task-registered tool is served by the SDK's
 * own automatic task-polling (`handleAutomaticTaskPolling` in
 * `server/mcp.js`), with no capability declaration and no separate
 * non-task handler required -- was verified empirically against the
 * installed SDK (1.30.0) before any of this was written: see
 * task-1-report.md's "linchpin" finding, pinned permanently by
 * `tests/taskSpike.test.ts`. `registerToolTask` is itself an
 * `@experimental` API, which is why the SDK dependency is pinned to an
 * exact version rather than a caret range (spec §10).
 */
export function buildServer(opts?: { analyzeSlots?: SlotPool; statusPort?: number | null }): McpServer {
  const pool = opts?.analyzeSlots ?? createSlotPool(analyzeConcurrencyFromEnv());
  const store: Store = new HonestCancelStore();
  // Task 4: per-server instances -- same no-module-state rule `store`/`pool`
  // already follow. `opts.statusPort` (test seam) overrides the env reader
  // when explicitly provided (including `null`, hence the `!== undefined`
  // check rather than `??`); left unset, `statusPortFromEnv()` decides
  // (default: ephemeral port, endpoint ON). The endpoint's own `version`
  // (STATUS_VERSION) and McpServer's own `serverInfo.version` just below
  // now both read from that ONE constant (Task 7: reconciles the skew
  // Task 4's report flagged -- the endpoint reported '0.3.0' while
  // McpServer's construction still read '0.2.0', matching package.json's
  // then-published version; package.json is '0.3.0' now too, so all three
  // agree).
  //
  // Task 5: `startedAt` captured once, here, rather than calling Date.now()
  // separately for the endpoint's StatusServerInfo and for the discovery
  // registry's ServerEntry below -- both describe the SAME server starting
  // at the SAME instant, and two independent Date.now() calls would (very
  // slightly, but needlessly) disagree.
  const startedAt = Date.now();
  const statusRegistry: StatusRegistry = createStatusRegistry();
  const statusEndpoint = startStatusEndpoint(
    statusRegistry,
    {
      pid: process.pid,
      version: STATUS_VERSION,
      startedAt,
      concurrency: () => ({ cap: pool.cap, running: pool.running, queued: pool.queued }),
    },
    opts?.statusPort !== undefined ? opts.statusPort : statusPortFromEnv(),
  );
  // Task 5: cross-session discovery (src/status/discovery.ts) -- registers
  // this server into the discovery file once its ephemeral port is known,
  // so a CLI on the same machine can find and merge every live server's
  // status, not just whichever one it happens to be talking to. Registered
  // only when the endpoint actually resolves to a live URL (a disabled
  // endpoint -- VIDEO_EXTRACT_STATUS_PORT=0 -- has no port for a CLI to
  // reach, so it has nothing to register); the exit-handler install is
  // guarded the same way, one level up (installDiscoveryExitHandlersOnce),
  // so a server built with the endpoint disabled never burns that guard for
  // a later, live one built in the same process.
  //
  // Fire-and-forget: buildServer() itself must stay synchronous (35+
  // existing call sites across the test suite depend on getting a
  // McpServer back, not a Promise<McpServer>), so this resolves in the
  // background, after buildServer() has already returned. No `.catch()` is
  // needed at this call site: `statusEndpoint.url` itself never rejects
  // (every failure path in endpoint.ts resolves null instead of throwing),
  // and registerServer is internally best-effort -- see discovery.ts's own
  // doc comment -- so there is no remaining path here that could produce an
  // unhandled rejection.
  void statusEndpoint.url.then((su) => {
    if (su === null) return;
    installDiscoveryExitHandlersOnce();
    registerServer({ pid: process.pid, port: Number(new URL(su).port), startedAt, version: STATUS_VERSION });
  });
  const server = new McpServer(
    { name: 'norma-video', version: STATUS_VERSION },
    {
      taskStore: store,
      instructions: SERVER_INSTRUCTIONS,
      // Task 6 gap-fix, found via advisor review against task-1-report.md's
      // spike deviation #1: capabilities are never inferred from taskStore
      // or from registerToolTask -- without this explicit declaration the
      // client's isToolTask() stays permanently false and
      // callToolStream()/cancelTask() silently collapse onto the plain
      // automatic-polling fallback (fact (a)), never reaching the real
      // task-augmented path cancellation depends on. Task 5 never surfaced
      // this because tests/mcp.test.ts only makes plain calls, which fact
      // (a) confirms need no capability declaration at all. Shape taken
      // directly from tests/taskSpike.test.ts's own working server.
      capabilities: { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } },
    },
  );

  server.experimental.tasks.registerToolTask(
    'analyze_video',
    {
      title: 'Analyze video',
      description: ANALYZE_DESCRIPTION,
      inputSchema: {
        destinationPath: z.string().describe('Directory to write manifests, transcripts and frames into. Created if missing.'),
        videos: z.array(analyzeItemSchema).min(1).describe('One entry per video to analyze. One item = single video, flat layout; several = video-N subdirectories.'),
      },
      // Fix 4(c): both tools write to the user's filesystem -- metadata,
      // media, manifest, transcript and frame images -- and both delete
      // their own working files afterwards. readOnlyHint:true was false,
      // and clients make trust decisions on this annotation.
      annotations: { readOnlyHint: false, openWorldHint: true },
      execution: { taskSupport: 'optional' },
    },
    {
      createTask: async (args, extra) => {
        // Final whole-branch review, Important finding 2: the SDK's
        // automatic task-polling bridge (handleAutomaticTaskPolling,
        // server/mcp.js) sleeps a full pollInterval BEFORE its first status
        // check, no matter how fast the work actually finishes -- so every
        // plain call against a task-registered tool carries that floor.
        // createTask's own default (in-memory.js: `pollInterval:
        // taskParams.pollInterval ?? 1000`) made that floor ~1000ms for
        // every plain call this server ever served (reviewer probe:
        // scratch/probe1-latency.ts -- ~1004ms vs 0-2ms on a 0.1.x-shaped
        // server for identical work). Passing pollInterval here plumbs
        // straight through to that same default, cutting the floor to
        // ~150ms -- still nonzero (honestly documented in README.md's
        // Background tasks section), but no longer close to a full second.
        const task = await extra.taskStore.createTask({ ttl: taskTtlMsFromEnv(), pollInterval: 150 });
        // Task 4: stamp the status url into the HANDLE reply, before the
        // background executor below is even started -- not "after", despite
        // the brief's own looser phrasing. shared/protocol.js's
        // requestStream() yields 'taskCreated' with EXACTLY this handler's
        // RETURNED task object (verified directly against the installed
        // SDK: no further server- or client-side re-fetch happens in
        // between), so whatever is stamped here is what a task-mode
        // caller's first message shows, deterministically -- not a race
        // against the executor's own first onUpdate() call, which writes
        // statusMessage on the same task row once real progress exists.
        // Running this BEFORE the `void (async () => {...})()` below still
        // executes strictly before the client can ever learn this taskId
        // (createTask's own handler has not returned yet either way), so
        // the honest-cancellation ordering invariant documented at
        // onItemStart below is unaffected by moving this here.
        const su = await statusEndpoint.url;
        let handleTask = task;
        if (su !== null) {
          await extra.taskStore.updateTaskStatus(task.taskId, 'working', `status: ${su}`);
          handleTask = (await extra.taskStore.getTask(task.taskId)) ?? task;
        }
        const typedArgs = args as AnalyzeToolArgs;
        const ids = registerItems(
          statusRegistry, 'analyze', typedArgs.destinationPath,
          typedArgs.videos.map((v) => v.pathOrUrl), task.taskId,
        );
        void (async () => {
          try {
            const r = await runAnalyzeExecution(
              typedArgs, pool, statusRegistry, ids,
              (m) => void extra.taskStore.updateTaskStatus(task.taskId, 'working', m).catch(() => {}),
              () => { store.executing.add(task.taskId); },
              async () => {
                const cancelled = (await extra.taskStore.getTask(task.taskId))?.status === 'cancelled';
                // Final whole-branch review, Minor finding 8: analyzeVideoTool
                // fires every item's pool.run() concurrently (Promise.all),
                // so on a queued-cancel of a batch with N>=3 items still
                // queued, whichever item's checkCancelled sees 'cancelled'
                // FIRST is not necessarily the LAST one to run through this
                // seam -- the outer finally below (which deletes taskId from
                // store.executing exactly once, when the whole
                // runAnalyzeExecution promise settles) can already have run
                // while later items are still queued behind it in the pool,
                // each independently re-adding taskId via onItemStart the
                // moment its own slot is eventually granted -- a leak with
                // nothing left to ever clean it up again. Deleting right
                // here, on every detection, closes that: safe because a
                // cancelled task can never have a running item past this
                // checkpoint (every item's run wrapper checks cancellation
                // before calling its real fn()), so this can never delete out
                // from under genuinely running work.
                if (cancelled) store.executing.delete(task.taskId);
                return cancelled;
              },
            ).catch((e: unknown) => {
              // Task 4: whatever ids were registered above never reached a
              // per-item finish() below -- either genuine wrapper breakage,
              // or every item throwing TaskCancelledError because the whole
              // task was cancelled while every item was still queued.
              // HonestCancelStore refuses a cancel once ANY item has started
              // (store.executing), so those two are the ONLY ways this
              // promise can reject -- never a mix of some items genuinely
              // completed and others still registered-but-unfinished.
              //
              // Corrected per review: this fires EVENTUALLY, not
              // immediately. For a queued-cancel, the promise only rejects
              // once each item finally reaches its own slot and
              // checkCancelled() runs -- bounded by however long the pool
              // stays saturated ahead of it (proportional to queue depth,
              // not instant). Until then, those ids sit at outcome:
              // undefined -- STALE, indistinguishable from a healthy queued
              // item, but self-healing: the pool draining is exactly what
              // triggers this .catch(). What finish() here prevents is the
              // PERMANENT case -- without it, once this promise finally
              // does settle, those ids would sit at outcome: undefined
              // forever (enforceCap never evicts an item without an
              // outcome). Pinned by tests/mcp.test.ts's "a
              // queued-then-cancelled batch eventually finishes its
              // registry entries" test, which asserts both the transient
              // stale window and the eventual healed state via bounded
              // polling, not a fixed sleep. Re-thrown unchanged so the
              // existing catch below (which still needs to tell
              // TaskCancelledError apart from a real crash) is untouched.
              ids.forEach((id) => statusRegistry.finish(id, 'wrapper_failed'));
              throw e;
            });
            r.videos.forEach((v, i) => statusRegistry.finish(ids[i]!, v.status));
            try {
              await extra.taskStore.storeTaskResult(task.taskId, 'completed', toResult(r, su));
            } catch {
              // Post-ordering-fix (see the comment above runAnalyzeExecution),
              // a genuine cancellation race is closed here: onItemStart marks
              // store.executing BEFORE checkCancelled ever runs, so once any
              // item's slot is granted, every cancel attempt refuses through
              // to completion -- there is no remaining window where a
              // legitimately-running item's eventual 'completed' write loses
              // to a cancel that landed after it was already committed to
              // running. What CAN still make this write fail is unrelated to
              // cancellation: TTL expiry deletes the task row outright (a
              // distinct "task not found" throw, not a terminal-status
              // conflict) if the configured ttl is short enough to fire
              // before this line runs (task-6-report.md's TTL test deals
              // with exactly this). Either way the store's own state is
              // already authoritative by the time we get here -- swallow
              // rather than falling into the 'failed' branch below, which
              // would also be refused/pointless for the same reason.
            }
          } catch (e) {
            // Queued-cancel: the pre-item check above threw because the
            // store already holds 'cancelled' -- that state is durable and
            // complete on its own; there is nothing further to store.
            if (e instanceof TaskCancelledError) return;
            // Spec §8: task-failed is reserved for the wrapper itself breaking.
            await extra.taskStore.storeTaskResult(task.taskId, 'failed', {
              content: [{ type: 'text', text: `task execution failed: ${e instanceof Error ? e.message : String(e)}` }],
              isError: true,
            }).catch(() => {});
          } finally {
            store.executing.delete(task.taskId);
          }
        })();
        return { task: handleTask };
      },
      getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_args, extra) => (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult,
    },
  );

  server.experimental.tasks.registerToolTask(
    'resolve_video',
    {
      title: 'Resolve video (metadata, optionally the file)',
      description: RESOLVE_DESCRIPTION,
      inputSchema: {
        destinationPath: z.string().describe('Directory to write metadata (and the video, if requested) into. Created if missing. Re-running the same call overwrites in place.'),
        videos: z.array(resolveItemSchema).min(1).describe('One entry per video to resolve. One item = single video, flat layout; several = video-N subdirectories.'),
      },
      // Fix 4(c): both tools write to the user's filesystem -- metadata,
      // media, manifest, transcript and frame images -- and both delete
      // their own working files afterwards. readOnlyHint:true was false,
      // and clients make trust decisions on this annotation.
      annotations: { readOnlyHint: false, openWorldHint: true },
      execution: { taskSupport: 'optional' },
    },
    {
      // Spec §6: resolve_video loads no models -- it is network and ffmpeg
      // -- so, unlike analyze_video, it never goes near the slot pool.
      //
      // Task 6 CRITICAL fix (post-commit review finding, task-6-report.md
      // "Fix report" section, spec §8): this handler now marks
      // store.executing for its entire run. Originally it never did, on the
      // reasoning that honest cancellation was analyze_video's mandate
      // alone -- proven wrong live (network leaf mocked with a delay):
      // cancelTask() on a running resolve task was ACCEPTED while the
      // download kept running, and getTask reported 'cancelled' forever
      // while the work quietly finished underneath -- exactly the
      // dishonesty class spec §8 names, and spec §8 carries no tool
      // qualifier. resolve_video never queues (unlike analyze_video, it has
      // no pool phase to intercept a cancel against at all -- spec §7 still
      // requires it to "report working until done"), so marking it
      // executing immediately, before its only await, is what makes EVERY
      // cancel attempt on a live resolve task refuse: there is no
      // meaningful "queued, not yet started" window to distinguish it from.
      createTask: async (args, extra) => {
        // Important finding 2 (see analyze_video's own createTask above for
        // the full rationale): same pollInterval, same ~1000ms -> ~150ms
        // plain-call floor reduction.
        const task = await extra.taskStore.createTask({ ttl: taskTtlMsFromEnv(), pollInterval: 150 });
        // Task 4: same statusUrl stamp as analyze_video's own createTask
        // above -- see that handler's comment for why this runs BEFORE the
        // executor IIFE (determinism against the brief's own taskCreated
        // assertion) and why it does not disturb the "before any await"
        // executing-mark invariant the comment just below still documents
        // (this still runs strictly before the client can learn the taskId
        // at all, since createTask's own handler has not returned yet).
        // Unlike analyze_video, resolve_video has no onUpdate/statusMessage
        // mechanism of its own today -- no stage-by-stage progress messages
        // are wired for it -- so this is the ONLY statusMessage this
        // handler ever writes; nothing later overwrites it.
        const su = await statusEndpoint.url;
        let handleTask = task;
        if (su !== null) {
          await extra.taskStore.updateTaskStatus(task.taskId, 'working', `status: ${su}`);
          handleTask = (await extra.taskStore.getTask(task.taskId)) ?? task;
        }
        const typedArgs = args as ResolveToolArgs;
        const ids = registerItems(
          statusRegistry, 'resolve', typedArgs.destinationPath,
          typedArgs.videos.map((v) => v.url), task.taskId,
        );
        void (async () => {
          // First statement, before any await -- the client cannot even
          // learn this taskId (createTask's own handler hasn't returned
          // yet) until after this line runs, so unlike analyze_video's
          // queued-then-granted items, there is no window at all in which a
          // cancel could land before this mark takes effect.
          store.executing.add(task.taskId);
          try {
            const r = await resolveVideoTool(typedArgs, {
              onStage: (i, s) => statusRegistry.stage(ids[i]!, s),
              onSpawn: (i, pid, cmd) => statusRegistry.spawn(ids[i]!, pid, cmd),
              onSpawnEnded: (i) => statusRegistry.spawnEnded(ids[i]!),
              // Final whole-branch review, Important finding 2: same
              // rationale as analyze_video's own runAnalyzeExecution wiring
              // above -- finishes THIS item the instant its own promise
              // settles, not only once the whole batch has. The forEach
              // below stays as a backstop; finish() is idempotent.
              onItemDone: (i, status) => statusRegistry.finish(ids[i]!, status),
            }).catch((e: unknown) => {
              // Task 4: same reasoning as analyze_video's own catch above --
              // resolve_video never queues, so every rejection here is a
              // genuine wrapper breakage (there is no queued-cancel path to
              // distinguish it from); finish what's registered so it cannot
              // pin an unevictable 'running'-forever ghost in the registry.
              ids.forEach((id) => statusRegistry.finish(id, 'wrapper_failed'));
              throw e;
            });
            r.videos.forEach((v, i) => statusRegistry.finish(ids[i]!, v.status));
            try {
              await extra.taskStore.storeTaskResult(task.taskId, 'completed', toResult(r, su));
            } catch {
              // Defensive, mirroring analyze_video's own guard (see its
              // createTask handler above): a refused write here means the
              // store was already terminal by the time this ran -- TTL
              // expiry deleting the task row outright is the one
              // remaining, genuine way that can happen (a distinct "task
              // not found" throw), since the marking above closes off any
              // cancellation-race window for resolve_video specifically.
              // Swallow rather than misreport via the 'failed' branch below.
            }
          } catch (e) {
            // Spec §8: task-failed is reserved for the wrapper itself breaking.
            await extra.taskStore.storeTaskResult(task.taskId, 'failed', {
              content: [{ type: 'text', text: `task execution failed: ${e instanceof Error ? e.message : String(e)}` }],
              isError: true,
            }).catch(() => {});
          } finally {
            store.executing.delete(task.taskId);
          }
        })();
        return { task: handleTask };
      },
      getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_args, extra) => (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult,
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

// isMainModule (src/util/entry.ts) realpaths both sides, covering the two
// known silent-failure shapes of this guard: percent-encoded spaces in the
// checkout path (this repository's own) AND symlinked invocation paths,
// where Node realpaths the main module but argv[1] stays as typed -- the
// server would otherwise exit 0 without ever connecting its transport.
if (isMainModule(import.meta.url)) void main();
