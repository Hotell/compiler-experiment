# React Compiler vs manual memoization

Three standalone React 19 + Vite 8 + TypeScript incident triage consoles compare Oxc's experimental Rust React Compiler, explicit `useMemo`/`useCallback`/`React.memo`, and an unoptimized baseline. All three show the same 200 deterministic incidents and use identical DOM, CSS, icons, state transitions, and provider boundaries. No backend or live data is required. Similar committed-update counts are a valid result, not a failed benchmark.

## Hosted comparison

The [chooser](https://hotell.github.io/compiler-experiment/) links to the [compiler-on](https://hotell.github.io/compiler-experiment/compiler/), [manually optimized](https://hotell.github.io/compiler-experiment/manual/), [unoptimized baseline](https://hotell.github.io/compiler-experiment/baseline/), and [latest successful benchmark report](https://hotell.github.io/compiler-experiment/report/) pages. On a commit/merge to the default branch, the `Benchmark` workflow runs first; **only a successful push-triggered run on that branch** starts the `Pages` workflow. Pages checks out the exact benchmarked commit, downloads that run's `compiler-comparison` artifact, and publishes the apps plus a styled report with flame charts and raw audits. A failed benchmark leaves the previous successful Pages deployment intact. GitHub Pages must use **GitHub Actions** as its build source.

To preview the chooser and report locally from the repository root:

```sh
yarn benchmark      # Rebuild and measure all three apps; skip if current results already exist
yarn build:pages    # Assemble dist-pages from those results
yarn preview:pages  # http://127.0.0.1:4180/compiler-experiment/
```

Keep the preview command running while browsing. The local report is labeled as a preview; CI deployments link to the successful benchmark run. `node scripts/check-pages.mjs` tests the same assembled site without leaving a server running. `dist-pages` and benchmark results are generated and ignored.

## Run locally

Requires Node >=22.12 and Corepack. From the repository root:

```sh
corepack enable
yarn install
yarn playwright install chromium
yarn workspace @experiment/compiler dev # http://127.0.0.1:5173
yarn workspace @experiment/manual dev   # http://127.0.0.1:5174
yarn workspace @experiment/baseline dev # http://127.0.0.1:5175
```

Start each app in its own terminal. Use `yarn fmt` to format authored files and `yarn fmt:check` for the non-writing format gate. `yarn benchmark` runs the format check, Oxlint, negative React immutability fixture, TypeScript, normal builds, compiler-output assertion, profile builds, Chromium parity/profiler tests, normal-build 4x CPU tests, three mobile Lighthouse audits per app, and report validation. Reports are written to ignored `benchmark/results/comparison.json` and `benchmark/results/comparison.md`, with linked SVG flame charts, raw CPU profiles, and Lighthouse audits in the same directory. `yarn benchmark:trace` additionally captures an unthrottled `.cpuprofile` for the favorite interaction in each app's first _React profiling_ run. Open CPU profiles in Chrome DevTools Performance or JavaScript Profiler; CDP samples are separate diagnostics, not React update counts.

## Architecture

All three apps nest `WorkspaceProvider` (queue), `IncidentProvider` (immutable updates), `FilterProvider` (search/status/sort), `SelectionProvider` (selected ID), and `ReviewProvider` (header counter). Incident and selection action contexts are separate from their data contexts, so unchanged rows do not subscribe to changing incident/selection data. The sidebar drills the active queue and selection action through `Sidebar` > `QueueNavigation` > `QueueItem` > `QueueIcon`, with a separate `SidebarFooter`; all queue icons use Lucide. The manual app memoizes queue items, provider values, callbacks, derived filtering, rows, and their open/favorite button components, while the compiler app uses no manual memo hooks. The repeated buttons receive named callbacks: manual stabilizes the callbacks with `useCallback`, while compiler and baseline leave them un-memoized. This makes callback identity meaningful across a component boundary without treating every inline DOM handler as a performance bug. Compiler and baseline import the same app and provider source; only the compiler's Vite plugin transforms it. The manual app keeps its explicit memoization boundaries. All three use the same un-memoized `Button`, `TextInput`, `Select`, and `StatusBadge` components, so new provider values and un-memoized rows expose the impact of omitting optimization without changing the workflow. No hook rules need inline lint suppression: baseline hooks follow the rules of hooks. Header-only reviews update the shell without updating rows. Queue, selection, favorite, resolution, search, status, and sort exercise the affected subtrees.

The compiler app opts in to `@vitejs/plugin-react`'s `compiler: { compilationMode: 'infer', logDiagnostics: true }` and pins compatible `oxc-transform-react`. Manual and baseline both use `react()` alone. Vite's ordinary Oxc TS/JSX transform runs for all three. This experimental integration is **not** the official Babel compiler; logged recoverable compiler diagnostics must be inspected, not silently treated as successful optimizations. Oxlint's opt-in React rules are explicit errors, an excluded invalid fixture proves the immutability guard fires, and normal production bundles are inspected for compiler cache transforms in toolbar, list, row, detail, and shell only on the compiler side. Normal bundles must not contain profile instrumentation.

## Measurement

Normal Vite manifests define initial-load JS entry chunks, static imports, and attached CSS, each file counted once. Reports include raw and gzip JS, CSS, total, compiler-minus-manual, and optimized-minus-baseline byte/percentage deltas; source maps, dynamic imports, and profile builds are excluded. Separately loaded chunks are listed if present. This is shipped application size, not installed package size or an exported-module fixture.

Profile mode is a production build with `react-dom/client` aliased to `react-dom/profiling`; it instruments the shell, list, detail, queue items, rows, and the repeated open/favorite buttons. Normal production builds omit that instrumentation and supply shipped bytes, UPLT, Lighthouse, and 4x CPU traces. Playwright runs one Chromium worker/browser; each app gets a fresh isolated context per run, one warm-up, then three repetitions alternating app order. Each action waits for visible state and a recorder update. Mounts are separate from updates. Whole-app commits group React `<Profiler>` callbacks by `commitTime`; nested subtree callback counts remain in JSON but do **not** count component invocations.

For row, queue and button component work, a test-only DevTools hook inspects React 19.3.0 profiling fibers: tag `12` identifies our `<Profiler>` boundary, its child is the component being measured, `alternate` excludes first mounts, and flags bit `1` marks performed work in that commit. None of these fields or bit values is a public React API. The pinned-version benchmark asserts compiler/manual/baseline differences after every build; revalidate this interpretation on each React upgrade. In particular, compiler row work can exceed manual memoized row work while their commit counts match. These counts are not additive, do not include aborted renders, and do not prove latency differences. `actualDuration` medians include profiling overhead and are advisory, not CI thresholds. Parity, row-edit sensitivity, header isolation, build/guard correctness, and nonzero measured bundle sizes are gates. Winning on size or updates is not.

UPLT (user-perceived load time) is measured on _normal_ builds as elapsed time from navigation start until all 200 rows have been rendered and two animation frames have elapsed, under a 4x CDP CPU throttle. It is a lab readiness proxy, not a Web Vital or guaranteed paint measurement. Three fresh contexts alternate app order; the median and each sample are reported. A separate normal-build selection workload warms each app, then times 20 incident open/close actions with 4x CPU slowdown from the browser click handler to the detail DOM update and two animation frames later; samples and p90 are reported without a CI speed threshold. CDP also samples post-GC renderer JS heap after the table is ready and after a favorite edit, outside the timed load and CPU-profile windows. This measures JS heap only, not total browser/DOM/native memory or leak growth. First-run CPU profiles for the favorite action use that same throttle and yield SVG flame charts; the sampled span includes browser/idle work and is **not** a React render duration. Lighthouse 12 runs three fresh mobile audits per app using its separate simulated throttling preset. FCP, LCP, TBT, Speed Index, CLS, interactive time, performance/accessibility scores and raw audit files are reported. Lighthouse simulations, CPU sampling, and three local runs cannot prove real-user gains. The evaluation weighs repeated selection latency, shipped bytes, the version-specific fiber diagnostic, and the experimental compiler's maintenance tradeoff; no noisy timing is a CI performance threshold.

GitHub Actions runs `yarn benchmark` for pushes and pull requests. Download the `compiler-comparison` artifact for both reports and linked flame charts, CPU profiles, and raw audits; failed runs also upload `playwright-diagnostics` when available.
