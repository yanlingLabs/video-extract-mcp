/** Spec §3: per-server in-memory status. NOTHING here touches the
 *  filesystem -- status is observable via the endpoint/CLI, and the only
 *  file the whole feature writes is the discovery registry (§7). */
export interface StatusItem {
  id: number;                       // server-unique, monotonically increasing
  url: string;
  tool: 'analyze' | 'resolve';
  taskId?: string;
  destinationPath: string;
  stageHistory: Array<{ stage: string; at: number }>;   // epoch ms; last entry = current stage
  outcome?: { status: string; at: number };             // absent while running
  childPid?: number;
  childCommand?: string;
}

export interface StatusRegistry {
  register(item: { url: string; tool: 'analyze' | 'resolve'; destinationPath: string; taskId?: string }): number; // returns id
  stage(id: number, stage: string): void;               // appends {stage, now}
  spawn(id: number, pid: number, command: string): void;
  spawnEnded(id: number): void;                          // clears childPid/childCommand
  finish(id: number, status: string): void;              // sets outcome
  snapshot(urls?: string[]): { items: StatusItem[]; evicted: number };  // deep-copied; urls = exact-match filter
}

export function createStatusRegistry(cap = 500): StatusRegistry {
  const items: StatusItem[] = [];
  let nextId = 1;
  let evicted = 0;
  const byId = (id: number) => items.find((i) => i.id === id);
  const enforceCap = () => {
    // Evict oldest COMPLETED first; a running item is never dropped (§3) --
    // dropping it would make a live child invisible to the kill workflow.
    while (items.length > cap) {
      const idx = items.findIndex((i) => i.outcome !== undefined);
      if (idx === -1) break;
      items.splice(idx, 1);
      evicted++;
    }
  };
  return {
    register(item) {
      const id = nextId++;
      items.push({ id, stageHistory: [], ...item });
      enforceCap();
      return id;
    },
    stage(id, stage) { byId(id)?.stageHistory.push({ stage, at: Date.now() }); },
    spawn(id, pid, command) { const i = byId(id); if (i) { i.childPid = pid; i.childCommand = command; } },
    spawnEnded(id) { const i = byId(id); if (i) { delete i.childPid; delete i.childCommand; } },
    finish(id, status) { const i = byId(id); if (i) i.outcome = { status, at: Date.now() }; enforceCap(); },
    snapshot(urls) {
      const filtered = urls && urls.length > 0 ? items.filter((i) => urls.includes(i.url)) : items;
      return { items: structuredClone(filtered), evicted };
    },
  };
}
