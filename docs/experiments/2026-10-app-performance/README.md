# Application performance investigation, October 2026

**Outcome: no application optimization retained; the performance target was not achieved.**

Investigated the baseline, manual-memo and compiler-memo variants on October 6-7, 2026,
starting from commit `4ca9501` (`Make workspace controls functional across comparison apps`).
The goal was at least 20% lower median latency on four endpoints in **each** variant:
full-table load, selection-to-detail DOM readiness, typed AP result-DOM readiness and
clear-query result-DOM readiness. This is twelve independent gates; 50% was a stretch goal.

Two candidates were timed. Two CSS prototypes stopped at presentation checks.
All candidate application changes were removed. None established a repeatable pass for
all twelve gates; the timed ownership candidate established **0/12** 20% gates and
**0/12** stretch gates across three paired sessions.

This documentation-only change also discards the experiment's uncommitted benchmark-tooling,
configuration, CI and root-documentation edits. The candidate diffs below are historical,
not changes to apply automatically.

## Read the record

- [Exact tested diffs and behavior changes](candidates.md)
- [Measurements and retention decisions](measurements.md)
- [Protocol, validation and evidence scope](methodology.md)
- [Timing instability and next-step boundary](stability.md)
- [Portable measurement extract](evidence.json): unrounded samples, run orders, summary
  statistics, source hashes and identities from twelve recorded timing invocations

| Candidate              | Intervention                                           | Evidence collected                                | Decision                                                 |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------- |
| Filtering cleanup      | Loop, short-circuit search matching and severity ranks | One complete candidate benchmark                  | Reject: small, mixed observations                        |
| Intrinsic button width | `.row-open { width: max-content; }`                    | Built presentation/DOM/lifetime checks            | Reject: equivalence inconclusive; not timed              |
| Layout containment     | Inject `.table-scroll { contain: layout; }`            | Browser layout/overflow preflight                 | Reject: changed overflow ownership; not timed            |
| Render ownership       | Extract `IncidentContent` from `Shell`                 | UI/profiler parity and three paired timing blocks | Reject: gates not established; adverse guardrail signals |

## What did not change

The experiments preserved 200 deterministic incidents, synchronous filtering and
the `A -> AP -> API -> clear` sequence with `200 / 34 / 34 / 200` results.
Clear-query still remounted 166 rows. No virtualization, pagination, debounce,
deferred rendering, hidden retained rows, direct DOM state updates or reduced
workload was used.

Shared baseline/compiler source remained free of manual memoization. Manual retained
its explicit memo strategy and row-memo ON/OFF intervention. Compiler remained Oxc `infer`.
Provider behavior, activity history, notification/settings/operations workflows and
profiling boundaries were not removed to produce favorable results.

## Evidence limitations

The host was not a dedicated benchmark machine. Selection session medians varied at a
scale greater than the 20% target, and frame opportunities were scheduling-sensitive.
No single cause of the variation was established.

The [portable extract](evidence.json) supports recomputing the documented timing medians,
p90 and reductions without a local session directory. It is **not** a full publishable
benchmark report or a substitute for the complete original artifacts. Large builds,
traces, screenshots, CPU profiles, full Lighthouse/heap reports, command logs and
machine-specific process data remain outside the repository.

Raw samples from different provenance generations must not be silently combined.
See [metadata compatibility](methodology.md#metadata-generations).
