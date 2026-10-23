import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classifyFiles,
  inWindow,
  publicationHistory,
  scopedPullRequests,
  summarize,
  validateSnapshot,
  windows,
} from "./model.mjs";
import { monthlyReleases, publishActivity, renderHtml, renderMarkdown } from "./report.mjs";
import {
  closedIssues,
  collectPackage,
  createClient,
  mergedPullRequests,
  refreshSnapshot,
} from "./collect.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const asOf = "2026-10-23T12:00:00.000Z";
const paths = ["compiler/crates", "compiler/packages/babel-plugin-react-compiler-rust"];

test("compiler PR counts exclude unrelated files, unmerged closures, and duplicates", () => {
  const merged = {
    number: 1,
    mergedAt: "2026-10-22T10:00:00Z",
    files: [{ filename: "compiler/crates/react_compiler/src/lib.rs" }],
  };
  const records = [
    merged,
    merged,
    { ...merged, number: 2, files: [{ filename: "packages/react/src/React.js" }] },
    { ...merged, number: 3, mergedAt: null },
  ];
  assert.deepEqual(
    scopedPullRequests(records, paths, windows(asOf).days90).map(({ number }) => number),
    [1],
  );
});

test("path matching respects boundaries and renamed files", () => {
  const records = [
    { number: 1, mergedAt: asOf, files: [{ filename: "compiler/crates-old/test.rs" }] },
    {
      number: 2,
      mergedAt: "2026-10-22T10:00:00Z",
      files: [{ filename: "moved.rs", previous_filename: "compiler/crates/old.rs" }],
    },
  ];
  assert.deepEqual(
    scopedPullRequests(records, paths, windows(asOf).days90).map(({ number }) => number),
    [2],
  );
});

test("all metrics use half-open UTC windows and calendar-year release history", () => {
  const range = windows(asOf);
  assert.equal(range.days30.start, "2026-09-23T12:00:00.000Z");
  assert.equal(range.days90.start, "2026-07-25T12:00:00.000Z");
  assert.equal(range.releases.start, "2025-10-23T12:00:00.000Z");
  assert.equal(windows("2024-02-29T12:00:00Z").releases.start, "2023-02-28T12:00:00.000Z");
  assert.equal(inWindow(range.days30.start, range.days30), true);
  assert.equal(inWindow(asOf, range.days30), false);
  assert.equal(inWindow(null, range.days30), false);
});

test("publication history separates prereleases and keeps older stable metadata", () => {
  const history = publicationHistory(
    {
      time: {
        "1.0.0": "2025-10-07T00:00:00Z",
        "1.1.0-rc.1": "2026-10-01T00:00:00Z",
        "1.1.0-nightly.2": "2026-10-02T00:00:00Z",
        modified: asOf,
      },
      "dist-tags": { latest: "1.0.0", next: "1.1.0-rc.1" },
      versions: { "1.0.0": {}, "1.1.0-rc.1": {}, "1.1.0-nightly.2": { deprecated: "replaced" } },
    },
    windows(asOf).releases,
  );
  assert.equal(history.latestStable.version, "1.0.0");
  assert.equal(history.releases.filter(({ channel }) => channel === "stable").length, 0);
  assert.equal(history.releases.filter(({ channel }) => channel === "prerelease").length, 2);
  assert.equal(history.releases[1].deprecated, "replaced");
});

test("release-only changes do not masquerade as compiler source work", () => {
  assert.equal(
    classifyFiles(
      [{ filename: "compiler/crates/react_compiler/Cargo.toml" }, { filename: "CHANGELOG.md" }],
      paths,
    ),
    "release-only",
  );
  assert.equal(
    classifyFiles([{ filename: "compiler/crates/react_compiler/src/lib.rs" }], paths),
    "source",
  );
});

test("collector follows PR file pages instead of trusting the first page", async () => {
  const queries = [];
  const client = {
    graphql: async (query, variables) => {
      queries.push(variables);
      if (query.includes("search("))
        return {
          search: {
            issueCount: 1,
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                number: 7,
                title: "Fix",
                url: "https://github.com/react/react/pull/7",
                mergedAt: "2026-10-22T00:00:00Z",
                changedFiles: 2,
                files: {
                  nodes: [{ path: "unrelated.js", changeType: "MODIFIED" }],
                  pageInfo: { hasNextPage: true, endCursor: "next-file" },
                },
              },
            ],
          },
        };
      return {
        repository: {
          pullRequest: {
            files: {
              nodes: [{ path: "compiler/crates/fix.rs", changeType: "MODIFIED" }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      };
    },
  };
  const records = await mergedPullRequests(
    client,
    "react/react",
    "main",
    windows("2026-10-23T12:00:00.500Z").days90,
    [],
  );
  assert.equal(scopedPullRequests(records, paths, windows(asOf).days90).length, 1);
  assert.equal(queries[1].after, "next-file");
  assert.ok(queries[0].query.endsWith("2026-10-23T12:00:00.000Z"));
});

test("collector rejects truncated PR file evidence", async () => {
  const client = {
    graphql: async () => ({
      search: {
        issueCount: 1,
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            number: 7,
            changedFiles: 2,
            files: { nodes: [{ path: "one.js" }], pageInfo: { hasNextPage: false } },
          },
        ],
      },
    }),
  };
  await assert.rejects(
    mergedPullRequests(client, "react/react", "main", windows(asOf).days90, []),
    /Incomplete file list/,
  );
});

test("HTTP failures are not unpublished packages and credentials stay on GitHub", async () => {
  const requests = [];
  const client = createClient({
    token: "test-secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, headers: options.headers });
      return new Response("{}", { status: 404 });
    },
  });
  assert.equal(
    (await client.request("https://registry.npmjs.org/not-published", { allow404: true })).data,
    null,
  );
  assert.equal(requests[0].headers.Authorization, undefined);
  await assert.rejects(client.request("https://api.github.com/repos/missing/repo"), /HTTP 404/);
  assert.equal(requests[1].headers.Authorization, "Bearer test-secret");
  const unauthorized = createClient({
    token: "test-secret",
    fetchImpl: async () => new Response("{}", { status: 401 }),
  });
  await assert.rejects(
    unauthorized.request("https://registry.npmjs.org/not-published", { allow404: true }),
    /HTTP 401/,
  );
});

test("a failed refresh leaves the last saved snapshot intact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "compiler-activity-"));
  const filename = join(directory, "snapshot.json");
  writeFileSync(filename, "previous evidence");
  try {
    await assert.rejects(
      refreshSnapshot(filename, async () => {
        throw new Error("rate limited");
      }),
      /rate limited/,
    );
    assert.equal(readFileSync(filename, "utf8"), "previous evidence");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("crates.io history uses complete package versions and retains yank status", async () => {
  const calls = [];
  const client = {
    request: async (url) => {
      calls.push(url);
      return {
        data: {
          crate: { versions: [4, 3] },
          versions: [
            { id: 4, num: "0.1.0", created_at: "2026-08-31T00:00:00Z", yanked: false },
            { id: 3, num: "0.0.1", created_at: "2026-08-01T00:00:00Z", yanked: true },
          ],
        },
      };
    },
  };
  const result = await collectPackage(
    client,
    { name: "react_compiler", registry: "crates.io" },
    windows(asOf).releases,
  );
  assert.deepEqual(calls, ["https://crates.io/api/v1/crates/react_compiler"]);
  assert.equal(result.releases[0].yanked, true);
  assert.equal(result.latestStable.version, "0.1.0");
});

const savedSnapshot = () =>
  JSON.parse(readFileSync(new URL("./activity.snapshot.json", import.meta.url), "utf8"));

test("saved evidence validates and shared React events remain separately attributed", () => {
  const snapshot = validateSnapshot(savedSnapshot());
  const [babel, rust] = summarize(snapshot);
  assert.ok(babel.commits.some(({ sha }) => rust.commits.some((record) => record.sha === sha)));
  assert.ok(babel.counts.days30.commits <= babel.counts.days90.commits);
  const invalid = structuredClone(snapshot);
  invalid.tracks[0].pullRequests.push(invalid.tracks[0].pullRequests[0]);
  assert.throws(() => validateSnapshot(invalid), /duplicate evidence/);
});

test("offline HTML and Markdown render the same evidence with escaped public text", () => {
  const snapshot = savedSnapshot();
  snapshot.tracks[0].pullRequests[0].title = '<img src=x onerror="bad()">';
  const html = renderHtml(snapshot);
  const markdown = renderMarkdown(snapshot);
  assert.ok(html.includes(snapshot.asOf));
  assert.ok(markdown.includes(snapshot.asOf));
  assert.doesNotMatch(html, /<img src=x|<script/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /text-matched/);
  assert.match(markdown, /Closed is not the same as fixed/);
  for (const { url } of snapshot.sources) assert.ok(html.includes(url.replaceAll("&", "&amp;")));
});

test("offline publication is deterministic and does not fetch", () => {
  const directory = mkdtempSync(join(tmpdir(), "activity-report-"));
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("publication must remain offline");
  };
  try {
    const snapshot = savedSnapshot();
    publishActivity(directory, snapshot);
    const first = ["index.html", "activity.json", "activity.md"].map((filename) =>
      readFileSync(join(directory, filename), "utf8"),
    );
    publishActivity(directory, snapshot);
    assert.deepEqual(
      ["index.html", "activity.json", "activity.md"].map((filename) =>
        readFileSync(join(directory, filename), "utf8"),
      ),
      first,
    );
    assert.deepEqual(JSON.parse(first[1]), snapshot);
    assert.doesNotMatch(first.join("\n"), /\/Users\/|\/home\/runner\/|test-secret/);
  } finally {
    globalThis.fetch = original;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("capped PR searches split into exhaustive adjacent intervals", async () => {
  const queries = [];
  const client = {
    graphql: async (query, variables) => {
      queries.push(variables.query);
      return {
        search: {
          issueCount: queries.length === 1 ? 1001 : 0,
          nodes: [],
          pageInfo: { hasNextPage: false },
        },
      };
    },
  };
  const audit = [];
  assert.deepEqual(
    await mergedPullRequests(client, "react/react", "main", windows(asOf).days90, audit),
    [],
  );
  assert.equal(queries.length, 3);
  assert.equal(audit.length, 2);
  assert.ok(audit.every(({ complete }) => complete));
  const leftEnd = queries[1].split("..")[1];
  const rightStart = queries[2].split("merged:")[1].split("..")[0];
  assert.equal(Date.parse(rightStart) - Date.parse(leftEnd), 1000);
});

test("closed issue searches deduplicate text matches and exclude PRs and reopened issues", async () => {
  const record = {
    number: 2,
    title: "Compiler",
    html_url: "https://github.com/swc-project/swc/issues/2",
    state: "closed",
    closed_at: "2026-10-01T00:00:00Z",
    state_reason: "not_planned",
    labels: [{ name: "wontfix" }],
  };
  const client = {
    request: async () => ({
      data: {
        incomplete_results: false,
        total_count: 3,
        items: [
          record,
          { ...record, number: 3, pull_request: {} },
          { ...record, number: 4, state: "open", closed_at: null },
        ],
      },
      next: null,
    }),
  };
  const result = await closedIssues(
    client,
    {
      repo: "swc-project/swc",
      coverage: "text-matched",
      terms: ["reactCompiler", '"react compiler"'],
    },
    windows(asOf).days90,
    [],
  );
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].reason, "not_planned");
  assert.deepEqual(result.records[0].labels, ["wontfix"]);
  await assert.rejects(
    closedIssues(
      { request: async () => ({ data: { incomplete_results: true } }) },
      { repo: "example/repo", terms: ["compiler"] },
      windows(asOf).days90,
      [],
    ),
    /Incomplete issue search/,
  );
});

test("rate-limit retries honor Retry-After without sending credentials to registries", async () => {
  let calls = 0;
  const waits = [];
  const client = createClient({
    token: "test-secret",
    wait: async (delay) => waits.push(delay),
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response("{}", { status: 403, headers: { "retry-after": "2" } })
        : new Response('{"ok":true}', { status: 200 });
    },
  });
  assert.deepEqual((await client.request("https://api.github.com/graphql")).data, { ok: true });
  assert.deepEqual(waits, [2000]);
  assert.equal(calls, 2);
});

test("partial or duplicated distribution snapshots cannot be published", () => {
  const missing = savedSnapshot();
  missing.packages.pop();
  assert.throws(() => validateSnapshot(missing), /Missing or duplicate package/);
  const duplicated = savedSnapshot();
  duplicated.packages[0].releases.push(duplicated.packages[0].releases[0]);
  assert.throws(() => validateSnapshot(duplicated), /Duplicate package publications/);
  const unavailable = savedSnapshot();
  unavailable.packages[0].status = "not-published";
  assert.throws(() => validateSnapshot(unavailable), /Required publication history unavailable/);
});

test("monthly totals include partial boundary months without changing publication counts", () => {
  const snapshot = savedSnapshot();
  for (const entry of snapshot.packages) {
    const months = monthlyReleases(entry, snapshot.windows.releases);
    assert.equal(months.length, 13);
    assert.equal(
      months.reduce((total, month) => total + month.stable + month.prerelease, 0),
      entry.releases.length,
    );
  }
});
