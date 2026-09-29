import { strict as assert } from "node:assert";

const phases = ["mount", "update", "nested-update"];
const boundaries = {
  root: (id) => id === "root",
  shell: (id) => id === "shell",
  toolbar: (id) => id === "toolbar",
  list: (id) => id === "list",
  detail: (id) => id === "detail",
  rows: (id) => id.startsWith("row:"),
  queueItems: (id) => id.startsWith("queue:"),
  openButtons: (id) => id.startsWith("button:open:"),
  favoriteButtons: (id) => id.startsWith("button:favorite:"),
};
const fiberGroups = {
  rowRenders: boundaries.rows,
  queueRenders: boundaries.queueItems,
  openButtonRenders: boundaries.openButtons,
  favoriteButtonRenders: boundaries.favoriteButtons,
};

export function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function assertMeasurementsV2(input) {
  assert.equal(
    input?.schemaVersion,
    2,
    "Unsupported measurements schema: expected schemaVersion 2 with external root boundaries and baseDuration. Regenerate all benchmark artifacts with yarn benchmark; do not mix legacy and current measurements.",
  );
}

export function validateProfileRecords(records) {
  assert.ok(Array.isArray(records), "Missing React Profiler records");
  const commits = new Map();
  const timestamps = new Map();
  for (const [index, record] of records.entries()) {
    const label = `Profiler record ${index}`;
    assert.ok(record && typeof record === "object", `${label} must be an object`);
    for (const key of ["id", "rootId"]) {
      assert.ok(
        typeof record[key] === "string" && record[key].length > 0,
        `${label} needs a nonempty ${key}`,
      );
    }
    assert.ok(phases.includes(record.phase), `${label} has unsupported phase ${record.phase}`);
    for (const key of ["actualDuration", "baseDuration", "startTime", "commitTime"]) {
      assert.ok(
        Number.isFinite(record[key]) && record[key] >= 0,
        `${label} ${record.id} needs finite nonnegative ${key}`,
      );
    }
    for (const key of ["rootGeneration", "commitSequence", "boundaryGeneration"]) {
      assert.ok(
        Number.isSafeInteger(record[key]) && record[key] > 0,
        `${label} ${record.id} needs a positive integer ${key}`,
      );
    }
    const key = JSON.stringify([record.rootId, record.rootGeneration, record.commitSequence]);
    const timestampKey = JSON.stringify([record.rootId, record.rootGeneration, record.commitTime]);
    assert.ok(
      !timestamps.has(timestampKey) || timestamps.get(timestampKey) === key,
      `Ambiguous commitTime reuse within root lifecycle ${timestampKey}`,
    );
    timestamps.set(timestampKey, key);
    if (!commits.has(key)) {
      commits.set(key, { commitTime: record.commitTime, ids: new Set() });
    }
    const commit = commits.get(key);
    assert.equal(commit.commitTime, record.commitTime, `Inconsistent commitTime for commit ${key}`);
    assert.ok(
      !commit.ids.has(record.id),
      `Duplicate ${record.id === "root" ? "root callback" : `boundary ${record.id}`} for commit ${key}`,
    );
    commit.ids.add(record.id);
  }
  for (const [key, commit] of commits) {
    assert.ok(commit.ids.has("root"), `Incomplete commit ${key}: orphan callbacks without root`);
  }
}

function boundarySummary(records) {
  const groups = Object.entries(boundaries).map(([name, matches]) => [
    name,
    records.filter((record) => matches(record.id)),
  ]);
  const durations = (field) =>
    Object.fromEntries(
      groups.map(([name, entries]) => [name, median(entries.map((record) => record[field]))]),
    );
  return {
    ...Object.fromEntries(groups.map(([name, entries]) => [name, entries.length])),
    affectedRows: [
      ...new Set(
        records.filter((record) => boundaries.rows(record.id)).map((record) => record.id.slice(4)),
      ),
    ].sort(),
    durationMs: durations("actualDuration"),
    baseDurationMs: durations("baseDuration"),
  };
}

export function countProfileRecords(records, fiberRenders) {
  validateProfileRecords(records);
  assert.ok(
    Array.isArray(fiberRenders) && fiberRenders.every((id) => typeof id === "string"),
    "Missing or invalid React fiber component-work records",
  );
  const roots = records.filter((record) => record.id === "root");
  assert.ok(
    roots.length > 0 || fiberRenders.length === 0,
    "Incomplete profile sample: fiber component work without a completed root commit",
  );
  return {
    commits: roots.length,
    rootPhaseCounts: Object.fromEntries(
      phases.map((phase) => [phase, roots.filter((record) => record.phase === phase).length]),
    ),
    ...boundarySummary(records.filter((record) => record.phase !== "mount")),
    ...Object.fromEntries(
      Object.entries(fiberGroups).map(([name, matches]) => [
        name,
        fiberRenders.filter(matches).length,
      ]),
    ),
    mounts: boundarySummary(records.filter((record) => record.phase === "mount")),
  };
}

function medianFields(samples, fields) {
  return Object.fromEntries(
    fields.map((key) => [key, median(samples.map((sample) => sample[key]))]),
  );
}

function summarizeBoundaries(samples) {
  const durations = (field) =>
    Object.fromEntries(
      Object.keys(boundaries).map((name) => {
        const values = samples.map((sample) => {
          const value = sample[field]?.[name];
          assert.ok(
            value === null || (Number.isFinite(value) && value >= 0),
            `Missing or invalid ${field}.${name} in profile summary`,
          );
          return value;
        });
        return [name, median(values.filter((value) => value !== null))];
      }),
    );
  return {
    ...medianFields(samples, Object.keys(boundaries)),
    affectedRows: [...new Set(samples.flatMap((sample) => sample.affectedRows))].sort(),
    medianDurationMs: durations("durationMs"),
    medianBaseDurationMs: durations("baseDurationMs"),
  };
}

export function summarizeProfileSamples(samples) {
  assert.ok(Array.isArray(samples) && samples.length > 0, "Missing profile samples");
  return {
    ...medianFields(samples, ["commits", ...Object.keys(fiberGroups)]),
    rootPhaseCounts: medianFields(
      samples.map((sample) => sample.rootPhaseCounts),
      phases,
    ),
    ...summarizeBoundaries(samples),
    mounts: summarizeBoundaries(samples.map((sample) => sample.mounts)),
    runs: samples,
  };
}
