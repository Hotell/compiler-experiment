import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

async function load(name) {
  const source = readFileSync(new URL(name, import.meta.url), "utf8");
  const { outputText, diagnostics } = ts.transpileModule(
    source.replaceAll("import.meta.env.MODE", '"test"'),
    {
      fileName: name,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  );
  assert.equal(diagnostics.length, 0);
  const code = outputText.replace(
    /from "(react(?:\/jsx-runtime)?)"/g,
    (_, specifier) => `from ${JSON.stringify(import.meta.resolve(specifier))}`,
  );
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const { createRecorder } = await load("./recorder.tsx");
const { createFiberRecorder } = await load("./fiber-recorder.ts");
const { beginActionWindow, collectActionSnapshot } = await load("./collection.ts");

function ledger() {
  const checkpoints = [];
  return { recorder: createRecorder((check) => checkpoints.push(check)), checkpoints };
}
function callback(recorder, id, phase, time, actual = 0, base = 0) {
  recorder.onRender(id, phase, actual, base, time - 0.5, time);
}

test("root finalizes nested callbacks, retaining actual/base zero and startTime without a hook", () => {
  const { recorder, checkpoints } = ledger();
  callback(recorder, "shell", "mount", 1, 0, 8);
  callback(recorder, "toolbar", "mount", 1, 0, 0);
  assert.deepEqual(recorder.records, []);
  callback(recorder, "root", "mount", 1, 4, 10);
  checkpoints.forEach((check) => check());
  assert.equal(recorder.schemaVersion, 2);
  assert.equal(recorder.serial, 1);
  assert.equal(recorder.records.filter((record) => record.id === "root").length, 1);
  assert.deepEqual(recorder.records[0], {
    id: "shell",
    phase: "mount",
    actualDuration: 0,
    baseDuration: 8,
    startTime: 0.5,
    commitTime: 1,
    rootId: "root",
    rootGeneration: 1,
    commitSequence: 1,
    boundaryGeneration: 1,
  });
  assert.equal(recorder.records[1].baseDuration, 0);
  assert.equal(
    recorder.records.find((record) => record.id === "detail"),
    undefined,
  );
});

test("update, nested-update, remounts and clear retain lifetime and serial counters", () => {
  const { recorder } = ledger();
  callback(recorder, "row:one", "mount", 1);
  callback(recorder, "root", "mount", 1);
  recorder.clear();
  assert.deepEqual(recorder.records, []);
  callback(recorder, "row:one", "update", 2);
  callback(recorder, "root", "update", 2);
  callback(recorder, "row:one", "nested-update", 3);
  callback(recorder, "root", "nested-update", 3);
  callback(recorder, "row:one", "mount", 4);
  callback(recorder, "root", "update", 4);
  assert.deepEqual(
    recorder.records
      .filter((record) => record.id === "row:one")
      .map((record) => [
        record.phase,
        record.boundaryGeneration,
        record.rootGeneration,
        record.commitSequence,
      ]),
    [
      ["update", 1, 1, 2],
      ["nested-update", 1, 1, 3],
      ["mount", 2, 1, 4],
    ],
  );
  recorder.clear();
  callback(recorder, "row:one", "mount", 5);
  callback(recorder, "root", "mount", 5);
  assert.equal(recorder.records[0].rootGeneration, 2);
  assert.equal(recorder.records[0].boundaryGeneration, 3);
  assert.equal(recorder.records[0].commitSequence, 5);
});

test("missing root and incomplete/late/duplicate callbacks fail explicitly and remain failed", () => {
  for (const check of ["assertComplete", "clear"]) {
    const { recorder } = ledger();
    callback(recorder, "list", "mount", 1);
    assert.throws(() => recorder[check](), /incomplete callback batch/);
    assert.throws(() => callback(recorder, "root", "mount", 1), /incomplete callback batch/);
  }
  const { recorder, checkpoints } = ledger();
  callback(recorder, "list", "mount", 1);
  assert.throws(checkpoints[0], /incomplete callback batch/);
  for (const id of ["root", "list"]) {
    const { recorder: complete } = ledger();
    callback(complete, "root", "mount", 1);
    assert.throws(() => callback(complete, id, "update", 1), /duplicate root, late callback/);
  }
  const duplicate = ledger().recorder;
  callback(duplicate, "list", "mount", 1);
  assert.throws(() => callback(duplicate, "list", "mount", 1), /duplicate boundary/);
  const interrupted = ledger().recorder;
  callback(interrupted, "list", "mount", 1);
  assert.throws(() => callback(interrupted, "root", "mount", 2), /before the pending root/);
});

test("invalid phases, missing/non-finite durations and update-before-mount are not zero", () => {
  for (const args of [
    ["root", "render", 0, 0, 0, 1],
    ["root", "mount", undefined, 0, 0, 1],
    ["root", "mount", 0, undefined, 0, 1],
    ["root", "mount", 0, NaN, 0, 1],
    ["root", "mount", 0, 0, 2, 1],
  ]) {
    assert.throws(() => ledger().recorder.onRender(...args), /invalid|startTime/);
  }
  assert.throws(() => callback(ledger().recorder, "root", "update", 1), /before mount/);
  const { recorder } = ledger();
  callback(recorder, "row:new", "update", 1);
  assert.throws(() => callback(recorder, "root", "mount", 1), /update before mount for row:new/);
});

function component() {}
function node(overrides = {}) {
  return {
    tag: 0,
    flags: 1,
    type: component,
    alternate: null,
    child: null,
    sibling: null,
    memoizedProps: null,
    ...overrides,
  };
}
function boundary(id, child, alternate = null) {
  return node({ tag: 12, type: null, child, alternate, memoizedProps: { id } });
}
function next(node, overrides = {}) {
  return { ...node, alternate: node, ...overrides };
}
function world() {
  const { recorder } = ledger();
  const fibers = createFiberRecorder(() => recorder);
  fibers.hook.inject({ version: "19.3.0" });
  const root = { current: node({ tag: 3, type: null }) };
  let time = 0;
  function commit(child = null, entries = [], diagnostic = true) {
    time++;
    for (const [id, phase] of entries) callback(recorder, id, phase, time);
    callback(recorder, "root", time === 1 ? "mount" : "update", time);
    root.current.child = boundary("root", child);
    if (diagnostic) fibers.hook.onCommitFiberRoot(1, root);
  }
  return { recorder, fibers, root, commit };
}

for (const tag of [0, 15, 14]) {
  test(`validated function/memo shape ${tag} counts work, not mounts or reused stale flags`, () => {
    const { recorder, fibers, commit } = world();
    let body = node({ tag: tag === 14 ? 0 : tag });
    let child = tag === 14 ? node({ tag, type: { type: component }, child: body }) : body;
    let row = boundary("row:one", child);
    commit(row, [["row:one", "mount"]]);
    assert.deepEqual(fibers.records, []);

    body = next(body);
    child = tag === 14 ? next(child, { child: body }) : body;
    row = next(row, { child });
    commit(row, [["row:one", "update"]]);
    assert.deepEqual(fibers.records, ["row:one"]);
    assert.equal(fibers.commits[1].commitSequence, 2);
    assert.equal(fibers.commits[1].commitTime, recorder.lastCommit.commitTime);

    recorder.clear();
    fibers.clear();
    // A parent bailout may retain the previous child, still carrying PerformedWork.
    commit(row);
    row = next(row, { child });
    commit(row);
    assert.deepEqual(fibers.records, []);

    body = next(body, { flags: 0 });
    child = tag === 14 ? next(child, { child: body, flags: 0 }) : body;
    row = next(row, { child });
    commit(row, [["row:one", "update"]]);
    assert.deepEqual(fibers.records, []);

    body = next(body, { flags: 1 });
    child = tag === 14 ? next(child, { child: body, flags: 1 }) : body;
    row = next(row, { child });
    commit(row, [["row:one", "update"]]);
    assert.deepEqual(fibers.records, ["row:one"]);
  });
}

test("root/toolbar do not inflate scope or stop traversal; remounts remain excluded", () => {
  const { fibers, commit } = world();
  const button = boundary("button:open:one", node());
  const row = boundary("row:one", node({ child: button }));
  const queue = boundary("queue:Platform", node());
  row.sibling = queue;
  const toolbar = boundary("toolbar", node({ child: row }));
  commit(toolbar, [
    ["button:open:one", "mount"],
    ["row:one", "mount"],
    ["queue:Platform", "mount"],
    ["toolbar", "mount"],
  ]);
  assert.deepEqual(fibers.records, []);
  const updatedButton = next(button, { child: next(button.child) });
  const updatedRow = next(row, {
    child: next(row.child, { child: updatedButton }),
    sibling: next(queue, { child: next(queue.child) }),
  });
  commit(next(toolbar, { child: next(toolbar.child, { child: updatedRow }) }), [
    ["button:open:one", "update"],
    ["row:one", "update"],
    ["queue:Platform", "update"],
    ["toolbar", "update"],
  ]);
  assert.deepEqual(fibers.records, ["row:one", "button:open:one", "queue:Platform"]);
  commit();
  commit(boundary("row:one", node()), [["row:one", "mount"]]);
  assert.deepEqual(fibers.commits.at(-1).renders, []);
});

test("unsupported fragments, wrappers and sibling shapes fail instead of reporting no work", () => {
  for (const child of [
    node({ tag: 7, type: null, child: node() }),
    node({ tag: 5, type: "div", child: node() }),
    node({ sibling: node() }),
    node({ tag: 14, type: { type: component }, child: node({ tag: 7 }) }),
    node({ tag: 14, type: { type: () => null }, child: node() }),
  ]) {
    const { commit, fibers } = world();
    assert.throws(() => commit(boundary("row:one", child), [["row:one", "mount"]]), /unsupported/);
    assert.throws(() => fibers.assertComplete(), /unsupported/);
  }
});

test("diagnostics reject unvalidated versions, missing callbacks and incomplete commit batches", () => {
  const { recorder } = ledger();
  const old = createFiberRecorder(() => recorder);
  assert.throws(() => old.hook.inject({ version: "19.2.0" }), /unvalidated React version/);
  const incomplete = world();
  incomplete.commit(null, [], false);
  assert.throws(() => incomplete.fibers.assertComplete(), /incomplete diagnostic batch/);
  const missing = world();
  assert.throws(() => missing.commit(boundary("row:one", node())), /no mount callback/);
  const early = world();
  assert.throws(
    () => early.fibers.hook.onCommitFiberRoot(1, early.root),
    /exactly one completed external root callback/,
  );
  const duplicate = world();
  duplicate.commit();
  assert.throws(
    () => duplicate.fibers.hook.onCommitFiberRoot(1, duplicate.root),
    /exactly one completed external root callback/,
  );
  const multiple = world();
  assert.throws(() => multiple.commit(boundary("root", null)), /received 2/);
});

function browserFixture() {
  const fixture = world();
  const elements = new Map([
    ["main", { innerText: "Incidents" }],
    ['[aria-label="Incident detail"]', { innerText: "No incident selected" }],
    ['[data-testid="reviews"]', { innerText: "0" }],
    ['[data-testid="total"]', { innerText: "0" }],
    ['[aria-label="Incident queues"] [aria-current="page"]', { textContent: "All incidents200" }],
    ['[aria-label="Search incidents"]', { value: "" }],
    ['[aria-label="Status"]', { value: "All statuses" }],
    ['[aria-label="Sort"]', { value: "newest" }],
    ['[data-testid="open-count"]', { innerText: "0" }],
  ]);
  globalThis.window = { __benchmark: fixture.recorder, __fiberBenchmark: fixture.fibers };
  globalThis.document = {
    querySelector: (selector) => elements.get(selector) ?? null,
    querySelectorAll: () => [],
  };
  fixture.commit();
  return { ...fixture, elements };
}

test("atomic collection supports no-op windows and preserves lifetime/commit state across clear", async () => {
  const fixture = browserFixture();
  const initial = await collectActionSnapshot({ outcome: { reviews: "0", rows: 0 } });
  assert.equal(initial.status, "complete");
  beginActionWindow();
  const empty = await collectActionSnapshot({ outcome: {}, allowNoCommit: true });
  assert.equal(empty.status, "complete");
  assert.deepEqual(empty.sample.records, []);
  assert.deepEqual(empty.sample.fiberCommits, []);
  assert.deepEqual(empty.sample.fiberRenders, []);
  assert.equal(fixture.recorder.serial, 1);
  const updating = await collectActionSnapshot({ outcome: {} });
  assert.equal(updating.status, "retry");
  assert.match(updating.reason, /no completed root/);
  fixture.commit();
  fixture.elements.get('[data-testid="reviews"]').innerText = "1";
  const complete = await collectActionSnapshot({ outcome: { reviews: "1" } });
  assert.equal(complete.status, "complete");
  assert.equal(complete.sample.records[0].commitSequence, 2);
  assert.equal(complete.sample.fiberCommits[0].commitSequence, 2);
  assert.equal(JSON.parse(complete.sample.state).reviews, "1");
  fixture.recorder.clear();
  fixture.fibers.clear();
  assert.equal(complete.sample.records.length, 1);
  assert.equal(complete.sample.fiberCommits.length, 1);
});

test("collection retries serial/outcome changes and demands completion of every operation", async () => {
  const fixture = browserFixture();
  beginActionWindow();
  fixture.commit();
  const changing = collectActionSnapshot({ outcome: {} });
  fixture.commit();
  assert.deepEqual(await changing, { status: "retry", reason: "commit serial changed" });
  const semantic = await collectActionSnapshot({ outcome: { reviews: "1" } });
  assert.equal(semantic.status, "retry");
  assert.match(semantic.reason, /reviews does not match/);
  const nextOperation = await collectActionSnapshot({
    outcome: {},
    afterSerial: fixture.recorder.serial,
  });
  assert.equal(nextOperation.status, "retry");
  assert.match(nextOperation.reason, /operation has no new completed root/);
  const completed = await collectActionSnapshot({ outcome: {} });
  assert.equal(completed.status, "complete");
  assert.equal(completed.sample.records.length, 2);
  assert.equal(completed.sample.fiberCommits.length, 2);
});

test("collection and measurement JSON retain nonzero baseDuration when actualDuration is zero", async () => {
  const fixture = browserFixture();
  beginActionWindow();
  callback(fixture.recorder, "shell", "mount", 2, 0, 17);
  callback(fixture.recorder, "root", "update", 2, 0, 21);
  fixture.root.current.child = boundary("root", boundary("shell", node()));
  fixture.fibers.hook.onCommitFiberRoot(1, fixture.root);
  const collected = await collectActionSnapshot({ outcome: {} });
  assert.equal(collected.status, "complete");
  const serialized = JSON.parse(JSON.stringify({ name: "zero actual", ...collected.sample }));
  assert.deepEqual(
    serialized.records.map(({ id, actualDuration, baseDuration, startTime }) => ({
      id,
      actualDuration,
      baseDuration,
      startTime,
    })),
    [
      { id: "shell", actualDuration: 0, baseDuration: 17, startTime: 1.5 },
      { id: "root", actualDuration: 0, baseDuration: 21, startTime: 1.5 },
    ],
  );
  assert.equal(serialized.fiberCommits[0].commitSequence, serialized.records[1].commitSequence);
  assert.equal(
    serialized.records.find((record) => record.id === "detail"),
    undefined,
  );
});

test("collection rejects incomplete callbacks/diagnostics, missing DOM and mismatched batches", async () => {
  const pending = browserFixture();
  callback(pending.recorder, "list", "mount", 2);
  await assert.rejects(collectActionSnapshot({ outcome: {} }), /incomplete callback batch/);
  const diagnostic = browserFixture();
  diagnostic.commit(null, [], false);
  await assert.rejects(collectActionSnapshot({ outcome: {} }), /incomplete diagnostic batch/);
  const dom = browserFixture();
  dom.elements.delete("main");
  await assert.rejects(collectActionSnapshot({ outcome: {} }), /missing main/);
  const mismatch = browserFixture();
  mismatch.fibers.commits[0].commitTime++;
  await assert.rejects(collectActionSnapshot({ outcome: {} }), /mismatched root\/diagnostic/);
  delete globalThis.window;
  delete globalThis.document;
});

function parse(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  assert.equal(source.parseDiagnostics.length, 0, `${path} must parse without recovery`);
  return source;
}
function all(source, predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}
function tag(node) {
  return node.openingElement.tagName.getText();
}
function staticId(node) {
  const id = node.openingElement.attributes.properties.find(
    (attribute) => attribute.name?.getText() === "id",
  );
  return id?.initializer && ts.isStringLiteral(id.initializer) ? id.initializer.text : null;
}
function measuredElement(node) {
  const children = node.children.filter((child) => !ts.isJsxText(child));
  assert.equal(children.length, 1, "No fragment, HOC or extra siblings around a measured body");
  assert.ok(ts.isJsxSelfClosingElement(children[0]));
  return children[0].tagName.getText();
}

for (const file of ["../shared/App.tsx", "../apps/manual/src/App.tsx"]) {
  test(`${file}: external boundaries include owner bodies and preserve keyed leaf call sites`, () => {
    const source = parse(file);
    const profilers = all(source, (node) => ts.isJsxElement(node) && tag(node) === "Profiled");
    assert.deepEqual(
      profilers
        .filter(staticId)
        .map((node) => [staticId(node), measuredElement(node)])
        .sort(),
      [
        ["detail", "Detail"],
        ["list", "IncidentList"],
        ["shell", "Shell"],
        ["toolbar", "Toolbar"],
      ],
    );
    const shell = profilers.find((node) => staticId(node) === "shell");
    const providers = [];
    for (let parent = shell.parent; parent; parent = parent.parent) {
      if (ts.isJsxElement(parent)) providers.push(tag(parent));
    }
    assert.deepEqual(providers, [
      "ReviewProvider",
      "SelectionProvider",
      "FilterProvider",
      "IncidentProvider",
      "WorkspaceProvider",
    ]);
    for (const owner of ["Shell", "IncidentList", "Detail"]) {
      const body = all(
        source,
        (node) =>
          (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
          node.name?.text === owner,
      )[0];
      assert.ok(body);
      assert.equal(
        all(
          body,
          (node) =>
            ts.isJsxElement(node) &&
            tag(node) === "Profiled" &&
            staticId(node) === { Shell: "shell", IncidentList: "list", Detail: "detail" }[owner],
        ).length,
        0,
        "Owner hooks/calculations must not run outside their own boundary",
      );
    }
    for (const owner of ["QueueItem", "IncidentRow", "OpenIncidentButton", "FavoriteButton"]) {
      const leaf = profilers.find((node) => measuredElement(node) === owner);
      assert.ok(leaf, `${owner} stays directly inside Profiled`);
      if (owner === "QueueItem" || owner === "IncidentRow")
        assert.ok(
          leaf.openingElement.attributes.properties.some(
            (attribute) => attribute.name?.getText() === "key",
          ),
        );
    }
    assert.equal(
      all(source, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "Profiled")
        .length,
      0,
    );
    if (file.includes("manual")) {
      for (const name of [
        "QueueItem",
        "IncidentRow",
        "OpenIncidentButton",
        "FavoriteButton",
        "Detail",
      ]) {
        const declaration = all(
          source,
          (node) => ts.isVariableDeclaration(node) && node.name.getText() === name,
        )[0];
        if (name === "IncidentRow") {
          const selection = declaration.initializer;
          assert.ok(ts.isConditionalExpression(selection));
          assert.equal(selection.condition.getText(), "__ROW_MEMO_ENABLED__");
          assert.ok(ts.isCallExpression(selection.whenTrue));
          assert.equal(selection.whenTrue.expression.getText(), "memo");
          assert.equal(selection.whenTrue.arguments.length, 1);
          assert.equal(selection.whenTrue.arguments[0].getText(), "IncidentRowImpl");
          assert.equal(selection.whenFalse.getText(), "IncidentRowImpl");
        } else {
          assert.equal(declaration.initializer.expression.getText(), "memo");
        }
      }
    }
  });
}

test("each entry point has one profile-only root outside App and its provider bodies", () => {
  for (const variant of ["baseline", "compiler", "manual"]) {
    const source = parse(`../apps/${variant}/src/main.tsx`);
    const roots = all(source, (node) => ts.isJsxElement(node) && tag(node) === "Profiled");
    assert.equal(roots.length, 1);
    assert.equal(staticId(roots[0]), "root");
    assert.equal(measuredElement(roots[0]), "App");
    assert.ok(ts.isConditionalExpression(roots[0].parent.parent));
    assert.match(
      roots[0].parent.parent.condition.getText(),
      /import\.meta\.env\.MODE === "profile"/,
    );
    if (variant !== "manual") assert.match(source.text, /from "\.\.\/\.\.\/\.\.\/shared\/App"/);
  }
});

test("shared Profiled is ordinary, single-child instrumentation with a normal-mode passthrough", () => {
  const source = parse("./recorder.tsx");
  const helper = all(
    source,
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "Profiled",
  )[0];
  assert.ok(helper);
  assert.match(helper.getText(), /children: ReactElement/);
  assert.equal(all(helper, (node) => ts.isJsxElement(node) && tag(node) === "Profiler").length, 1);
  assert.equal(all(helper, ts.isJsxFragment).length, 0);
  assert.match(helper.getText(), /:\s*\(\s*children\s*\)/);
});
