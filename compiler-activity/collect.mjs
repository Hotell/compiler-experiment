import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyFiles,
  inWindow,
  matchesPaths,
  publicationHistory,
  scopedPullRequests,
  validateSnapshot,
  windows,
} from "./model.mjs";
import { issueScopes, packages, research, sources, tracks } from "./sources.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const github = "https://api.github.com";

export function createClient({
  token,
  fetchImpl = fetch,
  wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  cacheDirectory,
} = {}) {
  async function request(url, { body, allow404 = false, cache = false } = {}) {
    const cacheFile =
      cacheDirectory && cache
        ? join(
            cacheDirectory,
            `${createHash("sha256")
              .update(url + JSON.stringify(body ?? null))
              .digest("hex")}.json`,
          )
        : null;
    if (cacheFile && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, "utf8"));
    const headers = {
      Accept: "application/json",
      "User-Agent": "Hotell/compiler-experiment (compiler activity research)",
    };
    if (new URL(url).origin === github && token) headers.Authorization = `Bearer ${token}`;
    if (body) headers["Content-Type"] = "application/json";
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetchImpl(url, {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60000),
        redirect: "error",
      });
      if (response.status === 404 && allow404) return { data: null, next: null };
      if (
        [429, 502, 503, 504].includes(response.status) ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after")))
      ) {
        const retryAfter = response.headers.get("retry-after");
        const reset = response.headers.get("x-ratelimit-reset");
        const delay = retryAfter
          ? Number.isFinite(Number(retryAfter))
            ? Number(retryAfter) * 1000
            : Date.parse(retryAfter) - Date.now()
          : reset
            ? Number(reset) * 1000 - Date.now()
            : 1000 * 2 ** attempt;
        if (attempt < 2 && delay <= 30000) {
          await wait(Math.max(0, delay));
          continue;
        }
      }
      if (!response.ok)
        throw new Error(`HTTP ${response.status} fetching ${url}; previous snapshot is unchanged`);
      const data = await response.json();
      const next = response.headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1] ?? null;
      if (next)
        assert.equal(new URL(next).origin, new URL(url).origin, "Cross-origin pagination rejected");
      const result = { data, next };
      if (cacheFile) {
        mkdirSync(cacheDirectory, { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(result));
      }
      return result;
    }
    throw new Error(`Retries exhausted fetching ${url}`);
  }
  async function graphql(query, variables) {
    const { data } = await request(`${github}/graphql`, { body: { query, variables } });
    if (data.errors?.length)
      throw new Error(`GitHub GraphQL: ${data.errors.map(({ message }) => message).join("; ")}`);
    return data.data;
  }
  async function pages(url, field, options) {
    const records = [];
    do {
      const result = await request(url, options);
      const entries = field ? result.data[field] : result.data;
      assert.ok(Array.isArray(entries), `Missing paginated records: ${url}`);
      records.push(...entries);
      url = result.next;
    } while (url);
    return records;
  }
  return { request, graphql, pages };
}

const pageInfo = "pageInfo { hasNextPage endCursor }";
const fileFields = `nodes { path changeType } ${pageInfo}`;
const prQuery = `query($query:String!,$after:String) { search(query:$query,type:ISSUE,first:25,after:$after) { issueCount ${pageInfo} nodes { ... on PullRequest { number title url mergedAt changedFiles files(first:100) { ${fileFields} } } } } }`;
const prFilesQuery = `query($owner:String!,$name:String!,$number:Int!,$after:String) { repository(owner:$owner,name:$name) { pullRequest(number:$number) { files(first:100,after:$after) { ${fileFields} } } } }`;
const dateQuery = (field, range) =>
  `${field}:${range.start}..${new Date(Math.ceil(Date.parse(range.end) / 1000) * 1000 - 1000).toISOString()}`;

export async function mergedPullRequests(client, repo, branch, range, audit, progress = () => {}) {
  const query = `repo:${repo} is:pr is:merged base:${branch} ${dateQuery("merged", range)}`;
  let after = null;
  const records = [];
  let expected;
  do {
    const data = (await client.graphql(prQuery, { query, after })).search;
    if (data.issueCount > 1000) {
      const middle = new Date(
        Math.floor((Date.parse(range.start) + Date.parse(range.end)) / 2000) * 1000,
      ).toISOString();
      assert.ok(
        middle > range.start && middle < range.end,
        "Cannot split capped PR search further",
      );
      return [
        ...(await mergedPullRequests(
          client,
          repo,
          branch,
          { start: range.start, end: middle },
          audit,
          progress,
        )),
        ...(await mergedPullRequests(
          client,
          repo,
          branch,
          { start: middle, end: range.end },
          audit,
          progress,
        )),
      ];
    }
    expected ??= data.issueCount;
    assert.equal(data.issueCount, expected, "PR search changed during collection; retry refresh");
    for (const record of data.nodes) {
      assert.ok(record.files && Number.isInteger(record.changedFiles), "Missing PR file evidence");
      assert.ok(
        record.changedFiles <= 3000,
        `PR ${repo}#${record.number}: file API limit exceeded`,
      );
      let connection = record.files;
      const files = [...connection.nodes];
      while (connection.pageInfo.hasNextPage) {
        const [owner, name] = repo.split("/");
        connection = (
          await client.graphql(prFilesQuery, {
            owner,
            name,
            number: record.number,
            after: connection.pageInfo.endCursor,
          })
        ).repository.pullRequest.files;
        files.push(...connection.nodes);
      }
      assert.equal(
        files.length,
        record.changedFiles,
        `Incomplete file list for ${repo}#${record.number}`,
      );
      const renamed = files.some(({ changeType }) => changeType === "RENAMED");
      const normalized = renamed
        ? (
            await client.pages(
              `${github}/repos/${repo}/pulls/${record.number}/files?per_page=100`,
              null,
              { cache: true },
            )
          ).map(({ filename, previous_filename }) => ({
            filename,
            ...(previous_filename ? { previous_filename } : {}),
          }))
        : files.map(({ path }) => ({ filename: path }));
      assert.equal(
        normalized.length,
        record.changedFiles,
        `Incomplete file list for ${repo}#${record.number}`,
      );
      records.push({
        number: record.number,
        title: record.title,
        url: record.url,
        mergedAt: record.mergedAt,
        files: normalized,
      });
    }
    progress(`${repo}: inspected ${records.length}/${expected} merged PRs in search interval`);
    after = data.pageInfo.hasNextPage ? data.pageInfo.endCursor : null;
  } while (after);
  assert.equal(new Set(records.map(({ number }) => number)).size, expected, "Incomplete PR search");
  audit.push({ kind: "merged-pr-search", query, candidates: expected, complete: true });
  return records;
}

export async function closedIssues(client, scope, range, audit) {
  if (scope.label)
    await client.request(`${github}/repos/${scope.repo}/labels/${encodeURIComponent(scope.label)}`);
  async function search(term, interval) {
    const query = `repo:${scope.repo} is:issue is:closed ${term} ${dateQuery("closed", interval)}`;
    const url = new URL(`${github}/search/issues`);
    url.search = new URLSearchParams({ q: query, per_page: "100" }).toString();
    let current = url.href;
    const records = [];
    let expected;
    do {
      const { data, next } = await client.request(current);
      assert.equal(data.incomplete_results, false, `Incomplete issue search: ${query}`);
      if (data.total_count > 1000) {
        const middle = new Date(
          Math.floor((Date.parse(interval.start) + Date.parse(interval.end)) / 2000) * 1000,
        ).toISOString();
        assert.ok(
          middle > interval.start && middle < interval.end,
          "Cannot split capped issue search further",
        );
        return [
          ...(await search(term, { start: interval.start, end: middle })),
          ...(await search(term, { start: middle, end: interval.end })),
        ];
      }
      expected ??= data.total_count;
      records.push(...data.items);
      current = next;
    } while (current);
    assert.equal(
      new Set(records.map(({ number }) => number)).size,
      expected,
      "Incomplete issue records",
    );
    audit.push({ kind: "closed-issue-search", query, candidates: expected, complete: true });
    return records;
  }
  const found = [];
  for (const term of scope.terms) found.push(...(await search(term, range)));
  return {
    ...scope,
    complete: true,
    records: [
      ...new Map(
        found
          .filter(
            (record) =>
              !record.pull_request &&
              record.state === "closed" &&
              inWindow(record.closed_at, range),
          )
          .map((record) => [
            record.number,
            {
              number: record.number,
              title: record.title,
              url: record.html_url,
              state: record.state,
              closedAt: record.closed_at,
              reason: record.state_reason ?? "unknown",
              labels: record.labels.map(({ name }) => name),
            },
          ]),
      ).values(),
    ].sort((left, right) => right.closedAt.localeCompare(left.closedAt)),
  };
}

export async function collectPackage(client, entry, range) {
  const url =
    entry.registry === "npm"
      ? `https://registry.npmjs.org/${encodeURIComponent(entry.name)}`
      : `https://crates.io/api/v1/crates/${entry.name}`;
  const { data } = await client.request(url, { allow404: entry.optional === true });
  if (!data)
    return { ...entry, url, status: "not-published", releases: [], latestStable: null, tags: {} };
  if (entry.registry === "npm")
    return { ...entry, url, status: "available", ...publicationHistory(data, range) };
  const versions = data.versions;
  assert.ok(
    Array.isArray(versions) && Array.isArray(data.crate?.versions),
    "Missing crates.io version history",
  );
  assert.deepEqual(
    versions.map(({ id }) => id).sort(),
    [...data.crate.versions].sort(),
    "Incomplete crates.io version history",
  );
  const packument = {
    time: Object.fromEntries(versions.map((version) => [version.num, version.created_at])),
    versions: Object.fromEntries(versions.map((version) => [version.num, {}])),
  };
  const history = publicationHistory(packument, range);
  for (const release of [
    ...history.releases,
    ...(history.latestStable ? [history.latestStable] : []),
  ])
    release.yanked = versions.find(({ num }) => num === release.version).yanked;
  return { ...entry, url, status: "available", ...history };
}

export async function collectSnapshot({
  client,
  asOf = new Date().toISOString(),
  progress = () => {},
}) {
  const ranges = windows(asOf);
  const audit = [];
  const repositories = {};
  const collectedTracks = [];
  for (const repo of new Set(tracks.map((track) => track.repo))) {
    const metadata = (await client.request(`${github}/repos/${repo}`)).data;
    const head = (
      await client.request(`${github}/repos/${repo}/commits/${metadata.default_branch}`)
    ).data.sha;
    repositories[repo] = { branch: metadata.default_branch, head };
  }
  for (const [repo, { branch, head }] of Object.entries(repositories)) {
    progress(`${repo}: collecting path-scoped commits`);
    const definitions = tracks.filter((track) => track.repo === repo);
    const commits = new Map();
    const latest = new Map();
    for (const path of definitions.flatMap((track) => track.paths)) {
      const params = new URLSearchParams({
        sha: head,
        path,
        per_page: "100",
        since: ranges.days90.start,
        until: asOf,
      });
      const records = await client.pages(`${github}/repos/${repo}/commits?${params}`);
      for (const record of records) commits.set(record.sha, record);
      const recent = (
        await client.request(
          `${github}/repos/${repo}/commits?${new URLSearchParams({ sha: head, path, per_page: "1", until: asOf })}`,
        )
      ).data[0];
      if (recent)
        latest.set(path, {
          sha: recent.sha,
          title: recent.commit.message.split("\n")[0],
          date: recent.commit.committer.date,
          url: recent.html_url,
        });
      audit.push({
        kind: "commit-history",
        repo,
        path,
        head,
        since: ranges.days90.start,
        until: asOf,
        records: records.length,
        complete: true,
      });
    }
    const detailed = [];
    for (const record of commits.values()) {
      const files = (
        await client.pages(`${github}/repos/${repo}/commits/${record.sha}?per_page=100`, "files", {
          cache: true,
        })
      ).map(({ filename, previous_filename }) => ({
        filename,
        ...(previous_filename ? { previous_filename } : {}),
      }));
      detailed.push({
        sha: record.sha,
        title: record.commit.message.split("\n")[0],
        date: record.commit.committer.date,
        url: record.html_url,
        bot: record.author?.type === "Bot",
        files,
      });
    }
    const prs = await mergedPullRequests(client, repo, branch, ranges.days90, audit, progress);
    for (const definition of definitions) {
      const trim = (record) => ({
        ...record,
        kind: classifyFiles(record.files, definition.paths),
        files: record.files.filter((file) => matchesPaths(file, definition.paths)),
      });
      const trackCommits = detailed
        .filter(
          (record) =>
            inWindow(record.date, ranges.days90) &&
            record.files.some((file) => matchesPaths(file, definition.paths)),
        )
        .map(trim)
        .sort((left, right) => right.date.localeCompare(left.date));
      collectedTracks.push({
        ...definition,
        head,
        branch,
        complete: true,
        latestChange:
          definition.paths
            .map((path) => latest.get(path))
            .filter(Boolean)
            .sort((left, right) => right.date.localeCompare(left.date))[0] ?? null,
        commits: trackCommits,
        pullRequests: scopedPullRequests(prs, definition.paths, ranges.days90)
          .map(trim)
          .sort((left, right) => right.mergedAt.localeCompare(left.mergedAt)),
      });
    }
  }
  const issues = [];
  for (const scope of issueScopes) {
    progress(`${scope.repo}: collecting closed compiler issues`);
    issues.push(await closedIssues(client, scope, ranges.days90, audit));
  }
  const publications = [];
  for (const entry of packages) {
    progress(`${entry.registry}: ${entry.name}`);
    publications.push(await collectPackage(client, entry, ranges.releases));
  }
  const manifests = [];
  for (const [repo, path] of [
    ["oxc-project/oxc", "crates/oxc_react_compiler/Cargo.toml"],
    ["swc-project/swc", "crates/swc_ecma_react_compiler/Cargo.toml"],
    ["react/react", "compiler/packages/babel-plugin-react-compiler-rust/package.json"],
  ]) {
    const head = repositories[repo].head;
    const { data } = await client.request(`${github}/repos/${repo}/contents/${path}?ref=${head}`);
    assert.equal(data.encoding, "base64");
    manifests.push({
      repo,
      path,
      head,
      url: `https://github.com/${repo}/blob/${head}/${path}`,
      text: Buffer.from(data.content, "base64").toString("utf8"),
    });
  }
  return validateSnapshot({
    schemaVersion: 1,
    collectorVersion: 1,
    asOf,
    fetchedAt: { start: asOf, end: new Date().toISOString() },
    windows: ranges,
    tracks: collectedTracks,
    issues,
    packages: publications,
    sources,
    research,
    manifests,
    audit,
  });
}

export async function refreshSnapshot(filename, collect) {
  const snapshot = validateSnapshot(await collect());
  const temporary = `${filename}.pending`;
  try {
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, { force: true });
  }
  return snapshot;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token && process.argv.includes("--gh-auth")) {
    const credential = spawnSync("gh", ["auth", "token", "--user", "Hotell"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (credential.status === 0) token = credential.stdout.trim();
  }
  if (!token)
    throw new Error(
      "Set GH_TOKEN/GITHUB_TOKEN, or use --gh-auth with the existing Hotell login. Never paste a token into chat.",
    );
  const client = createClient({ token, cacheDirectory: join(directory, ".cache") });
  let lastMessage = "";
  const progress = (message) => {
    if (!message.includes("inspected") || /(?:250|500|750|1000)\//.test(message)) {
      console.error(message);
      lastMessage = message;
    }
  };
  const snapshot = await refreshSnapshot(join(directory, "activity.snapshot.json"), () =>
    collectSnapshot({ client, progress }),
  );
  console.log(
    `Saved compiler activity as of ${snapshot.asOf}; ${snapshot.tracks.length} tracks. ${lastMessage}`,
  );
}
