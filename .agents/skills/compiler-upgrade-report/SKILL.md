---
name: compiler-upgrade-report
description: "Upgrade the complete Babel, OXC, SWC, React Compiler Analyzer, and formatter comparison toolchain and compare before/after bailout reports. Use when refreshing compiler dependencies, updating oxc-transform-react, oxfmt, SWC, Babel, or the analyzer, or checking changed memoization, diagnostics, and code generation."
argument-hint: "Default: upgrade the complete comparison toolchain; optional explicit constraints"
---

# Compiler Upgrade and Report Comparison

Upgrade the entire comparison toolchain by default, preserve a same-source baseline, compare measured results, and rebuild the public report. Run from the repository root with its supported Node version and Yarn. Do not commit or push unless explicitly requested.

## Default Upgrade Set

Always discover and upgrade all six direct dependencies to their latest published stable versions, retaining exact pins:

| Package                             | Role                                |
| ----------------------------------- | ----------------------------------- |
| `@babel/core`                       | Direct Babel transform host         |
| `babel-plugin-react-compiler`       | Babel React Compiler                |
| `oxc-transform-react`               | Native OXC React Compiler           |
| `@swc/core`                         | Native SWC React Compiler           |
| `@fluentui/react-compiler-analyzer` | Analyzer / noEmit Babel cross-check |
| `oxfmt`                             | Repository formatter                |

Mentioning OXC or the formatter must not silently exclude Babel, SWC, or the analyzer. Narrow this set only when the user explicitly requests an "only these packages" upgrade. Packages already at their latest version stay unchanged, but must still be checked and reported. Do not fabricate version bumps when no newer release exists.

## Preserve the Baseline

1. Inspect `git status --short`, package manifests, and the current compiler report. Preserve unrelated changes. Determine whether an earlier commit/push is still pending; do not silently publish it during an upgrade.
2. Discover current installed versions and requested package pins. Query the registry, do not hardcode a future "latest":

   ```sh
   node .agents/skills/compiler-upgrade-report/scripts/compare-reports.mjs latest
   yarn oxfmt --version
   ```

   The helper's exported `comparisonPackages` list is the canonical complete set; its registry query fails if any package is missing from the response. Check runtime engines and dependency constraints for new majors rather than silently skipping a comparison arm.

3. Use the [comparison helper](./scripts/compare-reports.mjs) to capture a fresh baseline before installing or formatting anything:

   ```sh
   node .agents/skills/compiler-upgrade-report/scripts/compare-reports.mjs capture tmp/compiler-upgrade-before
   ```

   Use fresh output names if those directories already contain evidence worth retaining. Generated evidence must remain ignored; do not commit raw local paths or generated reports. Formatter versions are recorded separately from the compiler report's package provenance.

## Upgrade Conservatively

1. Pin exact latest published versions for the full default set, update the Yarn lockfile, and install. Reuse current dependency locations. Vite, React, TypeScript, Playwright, and application packages are not automatically part of this set. If a new compiler host raises the supported Node minimum, update the root engine constraint and setup documentation, and verify CI's configured Node line can satisfy it.
2. Inspect every producer/consumer: this repository can have a root compiler for repros and a separately pinned `apps/compiler` dependency for Vite. Report both when they differ. Check peer warnings with `yarn explain peer-requirements`; do not suppress or claim compatibility without evidence. Resolve an in-scope conflict or explicitly report the remaining constraint and validate the app build.
3. Preserve original fixture bytes and compiler flags while comparing. Do not reformat fixtures before recording the first after snapshot. If formatter changes inputs, recapture both sides using a controlled run or report that the upgrade effect cannot be isolated.
4. Check the installed compiler API for changed defaults. OXC 0.155 requires `reactCompiler.reportDiagnostics: true` to retain recoverable diagnostics. Empty diagnostic arrays are not proof that a former bailout compiled. Enabling reporting must not disable validation or force compilation; record the option change.
5. Respect each package's transitive dependency ranges. The latest direct Babel host can differ from the Babel host required by the latest analyzer. Do not force the analyzer onto an unsupported major with resolutions. Record both resolved versions/paths, preserve the version warning, and verify their actual analysis alignment. Babel 8 requires Node 22.18+ or 24.11+ on this repository's supported Node lines.

## Measure and Interpret

```sh
node .agents/skills/compiler-upgrade-report/scripts/compare-reports.mjs capture tmp/compiler-upgrade-after
node .agents/skills/compiler-upgrade-report/scripts/compare-reports.mjs compare tmp/compiler-upgrade-before/comparison.json tmp/compiler-upgrade-after/comparison.json tmp/compiler-upgrade-delta
```

Read `upgrade-delta.md` and the detailed `upgrade-delta.json` in the output directory.

- The helper joins fixture IDs and refuses a comparable verdict for added, removed, or changed source hashes/targets, duplicate/incomplete inputs, or failed runs. Do not describe changed fixtures as compiler regressions.
- Review outcome/cache/slot changes separately from diagnostic severity/content, explicit codeframe rendering, option changes, and emitted-code changes. Workspace path differences are normalized. Inspect exact changed fields before summarizing.
- A warning changing to an error is a diagnostic change even if output is identical. Recoverable compiler diagnostics with `panicThreshold: "none"` do not necessarily fail the transform.
- Preserve smoke and module-level opt-out guards. Logger acceptance, missing diagnostics, and emitted memoization are separate facts. Native OXC/SWC do not expose the same per-function success telemetry as Babel.
- RCA must use its installed version and compare with the separate noEmit Babel pass. A compiler upgrade does not authorize `--annotate`, lint fixes, changing `infer` to `all`, or weakening validation to restore a desired result.
- Investigation-case disagreements are report data, not assumptions to freeze into tests. If an evidence-gated finding disappears after a legitimate compiler change, update outcome-dependent tests to follow the measured evidence; keep the underlying emission/validity guardrails.

## Verify and Publish Locally

```sh
yarn install --immutable
yarn check:compiler-repros
yarn repro:compilers
yarn lint
yarn typecheck
yarn build
```

The focused check covers unit tests, fixture types, browser behavior on desktop/mobile, public sanitization, report generation, and the Pages-prefixed HTTP route. App build/type checks matter when changing compiler or plugin dependencies shared with Vite.

Check authored formatting with the newly installed formatter. Format only in-scope files; leave unrelated user plans untouched. Recheck source hashes after any fixture formatting. The full benchmark/Pages pipeline requires fresh provenance after dependency changes; do not reuse old timing reports or claim a remote deployment.

The existing commands regenerate ignored `compiler-repros/results/index.html` and sanitized `dist-pages/compiler-repros/index.html`. Keep explanatory findings evidence-gated rather than hardcoding an old compiler ranking.

## Completion

Report checked versions for all six packages, including packages already current, old/new exact pins, changed fixture outcomes and diagnostics, whether code/cache output changed, validation results, runtime/peer constraints and analyzer host-version splits, and links to the local report/delta. State whether any earlier commit remains unpushed. Do not commit/push the upgrade or publish GitHub Pages without authorization for that scope.
