(() => {
  const report = JSON.parse(document.getElementById("comparison-data").textContent);
  const fixtures = report.cases;
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const element = (id) => document.getElementById(id);
  const cacheDiffers = (fixture) =>
    Object.values(fixture.comparisons).some(
      (comparison) => comparison.cacheMismatch || comparison.slotsMismatch,
    );
  const differs = (fixture) =>
    cacheDiffers(fixture) ||
    Object.values(fixture.comparisons).some((comparison) => comparison.diagnosticPresenceMismatch);
  const labels = { babel: "Babel", oxc: "OXC", swc: "SWC" };
  const cacheLabel = (summary) =>
    summary.cacheEmitted === null
      ? "Unknown"
      : summary.cacheEmitted
        ? `${summary.slots.join(", ")} slots`
        : "No cache";
  const diagnostics = (result) =>
    [
      ...result.diagnostics.map(
        (item) =>
          item.codeframe ??
          item.detail?.message ??
          item.reason ??
          item.message ??
          JSON.stringify(item),
      ),
      ...(result.exception ? [result.exception.message] : []),
    ].join("\n\n") || "No diagnostics reported.";
  let selected;

  function selectFixture(id, scroll = false) {
    const fixture = byId.get(id);
    if (!fixture) return;
    selected = id;
    element("case-title").textContent = id;
    element("case-group").textContent = fixture.group.toUpperCase().replaceAll("-", " ");
    element("case-target").textContent =
      `Target: ${fixture.target} / Babel ${fixture.summary.babel.reason === "suppression-opt-out" ? "suppression opt-out" : fixture.summary.babel.reportedStatus} / RCA ${fixture.summary.analyzer.reportedStatus}`;
    const pair = element("compiler-pair").value;
    const [left, right] = pair.split("-");
    for (const [side, name] of [
      ["left", left],
      ["right", right],
    ]) {
      element(`${side}-name`).textContent = labels[name];
      element(`${side}-output`).setAttribute("aria-label", `${labels[name]} output`);
      element(`${side}-code`).textContent = fixture[name].code;
      element(`${side}-cache`).textContent = cacheLabel(fixture.summary[name]);
      element(`${side}-diagnostic-name`).textContent = `${labels[name]} diagnostics`;
      element(`${side}-diagnostics`).textContent = diagnostics(fixture[name]);
    }
    element("pair-title").textContent = `${labels[left]} / ${labels[right]}`;
    element("input-code").textContent = fixture.source;
    element("source-hash").textContent = `SHA-256 ${fixture.sourceHash}`;
    element("source-link").href = `${id}.source.tsx`;
    element("diff-link").href = `${id}.${pair === "babel-oxc" ? "diff" : `${pair}.diff`}`;
    element("control-link").hidden = !fixture.control;
    element("control-link").href = fixture.control ? `#${fixture.control}` : "#";
    element("diff-code").replaceChildren(
      ...fixture.codegenDiffs[pair].split("\n").map((line) => {
        const span = document.createElement("span");
        span.className = `diff-line${line.startsWith("+") ? " diff-added" : line.startsWith("-") ? " diff-removed" : ""}`;
        span.textContent = line;
        return span;
      }),
    );
    for (const button of document.querySelectorAll("[data-case]")) {
      button.setAttribute("aria-pressed", String(button.dataset.case === id));
      button.closest("tr").dataset.selected = String(button.dataset.case === id);
    }
    history.replaceState(null, "", `#${id}`);
    if (scroll) element("inspector").scrollIntoView({ block: "start" });
  }

  function revealFixture(id, scroll = true) {
    if (!byId.has(id)) return;
    const row = document.querySelector(`[data-row="${id}"]`);
    if (row.hidden) {
      element("outcome-filter").value = "all";
      element("fixture-search").value = "";
      filterFixtures();
    }
    selectFixture(id, scroll);
    if (scroll) element("case-title").focus({ preventScroll: true });
  }

  function filterFixtures() {
    const query = element("fixture-search").value.toLowerCase().trim();
    const mode = element("outcome-filter").value;
    let visible = 0;
    for (const fixture of fixtures) {
      const matchesMode =
        mode === "all" ||
        (mode === "differences" && cacheDiffers(fixture)) ||
        (mode === "bailouts" &&
          ["babel", "oxc", "swc"].some((name) => fixture[name].diagnostics.length)) ||
        (mode === "controls" && !fixture.control);
      const matches = Boolean(
        matchesMode &&
        `${fixture.id} ${fixture.group} ${fixture.target}`.toLowerCase().includes(query),
      );
      document.querySelector(`[data-row="${fixture.id}"]`).hidden = !matches;
      if (matches) visible++;
    }
    element("visible-count").textContent = `${visible} of ${fixtures.length}`;
    element("empty-row").hidden = visible !== 0;
  }

  const tabs = [...document.querySelectorAll("[data-panel]")];
  function activateTab(tab) {
    for (const item of tabs) {
      const active = item === tab;
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
      element(`panel-${item.dataset.panel}`).hidden = !active;
    }
  }
  for (const tab of tabs) {
    tab.addEventListener("click", () => activateTab(tab));
    tab.addEventListener("keydown", (event) => {
      const index = tabs.indexOf(tab);
      const next =
        event.key === "ArrowRight"
          ? (index + 1) % tabs.length
          : event.key === "ArrowLeft"
            ? (index + tabs.length - 1) % tabs.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : null;
      if (next === null) return;
      event.preventDefault();
      activateTab(tabs[next]);
      tabs[next].focus();
    });
  }
  for (const button of document.querySelectorAll("[data-case]")) {
    button.addEventListener("click", () => selectFixture(button.dataset.case, true));
  }
  element("control-link").addEventListener("click", (event) => {
    event.preventDefault();
    revealFixture(byId.get(selected).control);
  });
  for (const link of document.querySelectorAll("[data-evidence-case]")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      element("compiler-pair").value = "babel-swc";
      revealFixture(link.dataset.evidenceCase);
    });
  }
  element("fixture-search").addEventListener("input", filterFixtures);
  element("outcome-filter").addEventListener("change", filterFixtures);
  element("compiler-pair").addEventListener("change", () => selectFixture(selected));
  window.addEventListener("hashchange", () => revealFixture(location.hash.slice(1)));
  filterFixtures();
  revealFixture(
    byId.has(location.hash.slice(1))
      ? location.hash.slice(1)
      : (fixtures.find(cacheDiffers) ?? fixtures.find(differs) ?? fixtures[0]).id,
    false,
  );
})();
