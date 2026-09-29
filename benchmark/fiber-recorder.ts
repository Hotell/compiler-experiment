import type { BenchmarkRecorder } from "./recorder";

export type FiberNode = {
  tag: number;
  flags: number;
  type: unknown;
  alternate: FiberNode | null;
  child: FiberNode | null;
  sibling: FiberNode | null;
  memoizedProps: { id?: string } | null;
};
export type FiberCommit = {
  rootId: string;
  rootGeneration: number;
  commitSequence: number;
  commitTime: number;
  renders: string[];
};

// Self-contained because Playwright serializes this factory into the page before React loads.
export function createFiberRecorder(getBenchmark: () => BenchmarkRecorder | undefined) {
  let commits: FiberCommit[] = [];
  let serial = 0;
  let rendererCount = 0;
  let rootIdentity: object | undefined;
  let error: string | undefined;
  let previous = new Map<
    string,
    { boundary: FiberNode; component: FiberNode; generation: number }
  >();

  function fail(message: string): never {
    error = `Fiber recorder: ${message}`;
    throw new Error(error);
  }
  function timing() {
    if (error) throw new Error(error);
    const recorder = getBenchmark();
    if (!recorder) return fail("timing recorder is missing");
    recorder.assertComplete();
    return recorder;
  }
  function assertComplete() {
    const recorder = timing();
    if (rendererCount !== 1) fail(`expected one React renderer, received ${rendererCount}`);
    if (serial !== recorder.serial) fail("incomplete diagnostic batch for completed root");
  }
  function measuredComponent(boundary: FiberNode, id: string): FiberNode {
    let child = boundary.child;
    if (!child || child.sibling) return fail(`unsupported child shape for ${id}`);
    if (child.tag === 14) {
      const memoType = child.type;
      if (
        !memoType ||
        typeof memoType !== "object" ||
        !("type" in memoType) ||
        !child.child ||
        child.child.sibling ||
        memoType.type !== child.child.type
      )
        return fail(`unsupported memo child shape for ${id}`);
      child = child.child;
    }
    if ((child.tag !== 0 && child.tag !== 15) || typeof child.type !== "function")
      return fail(`unsupported component fiber tag ${child.tag} for ${id}`);
    return child;
  }
  const hook = {
    supportsFiber: true,
    inject(renderer: { version?: string }) {
      rendererCount++;
      if (renderer.version !== "19.3.0")
        fail(`unvalidated React version ${renderer.version ?? "missing"}; expected 19.3.0`);
      if (rendererCount !== 1) fail("multiple renderers are unsupported");
      return rendererCount;
    },
    onCommitFiberRoot(rendererId: number, root: { current: FiberNode }) {
      const recorder = timing();
      if (rendererId !== 1 || rendererCount !== 1) fail("unexpected renderer");
      if (rootIdentity && rootIdentity !== root) fail("multiple roots are unsupported");
      rootIdentity = root;
      const completed = recorder.lastCommit;
      if (!completed || completed.commitSequence !== serial + 1)
        fail("hook did not follow exactly one completed external root callback");
      const callbacks = new Map(
        recorder.records
          .filter((record) => record.commitSequence === completed.commitSequence)
          .map((record) => [record.id, record]),
      );
      if (!callbacks.has("root")) fail("completed root callback was cleared before diagnostics");
      const next: typeof previous = new Map();
      const renders: string[] = [];
      let roots = 0;
      function visit(fiber: FiberNode | null) {
        for (let node = fiber; node; node = node.sibling) {
          const id = node.tag === 12 ? node.memoizedProps?.id : undefined;
          if (id === "root") roots++;
          if (id && /^(row:|queue:|button:)/.test(id)) {
            if (next.has(id)) fail(`duplicate diagnostic boundary ${id}`);
            const component = measuredComponent(node, id);
            const prior = previous.get(id);
            const sameLifetime =
              prior && (node === prior.boundary || node.alternate === prior.boundary);
            const callback = callbacks.get(id);
            if (!sameLifetime && callback?.phase !== "mount")
              fail(`new boundary ${id} has no mount callback`);
            const generation = callback?.boundaryGeneration ?? (sameLifetime && prior.generation);
            if (!generation) fail(`missing lifetime for ${id}`);
            if (sameLifetime && generation !== prior.generation)
              fail(`inconsistent lifetime for ${id}`);
            // React may reuse a committed child, including its stale PerformedWork bit.
            if (
              sameLifetime &&
              component !== prior.component &&
              component.alternate === prior.component &&
              component.flags & 1
            ) {
              if (!callback || callback.phase === "mount")
                fail(`performed work without an update callback for ${id}`);
              renders.push(id);
            } else if (
              sameLifetime &&
              component !== prior.component &&
              component.alternate !== prior.component
            ) {
              fail(`unsupported component identity change for ${id}`);
            }
            next.set(id, { boundary: node, component, generation });
          }
          visit(node.child);
        }
      }
      visit(root.current.child);
      if (roots !== 1) fail(`expected one external root Profiler, received ${roots}`);
      previous = next;
      serial = completed.commitSequence;
      commits.push({
        rootId: completed.rootId,
        rootGeneration: completed.rootGeneration,
        commitSequence: serial,
        commitTime: completed.commitTime,
        renders,
      });
    },
  };
  return {
    hook,
    get rendererCount() {
      return rendererCount;
    },
    get serial() {
      return serial;
    },
    get commits() {
      return commits;
    },
    get records() {
      return commits.flatMap((commit) => commit.renders);
    },
    assertComplete,
    clear() {
      assertComplete();
      commits = [];
    },
  };
}
export type FiberRecorder = ReturnType<typeof createFiberRecorder>;
declare global {
  interface Window {
    __fiberBenchmark?: FiberRecorder;
  }
}
