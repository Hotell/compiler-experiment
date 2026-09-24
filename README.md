# React Compiler vs manual memoization

Two standalone React 19 + Vite 8 + TypeScript incident triage consoles compare Oxc's experimental Rust React Compiler with explicit `useMemo`, `useCallback`, and `React.memo`. Both apps show the same 200 deterministic incidents and use identical DOM, CSS, icons, state transitions, and provider boundaries. No backend or live data is required. Similar committed-update counts are a valid result, not a failed benchmark.

## Hosted comparison

The [chooser](https://hotell.github.io/compiler-experiment/) links to the [compiler-on](https://hotell.github.io/compiler-experiment/compiler/) and [compiler-off](https://hotell.github.io/compiler-experiment/manual/) consoles. The `Pages` GitHub Actions workflow builds both apps with their repository subpaths, verifies navigation and previews at desktop/mobile widths, and deploys the `dist-pages` artifact on pushes to `main` or manual dispatch. GitHub Pages must use **GitHub Actions** as its build source. Run `yarn build:pages && node scripts/check-pages.mjs` to test the same artifact locally; `dist-pages` is generated and ignored.

## Run locally

Requires Node >=22.12 and Corepack. From the repository root:

```sh
corepack enable
yarn install
yarn playwright install chromium
yarn workspace @experiment/compiler dev # http://127.0.0.1:5173
yarn workspace @experiment/manual dev   # http://127.0.0.1:5174
```

Start each app in its own terminal. Use `yarn fmt` to format authored files and `yarn fmt:check` for the non-writing format gate. `yarn benchmark` runs the format check, Oxlint, negative React immutability fixture, TypeScript, normal builds, compiler-output assertion, profile builds, Chromium parity/profiler tests, normal-build 4x CPU tests, three mobile Lighthouse audits per app, and report validation. Reports are written to ignored `benchmark/results/comparison.json` and `benchmark/results/comparison.md`, with linked SVG flame charts, raw CPU profiles, and Lighthouse audits in the same directory. `yarn benchmark:trace` additionally captures an unthrottled `.cpuprofile` for the favorite interaction in each app's first _React profiling_ run. Open CPU profiles in Chrome DevTools Performance or JavaScript Profiler; CDP samples are separate diagnostics, not React update counts.

## Architecture

Both apps nest `WorkspaceProvider` (queue), `IncidentProvider` (immutable updates), `FilterProvider` (search/status/sort), `SelectionProvider` (selected ID), and `ReviewProvider` (header counter). Incident and selection action contexts are separate from their data contexts, so unchanged rows do not subscribe to changing incident/selection data. The compiler app uses no manual memo hooks; the manual app memoizes provider values, callbacks, derived filtering, and rows. Header-only reviews update the shell without updating rows. Queue, selection, favorite, resolution, search, status, and sort exercise the affected subtrees. The shared modules contain only fixed data, pure selectors, and presentation CSS; app components and providers remain separate.

The compiler app opts in to `@vitejs/plugin-react`'s `compiler: { compilationMode: 'infer', logDiagnostics: true }` and pins compatible `oxc-transform-react`. The manual app uses `react()` alone. Vite's ordinary Oxc TS/JSX transform runs for both. This experimental integration is **not** the official Babel compiler; logged recoverable compiler diagnostics must be inspected, not silently treated as successful optimizations. Oxlint's opt-in React rules are explicit errors, an excluded invalid fixture proves the immutability guard fires, and normal production bundles are inspected for compiler cache transforms in toolbar, list, row, detail, and shell only on the compiler side. Normal bundles must not contain profile instrumentation.

## Measurement

Normal Vite manifests define initial-load JS entry chunks, static imports, and attached CSS, each file counted once. Reports include raw and gzip JS, CSS, total, and compiler-minus-manual byte/percentage deltas; source maps, dynamic imports, and profile builds are excluded. Separately loaded chunks are listed if present. This is shipped application size, not installed package size or an exported-module fixture.

Profile mode aliases `react-dom/client` to `react-dom/profiling` and instruments the shell, list, detail, and rows. Playwright runs one Chromium worker/browser; each app gets a fresh isolated context per run, one warm-up, then three repetitions alternating app order. Each action waits for visible state and a recorder update. Mounts are separate from updates. Whole-app commits group callbacks by `commitTime`, while each subtree keeps its own update count; do not add nested profiler counts together. `actualDuration` medians include profiling overhead and are advisory, not CI thresholds or a substitute for function-call counts. Parity, row-edit sensitivity, header isolation, build/guard correctness, and nonzero measured bundle sizes are gates. Winning on size or updates is not.

UPLT (user-perceived load time) is measured on _normal_ builds as elapsed time from navigation start until all 200 rows have been rendered and two animation frames have elapsed, under a 4x CDP CPU throttle. It is a lab readiness proxy, not a Web Vital or guaranteed paint measurement. Three fresh contexts alternate app order; the median and each sample are reported. First-run CPU profiles for the favorite action use that same throttle and yield SVG flame charts; the sampled span includes browser/idle work and is **not** a React render duration. Lighthouse 12 runs three fresh mobile audits per app using its separate simulated throttling preset. FCP, LCP, TBT, Speed Index, CLS, interactive time, performance/accessibility scores and raw audit files are reported. Lighthouse simulations, CPU sampling, and three local runs cannot prove real-user gains. The evaluation weighs repeated committed-update counts, shipped bytes, load metrics, and the experimental compiler's maintenance tradeoff; no noisy timing is a CI performance threshold.

GitHub Actions runs `yarn benchmark` for pushes and pull requests. Download the `compiler-comparison` artifact for both reports and linked flame charts, CPU profiles, and raw audits; failed runs also upload `playwright-diagnostics` when available.
