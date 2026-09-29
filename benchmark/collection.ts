import type { RenderRecord } from "./recorder";
import type { FiberCommit } from "./fiber-recorder";

export type Outcome = {
  reviews?: string;
  total?: string;
  queue?: string;
  search?: string;
  status?: string;
  sort?: string;
  detailIncludes?: string;
  favorite?: boolean;
  openCount?: string;
  rows?: number;
};
export type ActionSample = {
  records: RenderRecord[];
  fiberRenders: string[];
  fiberCommits: FiberCommit[];
  state: string;
};
export type CollectionResult =
  | { status: "complete"; sample: ActionSample }
  | { status: "retry"; reason: string };

export function beginActionWindow() {
  const timing = window.__benchmark;
  const fibers = window.__fiberBenchmark;
  if (!timing || !fibers) throw new Error("Action collection requires timing and fiber recorders");
  timing.assertComplete();
  fibers.assertComplete();
  timing.clear();
  fibers.clear();
}

// Only synchronous application workflows are supported; future async work needs its own signal.
export async function collectActionSnapshot({
  outcome,
  allowNoCommit = false,
  afterSerial,
}: {
  outcome: Outcome;
  allowNoCommit?: boolean;
  afterSerial?: number;
}): Promise<CollectionResult> {
  const timing = window.__benchmark;
  const fibers = window.__fiberBenchmark;
  if (!timing || !fibers) throw new Error("Action collection requires timing and fiber recorders");
  timing.assertComplete();
  fibers.assertComplete();
  const serial = timing.serial;
  await Promise.resolve();
  timing.assertComplete();
  fibers.assertComplete();
  if (serial !== timing.serial) return { status: "retry", reason: "commit serial changed" };
  if (afterSerial !== undefined && !allowNoCommit && timing.serial <= afterSerial)
    return { status: "retry", reason: "operation has no new completed root commit" };

  function element<T extends HTMLElement>(selector: string): T {
    const found = document.querySelector<T>(selector);
    if (!found) throw new Error(`Action snapshot is missing ${selector}`);
    return found;
  }
  const main = element("main").innerText;
  const detail = element('[aria-label="Incident detail"]').innerText;
  const reviews = element('[data-testid="reviews"]').innerText;
  const favorite = document.querySelectorAll('[aria-label="Unfavorite INC-0001"]').length;
  const actual = {
    reviews,
    total: element('[data-testid="total"]').innerText,
    queue: element('[aria-label="Incident queues"] [aria-current="page"]').textContent?.trim(),
    search: element<HTMLInputElement>('[aria-label="Search incidents"]').value,
    status: element<HTMLSelectElement>('[aria-label="Status"]').value,
    sort: element<HTMLSelectElement>('[aria-label="Sort"]').value,
    favorite: favorite === 1,
    openCount: element('[data-testid="open-count"]').innerText,
    rows: document.querySelectorAll("tbody tr").length,
  };
  for (const [key, expected] of Object.entries(outcome)) {
    if (key === "detailIncludes") {
      if (!detail.includes(String(expected)))
        return { status: "retry", reason: `detail does not contain ${expected}` };
    } else if (key === "queue") {
      if (!actual.queue?.startsWith(String(expected)))
        return { status: "retry", reason: `queue does not match ${expected}` };
    } else if (actual[key as keyof typeof actual] !== expected) {
      return { status: "retry", reason: `${key} does not match ${expected}` };
    }
  }
  const records = timing.records.map((record) => ({ ...record }));
  const fiberCommits = fibers.commits.map((commit) => ({
    ...commit,
    renders: [...commit.renders],
  }));
  const roots = records.filter((record) => record.id === "root");
  if (!allowNoCommit && !roots.length)
    return { status: "retry", reason: "no completed root commit for updating action" };
  if (roots.length !== fiberCommits.length)
    throw new Error("Action snapshot has incomplete root/diagnostic batches");
  for (const [index, root] of roots.entries()) {
    const diagnostic = fiberCommits[index];
    if (
      root.rootId !== diagnostic.rootId ||
      root.rootGeneration !== diagnostic.rootGeneration ||
      root.commitSequence !== diagnostic.commitSequence ||
      root.commitTime !== diagnostic.commitTime
    )
      throw new Error("Action snapshot has mismatched root/diagnostic batches");
  }
  return {
    status: "complete",
    sample: {
      records,
      fiberRenders: fiberCommits.flatMap((commit) => commit.renders),
      fiberCommits,
      state: JSON.stringify({ main, detail, reviews, favorite }),
    },
  };
}
