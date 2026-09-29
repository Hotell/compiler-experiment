import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  assertMeasurementsV2,
  countProfileRecords,
  summarizeProfileSamples,
  validateProfileRecords,
} from "./profile-counts.mjs";

const boundaryIds = {
  root: "root",
  shell: "shell",
  toolbar: "toolbar",
  list: "list",
  detail: "detail",
  rows: "row:INC-0001",
  queueItems: "queue:platform",
  openButtons: "button:open:INC-0001",
  favoriteButtons: "button:favorite:INC-0001",
};
const record = (id = "root", overrides = {}) => ({
  id,
  phase: "update",
  actualDuration: 3,
  baseDuration: 12,
  startTime: 1,
  commitTime: 10,
  rootId: "app",
  rootGeneration: 1,
  commitSequence: 1,
  boundaryGeneration: 1,
  ...overrides,
});

test("only external roots count commits; inclusive callbacks are not added together", () => {
  const records = Object.values(boundaryIds)
    .reverse()
    .map((id, index) => record(id, { actualDuration: index, baseDuration: index + 20 }));
  const sample = countProfileRecords(records, [
    "root",
    "toolbar",
    "row:INC-0001",
    "row:INC-0001",
    "queue:platform",
    "button:open:INC-0001",
    "button:favorite:INC-0001",
  ]);
  assert.equal(sample.commits, 1);
  assert.deepEqual(sample.rootPhaseCounts, { mount: 0, update: 1, "nested-update": 0 });
  for (const [name, id] of Object.entries(boundaryIds)) {
    const raw = records.find((item) => item.id === id);
    assert.equal(sample[name], 1);
    assert.equal(sample.durationMs[name], raw.actualDuration);
    assert.equal(sample.baseDurationMs[name], raw.baseDuration);
    assert.equal(sample.mounts[name], 0);
    assert.equal(sample.mounts.durationMs[name], null);
    assert.equal(sample.mounts.baseDurationMs[name], null);
  }
  assert.equal(sample.rowRenders, 2);
  assert.equal(sample.queueRenders, 1);
  assert.equal(sample.openButtonRenders, 1);
  assert.equal(sample.favoriteButtonRenders, 1);
  assert.deepEqual(sample.affectedRows, ["INC-0001"]);
});

test("same timestamp and sequence in distinct roots still represent distinct commits", () => {
  const sample = countProfileRecords(
    [
      record("shell"),
      record("root", { rootId: "second-app" }),
      record(),
      record("shell", { rootId: "second-app" }),
    ],
    [],
  );
  assert.equal(sample.commits, 2);
  assert.equal(sample.shell, 2);
});

test("subtree mounts remain separate from root updates, including nested-update", () => {
  const sample = countProfileRecords(
    [
      record("row:INC-0001", { phase: "mount" }),
      record(),
      record("root", { phase: "nested-update", commitSequence: 2, commitTime: 20 }),
      record("toolbar", { phase: "nested-update", commitSequence: 2, commitTime: 20 }),
    ],
    [],
  );
  assert.equal(sample.commits, 2);
  assert.equal(sample.root, 2);
  assert.equal(sample.toolbar, 1);
  assert.equal(sample.rows, 0);
  assert.equal(sample.durationMs.rows, null);
  assert.equal(sample.baseDurationMs.rows, null);
  assert.deepEqual(sample.affectedRows, []);
  assert.deepEqual(sample.rootPhaseCounts, { mount: 0, update: 1, "nested-update": 1 });
  assert.equal(sample.mounts.root, 0);
  assert.equal(sample.mounts.rows, 1);
  assert.equal(sample.mounts.durationMs.rows, 3);
  assert.equal(sample.mounts.baseDurationMs.rows, 12);
  assert.deepEqual(sample.mounts.affectedRows, ["INC-0001"]);
});

test("root remounts count as commits and can reuse timestamps in a new root lifecycle", () => {
  const records = [
    record(),
    ...Object.values(boundaryIds).map((id) => record(id, { phase: "mount", rootGeneration: 2 })),
  ];
  const sample = countProfileRecords(records, []);
  assert.equal(sample.commits, 2);
  assert.equal(sample.root, 1);
  assert.deepEqual(sample.rootPhaseCounts, { mount: 1, update: 1, "nested-update": 0 });
  for (const name of Object.keys(boundaryIds)) {
    assert.equal(sample.mounts[name], 1);
    assert.equal(sample.mounts.durationMs[name], 3);
    assert.equal(sample.mounts.baseDurationMs[name], 12);
  }
  const summary = summarizeProfileSamples([sample]);
  assert.equal(summary.mounts.medianDurationMs.root, 3);
  assert.equal(summary.mounts.medianBaseDurationMs.root, 12);
});

test("a remounted row ID is a mount, not an update or an extra root commit", () => {
  const sample = countProfileRecords(
    [
      record("row:INC-0001"),
      record(),
      record("row:INC-0001", {
        phase: "mount",
        boundaryGeneration: 2,
        commitSequence: 2,
        commitTime: 20,
      }),
      record("root", { commitSequence: 2, commitTime: 20 }),
    ],
    [],
  );
  assert.equal(sample.commits, 2);
  assert.equal(sample.rows, 1);
  assert.equal(sample.mounts.rows, 1);
  assert.equal(sample.mounts.root, 0);
});

test("no-op actions retain zero counts and null durations, not fabricated measurements", () => {
  const sample = countProfileRecords([], []);
  const summary = summarizeProfileSamples([sample]);
  assert.equal(summary.commits, 0);
  assert.deepEqual(summary.rootPhaseCounts, { mount: 0, update: 0, "nested-update": 0 });
  for (const name of Object.keys(boundaryIds)) {
    assert.equal(summary[name], 0);
    assert.equal(summary.medianDurationMs[name], null);
    assert.equal(summary.medianBaseDurationMs[name], null);
    assert.equal(summary.mounts.medianDurationMs[name], null);
    assert.equal(summary.mounts.medianBaseDurationMs[name], null);
  }
  for (const name of ["rowRenders", "queueRenders", "openButtonRenders", "favoriteButtonRenders"]) {
    assert.equal(summary[name], 0);
  }
});

test("actual and base medians are independent at both aggregation levels", () => {
  const samples = [
    countProfileRecords(
      [
        record(),
        record("row:first", { actualDuration: 1, baseDuration: 100 }),
        record("row:second", { actualDuration: 9, baseDuration: 5 }),
        record("row:third", { actualDuration: 5, baseDuration: 50 }),
      ],
      [],
    ),
    countProfileRecords(
      [record(), record("row:first", { actualDuration: 2, baseDuration: 100 })],
      [],
    ),
  ];
  assert.equal(samples[0].durationMs.rows, 5);
  assert.equal(samples[0].baseDurationMs.rows, 50);
  const summary = summarizeProfileSamples(samples);
  assert.equal(summary.medianDurationMs.rows, 3.5);
  assert.equal(summary.medianBaseDurationMs.rows, 75);
  assert.deepEqual(summary.affectedRows, ["first", "second", "third"]);
  assert.deepEqual(summary.runs, samples);
});

test("measured zero survives aggregation independently from missing actual/base values", () => {
  const samples = [
    countProfileRecords([record("root", { actualDuration: 0, baseDuration: 8 })], []),
    countProfileRecords([], []),
    countProfileRecords([record("root", { actualDuration: 4, baseDuration: 0 })], []),
  ];
  const summary = summarizeProfileSamples(samples);
  assert.equal(summary.medianDurationMs.root, 2);
  assert.equal(summary.medianBaseDurationMs.root, 4);
  assert.equal(summary.runs[0].durationMs.root, 0);
  assert.equal(summary.runs[1].durationMs.root, null);
  assert.equal(summary.runs[1].baseDurationMs.root, null);
  assert.equal(summary.runs[2].baseDurationMs.root, 0);
  const zero = summarizeProfileSamples([
    countProfileRecords(
      [record("root", { actualDuration: 0, baseDuration: 0, phase: "mount" })],
      [],
    ),
    countProfileRecords([], []),
  ]);
  assert.equal(zero.mounts.medianDurationMs.root, 0);
  assert.equal(zero.mounts.medianBaseDurationMs.root, 0);
  assert.equal(zero.medianDurationMs.root, null);
  assert.equal(zero.medianBaseDurationMs.root, null);
});

for (const [name, records, message] of [
  ["duplicate root", [record(), record()], /Duplicate root callback/],
  ["duplicate boundary", [record(), record("shell"), record("shell")], /Duplicate boundary shell/],
  [
    "duplicate remounted ID in one commit",
    [record(), record("row:first"), record("row:first", { boundaryGeneration: 2 })],
    /Duplicate boundary row:first/,
  ],
  ["orphan callback", [record("shell")], /orphan callbacks without root/],
  [
    "incomplete later commit",
    [record(), record("shell", { commitSequence: 2, commitTime: 20 })],
    /orphan callbacks without root/,
  ],
  [
    "inconsistent commit time",
    [record(), record("shell", { commitTime: 11 })],
    /Inconsistent commitTime/,
  ],
  [
    "ambiguous timestamp",
    [record(), record("root", { commitSequence: 2 })],
    /Ambiguous commitTime reuse/,
  ],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => countProfileRecords(records, []), message);
  });
}

test("run-wide validation catches timestamp reuse across separately cleared action windows", () => {
  const first = [record()];
  const second = [record("root", { commitSequence: 2 })];
  assert.equal(countProfileRecords(first, []).commits, 1);
  assert.equal(countProfileRecords(second, []).commits, 1);
  assert.throws(() => validateProfileRecords([...first, ...second]), /Ambiguous commitTime reuse/);
  assert.doesNotThrow(() =>
    validateProfileRecords([...first, record("root", { commitSequence: 2, commitTime: 20 })]),
  );
});

for (const field of ["actualDuration", "baseDuration", "startTime", "commitTime"]) {
  test(`rejects missing, nonfinite or negative ${field}`, () => {
    for (const value of [undefined, null, NaN, Infinity, -Infinity, -1, "1"]) {
      assert.throws(
        () => countProfileRecords([record("root", { [field]: value })], []),
        new RegExp(`finite nonnegative ${field}`),
      );
    }
    const missing = record();
    delete missing[field];
    assert.throws(
      () => countProfileRecords([missing], []),
      new RegExp(`finite nonnegative ${field}`),
    );
  });
}

test("baseDuration must also be retained on nested callbacks and mount callbacks", () => {
  for (const phase of ["mount", "update", "nested-update"]) {
    assert.throws(
      () =>
        countProfileRecords([record(), record("shell", { phase, baseDuration: undefined })], []),
      /finite nonnegative baseDuration/,
    );
  }
});

test("summary rejects dropped base fields instead of serializing NaN as null", () => {
  for (const mounts of [false, true]) {
    for (const field of ["durationMs", "baseDurationMs"]) {
      const sample = countProfileRecords([record()], []);
      delete (mounts ? sample.mounts : sample)[field].root;
      assert.throws(() => summarizeProfileSamples([sample]), new RegExp(`${field}.root`));
    }
  }
});

test("rejects incomplete lifecycle identities, invalid phases and diagnostic data", () => {
  for (const field of ["rootGeneration", "commitSequence", "boundaryGeneration"]) {
    for (const value of [undefined, null, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => countProfileRecords([record("root", { [field]: value })], []),
        new RegExp(`positive integer ${field}`),
      );
    }
  }
  for (const field of ["id", "rootId"]) {
    for (const value of [undefined, null, "", 1]) {
      assert.throws(
        () => countProfileRecords([record("root", { [field]: value })], []),
        new RegExp(`nonempty ${field}`),
      );
    }
  }
  assert.throws(
    () => countProfileRecords([record("root", { phase: "render" })], []),
    /unsupported phase/,
  );
  assert.throws(() => countProfileRecords(undefined, []), /Missing React Profiler records/);
  assert.throws(() => countProfileRecords([null], []), /must be an object/);
  assert.throws(() => countProfileRecords([], undefined), /fiber component-work records/);
  assert.throws(() => countProfileRecords([], [null]), /fiber component-work records/);
  assert.throws(
    () => countProfileRecords([], ["row:INC-0001"]),
    /fiber component work without a completed root commit/,
  );
  assert.throws(() => summarizeProfileSamples([]), /Missing profile samples/);
});

test("legacy or unknown measurement schemas fail with explicit regeneration guidance", () => {
  for (const input of [
    undefined,
    {},
    { schemaVersion: 1 },
    { schemaVersion: 3 },
    { schemaVersion: "2" },
  ]) {
    assert.throws(
      () => assertMeasurementsV2(input),
      /expected schemaVersion 2.*baseDuration.*Regenerate.*yarn benchmark/,
    );
  }
  assert.doesNotThrow(() => assertMeasurementsV2({ schemaVersion: 2 }));
});
