export function suppressionOptOut(result, target) {
  return (
    !result.fatal &&
    Boolean(
      result.diagnostics?.some(
        (diagnostic) =>
          (diagnostic.name == null || diagnostic.name === target) &&
          (diagnostic.detail?.category === "Suppression" ||
            diagnostic.message === "React rule suppression prevents optimization"),
      ),
    )
  );
}

export function suppressionFinding(report) {
  if (report.failures?.length) return null;
  const byId = new Map(report.cases.map((fixture) => [fixture.id, fixture]));
  const valid = byId.get("valid-hooks-redundant-suppression");
  const control = byId.get("valid-hooks-redundant-suppression-control");
  const invalidSuppressed = byId.get("invalid-hooks-with-suppression");
  const invalid = byId.get("invalid-hooks-with-suppression-control");
  const moduleSuppressed = byId.get("module-suppression");
  const moduleWithoutOptOut = byId.get("module-suppression-no-opt-out");
  const moduleControl = byId.get("module-suppression-control");
  const moduleWithoutOptOutControl = byId.get("module-suppression-no-opt-out-control");
  const compilers = ["babel", "oxc", "swc"];
  if (
    ![control, moduleControl, moduleWithoutOptOutControl].every((fixture) =>
      compilers.every((compiler) => fixture?.summary[compiler]?.cacheEmitted === true),
    ) ||
    ![valid, moduleSuppressed, moduleWithoutOptOut].every(
      (fixture) =>
        ["babel", "swc"].every((compiler) => fixture?.summary[compiler]?.cacheEmitted === true) &&
        fixture?.summary.oxc?.cacheEmitted === false &&
        fixture?.summary.oxc?.reason === "suppression-opt-out",
    ) ||
    !compilers.every((compiler) => {
      const functions = moduleSuppressed?.[compiler]?.functions.filter(
        (record) => record.name === "One",
      );
      return functions?.length === 1 && functions[0].slots.length === 0;
    }) ||
    ![invalidSuppressed, invalid].every((fixture) =>
      compilers.every((compiler) => fixture?.summary[compiler]?.cacheEmitted === false),
    ) ||
    report.provenance.packages["babel-plugin-react-compiler"].version.includes("-experimental-") ===
      false
  )
    return null;

  return {
    title: "Babel and SWC avoid module-suppression bailouts",
    summary:
      'With the tested versions, experimental Babel and SWC memoize Two despite a module-level Rules of Hooks suppression. OXC reports a suppression opt-out and emits no cache for Two. All three respect One\'s local "use no memo" directive.',
    validation:
      "The same cache difference remains without One's directive and for a valid effect with a redundant hooks-lint suppression. All three emit no memo cache for the tested invalid conditional-hook examples, with or without suppression.",
    caveat:
      "This demonstrates broader optimization coverage, not proven redundancy detection or overall compiler correctness.",
    evidence: [
      { id: moduleSuppressed.id, label: "Module suppression + local opt-out" },
      { id: moduleControl.id, label: "Unsuppressed sibling control" },
      {
        id: moduleWithoutOptOut.id,
        label: "Module suppression, no local opt-out",
      },
      { id: valid.id, label: "Valid hooks + redundant suppression" },
      { id: invalidSuppressed.id, label: "Invalid hooks + suppression" },
      { id: invalid.id, label: "Invalid hooks, no suppression" },
    ],
  };
}
