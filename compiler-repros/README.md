# Babel / OXC / SWC React Compiler Repros

Minimal paired inputs for comparing `babel-plugin-react-compiler`, `oxc-transform-react`, and the native React Compiler in `@swc/core`, with the installed `@fluentui/react-compiler-analyzer` (RCA) as a Babel-analysis cross-check. This folder uses the root dependencies and does not modify the app compiler configuration or benchmark pipeline.

## Run

From the repository root, using the repository's supported Node version:

```sh
yarn install
yarn repro:compilers
yarn test:compiler-repros
yarn typecheck:compiler-repros
yarn lint:compiler-repros
yarn check:compiler-repros
```

The runner can also be invoked by absolute path from another directory. Its input and output paths are resolved from the script, not the caller's working directory. It does not require a browser, app build, or dev server.

Results go to ignored `compiler-repros/results/`. Open `index.html` directly for the interactive report, or inspect `comparison.md` and `comparison.json`. The HTML is self-contained, works offline, and includes fixture search, outcome filtering, compiler output, input, diffs, diagnostics, and control links. The inspector can compare Babel/OXC, Babel/SWC, or OXC/SWC; changing the pair updates its outputs, diagnostics, and diff download together. The command fails for fatal transforms, malformed/failed RCA output, unparseable inputs, or broken smoke/opt-out guards. Differences between compiler implementations are findings, not command failures.

`yarn check:compiler-repros` runs lint, fixture type-checks, unit tests, desktop/mobile Chromium tests, the public report build, and an HTTP check under the GitHub Pages base path. Install Chromium first with `yarn playwright install chromium`. Browser screenshots are saved under the ignored results folder.

The HTML and Markdown reports include a **Key finding** about redundant hook suppressions only when the current results support it: the valid control compiles under all three arms, SWC emits a cache for its suppressed variant while Babel/OXC report suppression opt-outs, and all three emit no cache for both invalid-hook variants. Incomplete or changed evidence omits the finding rather than repeating a stale conclusion. Its caveat distinguishes broader optimization coverage from proven redundancy detection or overall correctness.

The finding's HTML evidence links reveal the supporting fixture through active filters/search and open the Babel/SWC comparison. **Suppression opt-out** labels are derived from reported diagnostics; raw compiler events, status values, messages, and code frames remain available unchanged in the evidence artifacts.

## Published Report

The deployed route is [Compiler compatibility](https://hotell.github.io/compiler-experiment/compiler-repros/), linked from the main chooser as **Compiler repros**. It becomes available after the next successful Pages deployment of these changes; generating it locally does not publish it.

Pages assembly runs the compilers again and publishes a fresh report plus evidence files to `dist-pages/compiler-repros/`. A failing compiler harness stops publication. Public HTML, JSON, source snapshots, diffs, and diagnostic artifacts use generic fixture names and repository-relative paths; machine-local workspace and executable paths are removed. Raw local comparison JSON retains its diagnostic provenance, but is sanitized before publication.

Run `yarn build:compiler-repros` to regenerate only that deployable folder without rebuilding apps or rerunning performance benchmarks. The full `yarn build:pages` includes it automatically; `yarn check:pages` also exercises navigation from the chooser to the report on desktop and mobile.

## Cases

Each pair preserves the target function name and changes the investigated trigger only. All inputs are standalone TypeScript; none imports the original application's dependencies.

| Repro                               | Control                                | Investigated difference                                                                                                                 |
| ----------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `valid-hooks-redundant-suppression` | `valid-hooks-no-suppression`           | Redundant `// eslint-disable-next-line react-hooks/exhaustive-deps` pragma before a valid effect with complete dependencies             |
| `invalid-hooks-with-suppression`    | `invalid-hooks-no-suppression`         | Conditional effect with versus without `// eslint-disable-next-line react-hooks/rules-of-hooks`; both have complete effect dependencies |
| `inline-component`                  | `module-component-control`             | Hook-calling arrow component defined inside the parent versus at module scope                                                           |
| `hoisting-after-return`             | `hoisting-before-return-control`       | Captured function declaration after versus before the return that calls it                                                              |
| `computed-template-key-mutation`    | `computed-member-key-mutation-control` | Original hook-shaped assignment to `state.root.style`, with interpolated template keys versus direct string-valued member keys          |
| `computed-template-key`             | `computed-member-key-control`          | Same key expressions in a mutation-free component, isolating HIR lowering from mutation validation and hook discovery                   |
| `module-opt-out`                    | `smoke`                                | Module-level `"use no memo"` directive versus a positively compiled component                                                           |

The computed-key constants are strings, so ``[`${styleKeys.color}`]`` and `[styleKeys.color]` describe the same property. The source-faithful hook is intentionally not given extra hooks, JSX, or forced compilation directives. If `infer` does not discover it, the report retains that outcome; the mutation-free pair independently exercises the syntax. All fixture names, types, and CSS variables are generic public examples.

Function declarations after `return` are valid JavaScript, regardless of compiler support. Defining a component during render is not recommended: compilation acceptance does not guarantee stable identity or state preservation.

### Hook Validity and Suppressions

These fixtures separate comment-based opt-out policy from detection of an actual Rules of Hooks violation:

1. **Valid hooks, redundant suppression:** `valid-hooks-redundant-suppression` uses an unconditional effect with complete dependencies and a redundant `react-hooks/exhaustive-deps` suppression. Its unsuppressed valid control is `valid-hooks-no-suppression`.
2. **Invalid hooks, suppression present:** `invalid-hooks-with-suppression` calls `useEffect` inside `if (enabled)` and suppresses `react-hooks/rules-of-hooks` on that call.
3. **Invalid hooks, no suppression:** `invalid-hooks-no-suppression` is identical to the previous input except for removing the comment. Changing `enabled` can change the hook order, so the source is invalid regardless of its complete dependency array.

In the valid example, the hook rules are green. The suppression comment is syntactically valid but unnecessary, not evidence of an invalid hook. ESLint can report that comment as unused when unused-disable reporting is enabled.

The pinned compiler versions produce the following memo-cache evidence:

| Scenario                                 | Babel cache | OXC cache | SWC cache |
| ---------------------------------------- | ----------- | --------- | --------- |
| Valid hooks + redundant suppression      | No          | No        | Yes       |
| Invalid conditional hook + suppression   | No          | No        | No        |
| Invalid conditional hook, no suppression | No          | No        | No        |

Babel/OXC report the suppression as the reason in the suppressed inputs, and a conditional-hook violation in the unsuppressed invalid input. SWC reports no diagnostic for either invalid variant, but emits no memo cache. Therefore this pair does not demonstrate SWC optimizing an invalid conditional hook; it distinguishes a suppression-policy difference from a diagnostic gap. The unsuppressed invalid fixture is also independently rejected by the repository's `react/rules-of-hooks` linter.

All compiler arms use `panicThreshold: "none"`: an optimization bailout can still leave the invalid application code in the transformed output. No memo cache does not repair a hook violation or make the file safe to ship; hooks linting remains necessary.

## Reading the Evidence

- All three direct compilers receive the same filename and source bytes, `compilationMode: "infer"`, `target: "19"`, `panicThreshold: "none"`, and their compiler-specific default suppression behavior. No extra validation-disabling options are used. The exact options are recorded rather than assuming all implementation defaults are identical.
- Babel's parser enables TS/JSX and emits them unchanged apart from compiler transformations. OXC and SWC strip TypeScript, with JSX preserved. SWC uses `swcrc: false`, `configFile: false`, and `jsc.target: "esnext"` to avoid external configuration and unrelated downlevel transforms. Raw diffs include TS erasure and formatting differences; they do not establish semantic equivalence.
- Babel events report acceptance, skip, or error. The cache columns independently inspect emitted `react/compiler-runtime` cache calls, resolving imported bindings and enclosing functions. A child function's cache is not credited to its parent. Unknown ownership is not treated as an emitted cache.
- OXC and SWC expose diagnostics and code, but no per-function success logger in these APIs. Their reported status is `unavailable`; their cache evidence and raw diagnostics are still recorded. SWC can return an empty diagnostic array for functions left unoptimized. No cache without a diagnostic is not automatically a bailout, and differing diagnostic telemetry does not establish different acceptance.
- The matrix includes all three cache results. Its summary counts fixtures with cache or slot differences across any compiler pair; a separate row label identifies diagnostic-only differences. **Differences** is selected by default and includes only cache/slot differences. **Diagnostics** includes any fixture with a compiler diagnostic, even when all compilers emit the same cache result. Codegen-format differences alone are not counted as cache differences. The header shows only the fixture count and compiler cache differences; RCA analysis remains available in the table and raw evidence.
- RCA runs the Babel compiler with `noEmit: true`. The runner compares RCA to a separate analysis-only Babel pass, matching records by filename, function name, and source location. RCA's reported memo slots are not direct emitted-code evidence. In particular, the module-level opt-out guard can produce a success event and memo statistics without emitting a cache.
- `not-discovered` means there was no matching Babel/RCA event. It does not mean the function passed validation or was explicitly rejected. Missing or additional analyzer records remain available in the JSON.
- Installed versions, requested versions, module resolution paths (including RCA's own compiler), options, Node/platform, and input SHA-256 hashes are recorded. Version/resolution mismatches are warnings. Different release lines can have different defaults or supported features, so a discrepancy is not automatically an OXC bug.

This is a compile-time comparison, not runtime correctness, performance, or optimization-value evidence.

## Artifacts

For each fixture, the output includes:

- `.source.tsx`: exact input snapshot.
- `.babel.tsx`, `.oxc.jsx`, and `.swc.jsx`: raw emitted code.
- `.babel.json`, `.babel-analysis.json`, `.oxc.json`, and `.swc.json`: options, structured diagnostics, observations, and per-function cache evidence.
- `.diff`, `.babel-swc.diff`, and `.oxc-swc.diff`: unified diffs for all three compiler pairs.

The folder also contains RCA's raw `analyzer.json` and `analyzer.stderr.txt`, plus `index.html`, `comparison.json`, and `comparison.md`. The JSON preserves the analyzer invocation, exit code, diagnostics, and all function records. Native diagnostic labels retain their original byte offsets and code frames; Babel locations use one-based lines and zero-based columns.

## Native SWC / Rspack

SWC has a native React Compiler transform in [`@swc/core` v1.15.43+](https://swc.rs/docs/configuration/react-compiler). It is enabled through `jsc.transform.reactCompiler` in the normal `transform` / `transformSync` APIs. This is distinct from SWC's ordinary JSX transform under `jsc.transform.react`.

[Rspack v2.1+](https://rspack.rs/guide/integrations/react#react-compiler) exposes the native compiler through the same `jsc.transform.reactCompiler` option in `builtin:swc-loader`. A Rspack bundle is not required to add a direct SWC comparison arm.

The comparison pins `@swc/core` to **1.16.20** and runs its native `transformSync` directly on each original TSX input. SWC uses the same real-emission smoke and module-level opt-out guards as Babel and OXC. Its exact version, options, generated code, native diagnostic strings, and cache evidence are included in the report.

With this pinned version, SWC emits a cache for the template-literal computed-key component, like OXC and unlike Babel. SWC also emits a cache for the `eslint-disable-next-line react-hooks/exhaustive-deps` fixture, whereas Babel and OXC opt out. These are measured compile-time differences, not claims about runtime correctness or a performance ranking. The generated report is the source of truth for the installed versions.

## Adding a Case

Add a small typed input and a single-variable control under `cases/`, then register both in the exported `cases` array in [run.mjs](run.mjs). Assign each a unique ID, group, and target function name; set the repro's `control` to its control ID. Keep one unambiguous target per file. Include a discoverable component pair when a source-faithful hook might not be discovered under `infer`.

Run the test, fixture type-check, lint, format, and comparison commands after adding a case. The intentional compiler-bailout inputs are not part of app linting; the standalone lint command checks only the harness scripts. Generated outputs are excluded from formatting and version control.
