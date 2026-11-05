# React Compiler Repros

Paired TypeScript inputs comparing Babel React Compiler, OXC, and native SWC, with React Compiler Analyzer (RCA) as an analysis cross-check. This harness is independent of the apps and performance benchmarks.

[Hosted report](https://hotell.github.io/compiler-experiment/compiler-repros/) includes generated code, diagnostics, source snapshots, and all three compiler-pair diffs.

## Run

Use the repository's Node version (22.18+ on Node 22, or 24.11+ on Node 24) and installed Yarn dependencies. From the repository root:

```sh
yarn repro:compilers
yarn check:compiler-repros
yarn build:compiler-repros
```

- `repro:compilers`: generate the offline [HTML](results/index.html), [Markdown](results/comparison.md), and [JSON](results/comparison.json) reports under ignored `results/`. No server or browser is needed.
- `check:compiler-repros`: harness lint, fixture types, unit tests, desktop/mobile browser tests, public build, and Pages-route HTTP checks. Install Chromium once with `yarn playwright install chromium`.
- `build:compiler-repros`: regenerate sanitized public evidence under `dist-pages/compiler-repros/`, without app builds or benchmarks. The normal Pages pipeline publishes it; a local build does not deploy.

Tool failures and broken compilation/opt-out guards fail the run. Differences between compilers are report data, not failures.

## Cases

Every repro uses `<case>.tsx` and its paired `<case>-control.tsx`. A control is a comparison baseline, not necessarily valid React or an input every compiler optimizes. Categories describe the subject, independently of current outcomes.

### Guards

Basic compilation and explicit opt-out handling. One pair.

| Repro                                      | Control                                                    | Difference                                                          |
| ------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| [module-opt-out](cases/module-opt-out.tsx) | [module-opt-out-control](cases/module-opt-out-control.tsx) | Module-level `"use no memo"` versus a positively compiled component |

### Suppressions & Hooks

Suppression policy versus actual hook violations. Four pairs.

| Repro                                                                            | Control                                                                                          | Difference                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| [module-suppression](cases/module-suppression.tsx)                               | [module-suppression-control](cases/module-suppression-control.tsx)                               | Module ESLint suppression added; `One` retains its local opt-out, while the target is sibling `Two` |
| [module-suppression-no-opt-out](cases/module-suppression-no-opt-out.tsx)         | [module-suppression-no-opt-out-control](cases/module-suppression-no-opt-out-control.tsx)         | Same module-comment comparison without a local opt-out                                              |
| [valid-hooks-redundant-suppression](cases/valid-hooks-redundant-suppression.tsx) | [valid-hooks-redundant-suppression-control](cases/valid-hooks-redundant-suppression-control.tsx) | Redundant `exhaustive-deps` suppression on a valid effect                                           |
| [invalid-hooks-with-suppression](cases/invalid-hooks-with-suppression.tsx)       | [invalid-hooks-with-suppression-control](cases/invalid-hooks-with-suppression-control.tsx)       | Conditional effect with versus without suppression; both violate hook ordering                      |

### Components & Scope

Component definition and function placement. Two pairs.

| Repro                                                    | Control                                                                  | Difference                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [inline-component](cases/inline-component.tsx)           | [inline-component-control](cases/inline-component-control.tsx)           | Hook-calling component defined during parent render versus module scope    |
| [hoisting-after-return](cases/hoisting-after-return.tsx) | [hoisting-after-return-control](cases/hoisting-after-return-control.tsx) | Captured function declaration after versus before the return that calls it |

Inline components are flagged by `react/static-components`; the compiler can also report a nested-hook error. These are validation observations, not proof of cache divergence. Post-return function declarations are valid JavaScript.

### Syntax Support

Computed properties, imports, control flow, and assignments. Ten pairs. Babel `Todo` lowering gaps are distinct from its `unsupported-syntax` lint category; a category name does not assert a current bailout.

| Repro                                                                      | Control                                                                                    | Difference                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [computed-template-key-mutation](cases/computed-template-key-mutation.tsx) | [computed-template-key-mutation-control](cases/computed-template-key-mutation-control.tsx) | Template versus member keys in a hook-shaped style mutation                                  |
| [computed-template-key](cases/computed-template-key.tsx)                   | [computed-template-key-control](cases/computed-template-key-control.tsx)                   | Same key comparison in a mutation-free component, isolating lowering from mutation/discovery |
| [dynamic-import](cases/dynamic-import.tsx)                                 | [dynamic-import-control](cases/dynamic-import-control.tsx)                                 | `import()` in an effect versus static import wrapped in `Promise.resolve`                    |
| [try-catch-finally](cases/try-catch-finally.tsx)                           | [try-catch-finally-control](cases/try-catch-finally-control.tsx)                           | `finally` versus resetting state after `try/catch`                                           |
| [try-finally-no-catch](cases/try-finally-no-catch.tsx)                     | [try-finally-no-catch-control](cases/try-finally-no-catch-control.tsx)                     | `try/finally` versus reset-and-rethrow in `catch`                                            |
| [throw-in-try](cases/throw-in-try.tsx)                                     | [throw-in-try-control](cases/throw-in-try-control.tsx)                                     | Throw inside `try` versus early return before it                                             |
| [value-block-in-try](cases/value-block-in-try.tsx)                         | [value-block-in-try-control](cases/value-block-in-try-control.tsx)                         | Optional chaining and `??` inside `try` versus computing the value beforehand                |
| [logical-test-block](cases/logical-test-block.tsx)                         | [logical-test-block-control](cases/logical-test-block-control.tsx)                         | Call containing `&&` arguments wrapped in `\|\| undefined` versus no wrapper                 |
| [nullish-assignment](cases/nullish-assignment.tsx)                         | [nullish-assignment-control](cases/nullish-assignment-control.tsx)                         | `x ??= fallback` versus `x = x ?? fallback`                                                  |
| [captured-update-expression](cases/captured-update-expression.tsx)         | [captured-update-expression-control](cases/captured-update-expression-control.tsx)         | Captured `attempts++` versus `attempts = attempts + 1`                                       |

## Evidence

- Direct transforms use identical inputs, `infer` mode, React 19 target, and `panicThreshold: "none"`. Exact versions and options are recorded in the report, not maintained here.
- Direct Babel uses the pinned experimental compiler; RCA retains its declared stable compiler. Analysis mismatches across versions are not automatically analyzer failures, and RCA memo statistics do not prove emitted caching.
- **Differences**, the default filter, means emitted cache or slot differences. **Diagnostics** includes reported diagnostics even when caches agree. Missing diagnostics, especially from SWC, do not prove optimization or acceptance.
- `not-discovered` is not validation success. Hook-shaped inputs can remain undiscovered; their component pairs independently test syntax.
- A bailout leaves application code in the output; it does not repair invalid React. Cache emission and raw code diffs establish neither runtime correctness nor performance.

## Add a Case

1. Add a small typed repro and paired control under `cases/`, isolating the investigated trigger.
2. Register both in `cases` in [run.mjs](run.mjs): matching filename/ID, existing group, and one unambiguous target per file. Set the repro's `control` to `<case>-control`; map any new group in `caseCategories`.
3. Add the pair to the appropriate table above, format the changed files, and run `yarn check:compiler-repros` plus `yarn repro:compilers`. Intentional bailout fixtures are excluded from harness linting.

For dependency upgrades and same-source before/after comparisons, use [compiler-upgrade-report](../.agents/skills/compiler-upgrade-report/SKILL.md). The repro runner uses root pins, not the Vite app's separately pinned compiler.
