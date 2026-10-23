import { strict as assert } from "node:assert";
import { prerelease, valid } from "semver";
import { issueScopes, packages, sources, tracks } from "./sources.mjs";

export function windows(value) {
  const end = new Date(value).toISOString();
  const date = new Date(end);
  const year = date.getUTCFullYear() - 1;
  const month = date.getUTCMonth();
  const day = Math.min(date.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  date.setUTCFullYear(year, month, day);
  return {
    days30: { start: new Date(Date.parse(end) - 30 * 86400000).toISOString(), end },
    days90: { start: new Date(Date.parse(end) - 90 * 86400000).toISOString(), end },
    releases: { start: date.toISOString(), end },
  };
}

export function inWindow(value, range) {
  return (
    typeof value === "string" &&
    Date.parse(value) >= Date.parse(range.start) &&
    Date.parse(value) < Date.parse(range.end)
  );
}

export function matchesPaths(file, paths) {
  return [file.filename, file.previous_filename].some(
    (name) =>
      typeof name === "string" &&
      paths.some((path) => name === path || name.startsWith(`${path}/`)),
  );
}

export function classifyFiles(files, paths) {
  const relevant = files.filter((file) => matchesPaths(file, paths));
  return relevant.length &&
    relevant.every(({ filename }) =>
      /(?:^|\/)(?:Cargo\.toml|Cargo\.lock|package\.json|CHANGELOG\.md)$/.test(filename),
    )
    ? "release-only"
    : "source";
}

export function scopedPullRequests(records, paths, range) {
  return [
    ...new Map(
      records
        .filter(
          (record) =>
            inWindow(record.mergedAt, range) &&
            record.files.some((file) => matchesPaths(file, paths)),
        )
        .map((record) => [record.number, record]),
    ).values(),
  ];
}

export function publicationHistory(packument, range) {
  const releases = Object.entries(packument.time ?? {})
    .filter(
      ([version, date]) =>
        valid(version) && packument.versions?.[version] && Date.parse(date) < Date.parse(range.end),
    )
    .map(([version, date]) => ({
      version,
      date,
      channel: prerelease(version) ? "prerelease" : "stable",
      ...(packument.versions[version].deprecated
        ? { deprecated: packument.versions[version].deprecated }
        : {}),
    }))
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) || left.version.localeCompare(right.version),
    );
  return {
    tags: packument["dist-tags"] ?? {},
    latestStable: releases.findLast(({ channel }) => channel === "stable") ?? null,
    releases: releases.filter(({ date }) => inWindow(date, range)),
  };
}

export function summarize(snapshot) {
  const ranges = windows(snapshot.asOf);
  return snapshot.tracks.map((track) => ({
    ...track,
    counts: Object.fromEntries(
      ["days30", "days90"].map((key) => [
        key,
        {
          commits: track.commits.filter(({ date }) => inWindow(date, ranges[key])).length,
          sourceCommits: track.commits.filter(
            ({ date, kind }) => kind === "source" && inWindow(date, ranges[key]),
          ).length,
          merged: track.pullRequests.filter(({ mergedAt }) => inWindow(mergedAt, ranges[key]))
            .length,
        },
      ]),
    ),
  }));
}

export function validateSnapshot(snapshot) {
  assert.equal(snapshot.schemaVersion, 1, "Unsupported activity snapshot");
  assert.deepEqual(snapshot.windows, windows(snapshot.asOf), "Activity windows differ from asOf");
  assert.equal(snapshot.tracks.length, 4, "Expected four compiler tracks");
  assert.equal(new Set(snapshot.tracks.map(({ id }) => id)).size, 4);
  assert.deepEqual(snapshot.tracks.map(({ id }) => id).sort(), tracks.map(({ id }) => id).sort());
  assert.deepEqual(
    snapshot.packages.map(({ name, registry }) => `${registry}:${name}`).sort(),
    packages.map(({ name, registry }) => `${registry}:${name}`).sort(),
    "Missing or duplicate package evidence",
  );
  assert.deepEqual(
    snapshot.issues.map(({ repo }) => repo).sort(),
    issueScopes.map(({ repo }) => repo).sort(),
    "Missing or duplicate issue scopes",
  );
  assert.deepEqual(
    snapshot.sources,
    sources,
    "Source references differ from the collector registry",
  );
  assert.ok(Date.parse(snapshot.fetchedAt.end) >= Date.parse(snapshot.fetchedAt.start));
  for (const track of snapshot.tracks) {
    const definition = tracks.find(({ id }) => id === track.id);
    assert.equal(track.repo, definition.repo);
    assert.deepEqual(track.paths, definition.paths);
    assert.match(track.head, /^[a-f0-9]{40}$/);
    assert.ok(track.paths.length && track.repo && track.name);
    assert.equal(track.complete, true, `${track.id}: incomplete collection`);
    for (const [records, key] of [
      [track.commits, "sha"],
      [track.pullRequests, "number"],
    ]) {
      assert.equal(
        new Set(records.map((record) => record[key])).size,
        records.length,
        `${track.id}: duplicate evidence`,
      );
      for (const record of records) {
        assert.ok(
          record.files.some((file) => matchesPaths(file, track.paths)),
          `${track.id}: unrelated evidence`,
        );
        assert.ok(inWindow(record.date ?? record.mergedAt, snapshot.windows.days90));
        assert.match(record.url, /^https:\/\/github\.com\//);
      }
    }
    for (const record of [...track.commits, ...track.pullRequests])
      assert.equal(record.kind, classifyFiles(record.files, track.paths));
  }
  for (const scope of snapshot.issues) {
    const definition = issueScopes.find(({ repo }) => repo === scope.repo);
    assert.equal(scope.coverage, definition.coverage);
    assert.equal(scope.label, definition.label);
    assert.equal(scope.complete, true, `${scope.repo}: incomplete issues`);
    assert.equal(new Set(scope.records.map(({ number }) => number)).size, scope.records.length);
    for (const record of scope.records) {
      assert.equal(record.state, "closed");
      assert.ok(inWindow(record.closedAt, snapshot.windows.days90));
      assert.match(record.url, /^https:\/\/github\.com\/.+\/issues\/\d+$/);
    }
  }
  for (const entry of snapshot.packages) {
    assert.ok(entry.name && ["npm", "crates.io"].includes(entry.registry));
    assert.ok(["available", "not-published"].includes(entry.status));
    if (entry.status === "not-published") {
      assert.equal(
        packages.find(({ name }) => name === entry.name)?.optional,
        true,
        "Required publication history unavailable",
      );
      continue;
    }
    assert.equal(
      new Set(entry.releases.map(({ version }) => version)).size,
      entry.releases.length,
      "Duplicate package publications",
    );
    for (const release of [
      ...entry.releases,
      ...(entry.latestStable ? [entry.latestStable] : []),
    ]) {
      assert.ok(valid(release.version));
      assert.equal(release.channel, prerelease(release.version) ? "prerelease" : "stable");
      assert.ok(Date.parse(release.date) < Date.parse(snapshot.asOf));
    }
    for (const release of entry.releases)
      assert.ok(inWindow(release.date, snapshot.windows.releases));
  }
  for (const source of snapshot.sources) assert.match(source.url, /^https:\/\//);
  return snapshot;
}
