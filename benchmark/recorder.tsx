import { Profiler, type ProfilerOnRenderCallback, type ReactElement } from "react";

export type RenderRecord = {
  id: string;
  phase: Parameters<ProfilerOnRenderCallback>[1];
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
  rootId: string;
  rootGeneration: number;
  commitSequence: number;
  boundaryGeneration: number;
};
type CallbackRecord = Pick<
  RenderRecord,
  "id" | "phase" | "actualDuration" | "baseDuration" | "startTime" | "commitTime"
>;

// This experiment has one root. Descendant callbacks precede its external Profiler callback.
export function createRecorder(checkpoint: (check: () => void) => void = queueMicrotask) {
  let records: RenderRecord[] = [];
  let pending: CallbackRecord[] = [];
  const generations = new Map<string, number>();
  let rootGeneration = 0;
  let serial = 0;
  let lastCommit: RenderRecord | undefined;
  let error: string | undefined;

  function fail(message: string): never {
    error = `Profiler recorder: ${message}`;
    throw new Error(error);
  }
  function assertComplete() {
    if (error) throw new Error(error);
    if (pending.length) fail(`incomplete callback batch without root (${pending[0].commitTime})`);
  }
  const record: ProfilerOnRenderCallback = (
    id,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
  ) => {
    if (error) throw new Error(error);
    if (!id || !["mount", "update", "nested-update"].includes(phase))
      fail("invalid boundary ID or phase");
    for (const [name, value] of Object.entries({
      actualDuration,
      baseDuration,
      startTime,
      commitTime,
    })) {
      if (!Number.isFinite(value) || value < 0) fail(`invalid ${name} for ${id}`);
    }
    if (startTime > commitTime) fail(`startTime follows commitTime for ${id}`);
    if (lastCommit && commitTime <= lastCommit.commitTime)
      fail(`duplicate root, late callback, or ambiguous commitTime for ${id}`);
    if (pending.some((entry) => entry.id === id)) fail(`duplicate boundary ${id}`);
    if (pending.length && pending[0].commitTime !== commitTime)
      fail("new commit arrived before the pending root callback");
    if (!pending.length) checkpoint(assertComplete);
    pending.push({ id, phase, actualDuration, baseDuration, startTime, commitTime });
    if (id !== "root") return;

    if (phase === "mount") rootGeneration++;
    else if (!rootGeneration) fail("root update before mount");
    const nextGenerations = new Map(generations);
    for (const entry of pending) {
      if (entry.phase === "mount")
        nextGenerations.set(entry.id, (nextGenerations.get(entry.id) ?? 0) + 1);
      else if (!nextGenerations.has(entry.id)) fail(`update before mount for ${entry.id}`);
    }
    serial++;
    const batch = pending.map((entry): RenderRecord => ({
      ...entry,
      rootId: "root",
      rootGeneration,
      commitSequence: serial,
      boundaryGeneration: nextGenerations.get(entry.id)!,
    }));
    generations.clear();
    for (const [key, value] of nextGenerations) generations.set(key, value);
    records.push(...batch);
    lastCommit = batch.find((entry) => entry.id === "root")!;
    pending = [];
  };
  return {
    schemaVersion: 2 as const,
    get records() {
      return records;
    },
    get serial() {
      return serial;
    },
    get lastCommit() {
      return lastCommit;
    },
    assertComplete,
    clear() {
      assertComplete();
      records = [];
    },
    onRender: record,
  };
}
export type BenchmarkRecorder = ReturnType<typeof createRecorder>;

declare global {
  interface Window {
    __benchmark?: BenchmarkRecorder;
  }
}

export const onRender: ProfilerOnRenderCallback = (...args) => {
  if (!window.__benchmark) throw new Error("Profiler recorder is not installed");
  window.__benchmark.onRender(...args);
};

if (import.meta.env.MODE === "profile") {
  window.__benchmark = createRecorder();
}

export function Profiled({ id, children }: { id: string; children: ReactElement }) {
  return import.meta.env.MODE === "profile" ? (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  ) : (
    children
  );
}
