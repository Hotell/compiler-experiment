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
  const control = byId.get("valid-hooks-no-suppression");
  const invalidSuppressed = byId.get("invalid-hooks-with-suppression");
  const invalid = byId.get("invalid-hooks-no-suppression");
  const compilers = ["babel", "oxc", "swc"];
  if (
    !compilers.every((compiler) => control?.summary[compiler]?.cacheEmitted === true) ||
    valid?.summary.swc?.cacheEmitted !== true ||
    !["babel", "oxc"].every(
      (compiler) =>
        valid?.summary[compiler]?.cacheEmitted === false &&
        valid?.summary[compiler]?.reason === "suppression-opt-out",
    ) ||
    ![invalidSuppressed, invalid].every((fixture) =>
      compilers.every((compiler) => fixture?.summary[compiler]?.cacheEmitted === false),
    )
  )
    return null;

  return {
    title: "SWC avoids a redundant-suppression bailout",
    summary:
      "With the tested versions, SWC memoizes the valid effect with an unnecessary hooks-lint suppression. Babel and OXC report a suppression opt-out and emit no memo cache.",
    validation:
      "All three emit no memo cache for the tested invalid conditional-hook examples, with or without suppression.",
    caveat:
      "This demonstrates broader optimization coverage, not proven redundancy detection or overall compiler correctness.",
    evidence: [
      { id: valid.id, label: "Valid hooks + redundant suppression" },
      { id: invalidSuppressed.id, label: "Invalid hooks + suppression" },
      { id: invalid.id, label: "Invalid hooks, no suppression" },
    ],
  };
}
