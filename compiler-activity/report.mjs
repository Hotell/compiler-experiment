import { ArrowLeft, ArrowUpRight, FileJson, FileText } from "lucide-react";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { inWindow, summarize, validateSnapshot } from "./model.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const text = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const markdownText = (value) =>
  text(value)
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
const day = (value) => (value ? value.slice(0, 10) : "Unavailable");
const icon = (component) =>
  renderToStaticMarkup(
    createElement(component, { size: 18, strokeWidth: 1.7, "aria-hidden": true }),
  );
const link = (url, label) => `<a href="${text(url)}" rel="noopener noreferrer">${text(label)}</a>`;
const metric = (track, key) => `${track.counts.days30[key]} / ${track.counts.days90[key]}`;

const methods = [
  "All counts use the saved as-of timestamp: half-open UTC windows [start, end). Commits are scoped to captured default-branch SHAs and compiler paths; PRs use merge timestamps and fully paginated changed files, including renamed paths. Overlapping React tracks must not be summed as independent work.",
  "Source commits include tests and documentation under the tracked paths. Release-only means only package manifests, lockfiles, or changelogs changed in that scope. It is a file classification, not a judgement about the value of the work. Bot commits are included. A merged PR and its commits are overlapping signals, not additive units.",
  "Closed is not the same as fixed. Issue counts are currently closed issues with closure dates in the window, not a historical closure-event ledger. Reopened issues are excluded. Labels and states are observed at collection time. React's compiler queue is shared across Babel and Rust; OXC uses its compiler area label. SWC counts text-matched titles/bodies, which can miss issues or include incidental mentions.",
  "Release history covers the preceding 12 calendar months; first and last month buckets are partial. Stable and prerelease publications are separate. Registry tags are captured independently of publication dates. The most recent stable publication is retained even outside the history window. Deprecated or yanked versions remain in historical counts and are marked in downloadable evidence.",
  "Package releases are distribution activity, not necessarily compiler changes. SWC and integration packages contain many unrelated features. Main-branch source changes are not proof that a fix shipped in any particular package version. Dependency lineage here reflects pinned repository manifests, not a reverse mapping of every npm release.",
  "This is an explicitly refreshed snapshot, not live data or a transactional view of GitHub. Queries, completeness checks, pinned manifests, and all counted evidence are downloadable. A failed refresh preserves the previous snapshot; deployment and rendering never fetch upstream data. Documentation review date is separate from the activity collection date.",
  "Activity does not establish correctness, safety, feature parity, production readiness, adoption, or performance. No composite health score or compiler winner is inferred. Compiler activity remains separate from the application benchmark and compatibility results.",
];

export function monthlyReleases(entry, range) {
  const months = [];
  const cursor = new Date(`${range.start.slice(0, 7)}-01T00:00:00Z`);
  while (cursor.getTime() < Date.parse(range.end)) {
    const month = cursor.toISOString().slice(0, 7);
    const releases = entry.releases.filter(({ date }) => date.slice(0, 7) === month);
    months.push({
      month,
      stable: releases.filter(({ channel }) => channel === "stable").length,
      prerelease: releases.filter(({ channel }) => channel === "prerelease").length,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

export function renderMarkdown(input) {
  const snapshot = validateSnapshot(input);
  const tracks = summarize(snapshot);
  const lines = [
    "# Compiler activity",
    "",
    `As of: ${snapshot.asOf}. Documentation reviewed: ${snapshot.research.reviewedAt}.`,
    "",
    "## Compiler-path activity",
    "",
    "Counts are 30 days / 90 days. Source commits include tests/docs; all commits also include release-only changes.",
    "",
    "| Track | Source commits | All commits | Merged PRs | Latest source change in window |",
    "| --- | ---: | ---: | ---: | --- |",
  ];
  for (const track of tracks)
    lines.push(
      `| ${track.name} | ${metric(track, "sourceCommits")} | ${metric(track, "commits")} | ${metric(track, "merged")} | ${day(track.commits.find(({ kind }) => kind === "source")?.date)} |`,
    );
  lines.push("", "## Research findings", "");
  for (const finding of snapshot.research.findings)
    lines.push(
      `- ${finding.text} ${finding.sources
        .map((id) => {
          const source = snapshot.sources.find((entry) => entry.id === id);
          return `[${source.title}](${source.url})`;
        })
        .join(" ")}`,
    );
  lines.push(
    "",
    "## Closed issues",
    "",
    "| Scope | Coverage | 30 days | 90 days |",
    "| --- | --- | ---: | ---: |",
  );
  for (const scope of snapshot.issues)
    lines.push(
      `| ${scope.name} | ${scope.coverage} | ${scope.records.filter(({ closedAt }) => inWindow(closedAt, snapshot.windows.days30)).length} | ${scope.records.length} |`,
    );
  lines.push(
    "",
    "## Package publications",
    "",
    "| Package | Registry | Most recent stable publication | Stable / prerelease in 12 months |",
    "| --- | --- | --- | ---: |",
  );
  for (const entry of snapshot.packages)
    lines.push(
      `| ${entry.name} | ${entry.registry} | ${entry.latestStable ? `${entry.latestStable.version} (${day(entry.latestStable.date)})` : entry.status} | ${entry.releases.filter(({ channel }) => channel === "stable").length} / ${entry.releases.filter(({ channel }) => channel === "prerelease").length} |`,
    );
  for (const entry of snapshot.packages.filter(({ status }) => status === "available")) {
    lines.push(
      "",
      `### ${entry.name} monthly publications`,
      "",
      "| Month (UTC) | Stable | Prerelease |",
      "| --- | ---: | ---: |",
      ...monthlyReleases(entry, snapshot.windows.releases).map(
        ({ month, stable, prerelease }) => `| ${month} | ${stable} | ${prerelease} |`,
      ),
    );
  }
  lines.push(
    "",
    "## Integration support",
    "",
    ...snapshot.research.integrations.map(
      (entry) => `- ${entry.name}: ${entry.requirement}; ${entry.configuration}.`,
    ),
  );
  for (const track of tracks) {
    lines.push(
      "",
      `## ${track.name} evidence`,
      "",
      track.description,
      "",
      `Repository: ${track.repo}; captured HEAD: ${track.head}. Paths: ${track.paths.join(", ")}.`,
      "",
      "### Recent merged PRs",
      "",
      ...track.pullRequests
        .slice(0, 5)
        .map(
          (record) =>
            `- ${day(record.mergedAt)}: [#${record.number}: ${markdownText(record.title)}](${record.url}) (${record.kind})`,
        ),
    );
  }
  lines.push("", "## Recent closed issues", "");
  for (const scope of snapshot.issues)
    lines.push(
      `### ${scope.name}`,
      "",
      ...scope.records
        .slice(0, 5)
        .map(
          (record) =>
            `- ${day(record.closedAt)}: [#${record.number}: ${markdownText(record.title)}](${record.url}); reason: ${record.reason}.`,
        ),
      "",
    );
  lines.push(
    "## Methodology and limitations",
    "",
    ...methods.flatMap((method) => [method, ""]),
    "## Source references",
    "",
    ...snapshot.sources.map((source) => `- [${source.title}](${source.url})`),
    "",
    "## Pinned manifest evidence",
    "",
    ...snapshot.manifests.map(
      (manifest) => `- [${manifest.repo}: ${manifest.path}](${manifest.url})`,
    ),
    "",
  );
  return lines.join("\n");
}

export function renderHtml(input) {
  const snapshot = validateSnapshot(input);
  const tracks = summarize(snapshot);
  const rows = tracks
    .map(
      (track) =>
        `<tr data-track="${text(track.id)}"><th scope="row"><a href="#${text(track.id)}">${text(track.name)}</a></th><td data-metric="source">${metric(track, "sourceCommits")}</td><td data-metric="commits">${metric(track, "commits")}</td><td data-metric="merged">${metric(track, "merged")}</td><td>${day(track.commits.find(({ kind }) => kind === "source")?.date)}</td></tr>`,
    )
    .join("");
  const issueRows = snapshot.issues
    .map(
      (scope) =>
        `<tr data-issue-scope="${text(scope.repo)}"><th scope="row">${text(scope.name)}</th><td>${text(scope.coverage)}${scope.label ? `<span class="cell-detail">${text(scope.label)}</span>` : '<span class="cell-detail">Limited title/body coverage</span>'}</td><td>${scope.records.filter(({ closedAt }) => inWindow(closedAt, snapshot.windows.days30)).length}</td><td>${scope.records.length}</td></tr>`,
    )
    .join("");
  const packageRows = snapshot.packages
    .map(
      (entry) =>
        `<tr><th scope="row">${link(entry.registry === "npm" ? `https://www.npmjs.com/package/${entry.name}` : `https://crates.io/crates/${entry.name}`, entry.name)}<span class="cell-detail">${text(entry.registry)} / ${text(entry.group)}</span></th><td>${entry.latestStable ? `${text(entry.latestStable.version)}<span class="cell-detail">${day(entry.latestStable.date)}${entry.latestStable.yanked ? " / yanked" : ""}${entry.latestStable.deprecated ? " / deprecated" : ""}</span>` : '<span class="muted">No public npm package found</span>'}</td><td>${entry.status === "available" ? entry.releases.filter(({ channel }) => channel === "stable").length : "Unavailable"}</td><td>${entry.status === "available" ? entry.releases.filter(({ channel }) => channel === "prerelease").length : "Unavailable"}</td></tr>`,
    )
    .join("");
  const histories = snapshot.packages
    .filter(({ status }) => status === "available")
    .map((entry) => {
      const months = monthlyReleases(entry, snapshot.windows.releases);
      const maximum = Math.max(1, ...months.map(({ stable, prerelease }) => stable + prerelease));
      return `<details class="release-history"><summary>${text(entry.name)} <span class="muted">Monthly publications</span></summary><div class="table-scroll" role="region" aria-label="${text(entry.name)} monthly releases" tabindex="0"><table class="month-table"><thead><tr><th scope="col">Month (UTC)</th><th scope="col">Stable</th><th scope="col">Prerelease</th><th scope="col">Publication volume</th></tr></thead><tbody>${months.map(({ month, stable, prerelease }) => `<tr><th scope="row">${month}</th><td>${stable}</td><td>${prerelease}</td><td><div class="release-bars" aria-hidden="true"><span class="stable-bar" style="width:${(100 * stable) / maximum}%"></span><span class="prerelease-bar" style="width:${(100 * prerelease) / maximum}%"></span></div></td></tr>`).join("")}</tbody></table></div><p class="muted">Captured tags: ${text(
        Object.entries(entry.tags)
          .map(([tag, version]) => `${tag}: ${version}`)
          .join("; ") || "No npm distribution tags",
      )}</p></details>`;
    })
    .join("");
  const evidence = tracks
    .map(
      (track) =>
        `<section id="${text(track.id)}" class="track-evidence"><div class="section-heading"><h2>${text(track.name)}</h2>${link(`https://github.com/${track.repo}/tree/${track.head}/${track.paths[0]}`, "Pinned compiler source")}</div><p>${text(track.description)}</p><p class="muted">${text(track.repo)} / <code>${text(track.head.slice(0, 12))}</code><br>${track.paths.map((path) => `<code>${text(path)}</code>`).join("<br>")}</p><div class="evidence-grid"><div><h3>Recent merged PRs</h3>${recordList(track.pullRequests.slice(0, 5), "mergedAt", (record) => record.kind)}</div><div><h3>Recent compiler-path commits</h3>${recordList(track.commits.slice(0, 5), "date", (record) => `${record.kind}${record.bot ? " / bot" : ""}`)}${track.latestChange ? `<p class="muted">Most recent path change: ${link(track.latestChange.url, day(track.latestChange.date))}</p>` : ""}</div></div></section>`,
    )
    .join("");
  const issueEvidence = snapshot.issues
    .map(
      (scope) =>
        `<details class="issue-evidence"><summary>${text(scope.name)}: recent closures</summary>${recordList(
          scope.records.slice(0, 5),
          "closedAt",
          (record) =>
            `${record.reason}${record.labels
              .filter((label) => /stale|duplicate|wontfix|wont.fix/i.test(label))
              .map((label) => ` / ${label}`)
              .join("")}`,
        )}</details>`,
    )
    .join("");
  const stylesheet =
    readFileSync(join(directory, "../compiler-repros/report.css"), "utf8") +
    readFileSync(join(directory, "report.css"), "utf8");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#f6f8f8"><title>Compiler activity / Signal</title><style>${stylesheet}</style></head><body>
  <header class="site-header"><a class="brand" href="../" aria-label="Signal comparisons"><span class="brand-mark">S<span>.</span></span><span class="brand-name">signal<span>.</span></span><span class="brand-context">compiler research</span></a><a class="text-link" href="../">${icon(ArrowLeft)} All comparisons</a></header>
  <main class="activity-main"><section class="activity-heading"><div><span class="eyebrow">REACT COMPILER / ECOSYSTEM EVIDENCE</span><h1>Compiler activity</h1><p class="as-of">Snapshot as of <time datetime="${text(snapshot.asOf)}">${text(snapshot.asOf)}</time></p></div><nav aria-label="Research downloads"><a class="text-link" href="activity.json" download>${icon(FileJson)} JSON evidence</a><a class="text-link" href="activity.md" download>${icon(FileText)} Markdown report</a></nav></section>
  <nav class="jump-links" aria-label="Report sections"><a href="#activity">Compiler paths</a><a href="#issues">Issue triage</a><a href="#releases">Releases</a><a href="#integrations">Integrations</a><a href="#methodology">Methodology</a></nav>
  <section id="activity"><div class="section-heading"><h2>Compiler-path activity</h2><span class="window-key">30 days / 90 days</span></div><div class="table-scroll" role="region" aria-label="Compiler activity counts" tabindex="0"><table><thead><tr><th scope="col">Compiler track</th><th scope="col">Source commits</th><th scope="col">All commits</th><th scope="col">Merged PRs</th><th scope="col">Latest source change in window</th></tr></thead><tbody>${rows}</tbody></table></div><p class="scope-note">Source commits include tests and docs. All commits also include release-only changes. React tracks overlap; these are not independent totals. SWC counts cover its adapter, not all upstream Rust core changes.</p></section>
  <section class="research-findings"><h2>What the evidence establishes</h2>${snapshot.research.findings
    .map(
      (finding) =>
        `<p>${text(finding.text)} <span class="finding-sources">${finding.sources
          .map((id) => {
            const source = snapshot.sources.find((entry) => entry.id === id);
            return link(source.url, source.title);
          })
          .join(" / ")}</span></p>`,
    )
    .join(
      "",
    )}<p class="scope-note">Activity is not a correctness, readiness, or performance verdict. Source fixes on main are not necessarily released.</p></section>
  <section id="issues"><h2>Closed issues</h2><div class="table-scroll" role="region" aria-label="Compiler issue triage" tabindex="0"><table><thead><tr><th scope="col">Issue scope</th><th scope="col">Attribution</th><th scope="col">30 days</th><th scope="col">90 days</th></tr></thead><tbody>${issueRows}</tbody></table></div><p class="scope-note">Closed is not the same as fixed. Shared React triage is counted once; SWC is text-matched, not comprehensive compiler issue coverage.</p>${issueEvidence}</section>
  <section id="releases"><h2>Package publication history</h2><p class="muted">${day(snapshot.windows.releases.start)} to ${day(snapshot.asOf)}. Package-wide publication activity, not compiler-specific release counts.</p><div class="table-scroll" role="region" aria-label="Compiler package publications" tabindex="0"><table><thead><tr><th scope="col">Distribution</th><th scope="col">Most recent stable publication</th><th scope="col">Stable / 12 months</th><th scope="col">Prerelease / 12 months</th></tr></thead><tbody>${packageRows}</tbody></table></div><p class="release-legend"><span class="stable-key">Stable</span><span class="prerelease-key">Prerelease</span><span class="muted">Partial first and last months</span></p>${histories}</section>
  <section id="integrations"><h2>Integration support and compiler lineage</h2><div class="table-scroll" role="region" aria-label="Build tool compiler support" tabindex="0"><table><thead><tr><th scope="col">Integration</th><th scope="col">Documented minimum</th><th scope="col">Configuration</th></tr></thead><tbody>${snapshot.research.integrations.map((entry) => `<tr><th scope="row">${link(snapshot.sources.find(({ id }) => id === entry.source).url, entry.name)}</th><td><code>${text(entry.requirement)}</code></td><td><code>${text(entry.configuration)}</code></td></tr>`).join("")}</tbody></table></div><p class="scope-note">These are documentation requirements, not a compatibility matrix tested by this activity report. Documentation reviewed ${text(snapshot.research.reviewedAt)}.</p>${snapshot.manifests.map((manifest) => `<details><summary>${text(manifest.repo)}: pinned manifest</summary><p>${link(manifest.url, manifest.path)}</p><pre tabindex="0">${text(manifest.text)}</pre></details>`).join("")}</section>
  ${evidence}<section id="methodology"><h2>Methodology and limitations</h2>${methods.map((method) => `<p>${text(method)}</p>`).join("")}<p class="muted">Fetched ${text(snapshot.fetchedAt.start)} through ${text(snapshot.fetchedAt.end)}. Collector schema ${snapshot.schemaVersion}.</p><details><summary>Query and completeness ledger</summary><pre tabindex="0">${text(JSON.stringify(snapshot.audit, null, 2))}</pre></details></section>
  <section id="sources"><h2>Source references</h2><ul class="source-list">${snapshot.sources.map((source) => `<li>${link(source.url, source.title)} ${icon(ArrowUpRight)}</li>`).join("")}</ul></section><footer><span>DATED RESEARCH / NOT A PERFORMANCE BENCHMARK</span><a class="text-link" href="../compiler-repros/">Compiler compatibility ${icon(ArrowUpRight)}</a></footer></main></body></html>`;
}

function recordList(records, dateKey, detail) {
  if (!records.length) return '<p class="muted">No matching events in this window.</p>';
  return `<ul class="record-list">${records.map((record) => `<li>${link(record.url, `${record.number ? `#${record.number}: ` : ""}${record.title}`)}<span class="cell-detail">${day(record[dateKey])} / ${text(detail(record))}</span></li>`).join("")}</ul>`;
}

export function publishActivity(
  outputDirectory,
  snapshot = JSON.parse(readFileSync(join(directory, "activity.snapshot.json"), "utf8")),
) {
  validateSnapshot(snapshot);
  const html = renderHtml(snapshot);
  const markdown = renderMarkdown(snapshot);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, "index.html"), html);
  writeFileSync(join(outputDirectory, "activity.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(join(outputDirectory, "activity.md"), markdown);
  return snapshot;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDirectory = process.argv.includes("--local")
    ? join(directory, "results")
    : resolve(directory, "../dist-pages/compiler-activity");
  publishActivity(outputDirectory);
  console.log(`Published offline compiler activity: ${join(outputDirectory, "index.html")}`);
}
