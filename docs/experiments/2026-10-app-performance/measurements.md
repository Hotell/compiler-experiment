# Measurements and retention decisions

[Summary](README.md) | [Exact changes](candidates.md) | [Portable samples](evidence.json)

Display values here are rounded; decisions were computed from unrounded samples.
Positive reduction means faster; a negative reduction means slower:

```text
reductionPercent = 100 * (referenceMedian - candidateMedian) / referenceMedian
```

The requirement was candidate median <= 0.80 * its own reference median, repeated
across confirmation sessions. The stretch ceiling was <= 0.50.
Passing one endpoint or one session did not satisfy the full twelve-gate contract.

## Filtering cleanup: one complete candidate block

The original pinned reference and candidate used matching protocol/environment identities.
Columns show reference -> candidate median milliseconds, followed by reduction.

| Arm      | Load                     | Selection DOM         | AP DOM                  | Clear DOM              |
| -------- | ------------------------ | --------------------- | ----------------------- | ---------------------- |
| Baseline | 331.60 -> 322.45 (2.76%) | 6.60 -> 6.95 (-5.30%) | 16.80 -> 16.15 (3.87%)  | 22.75 -> 22.20 (2.42%) |
| Manual   | 332.15 -> 325.60 (1.97%) | 2.90 -> 2.90 (0.00%)  | 13.50 -> 13.50 (0.00%)  | 21.20 -> 19.90 (6.13%) |
| Compiler | 344.90 -> 338.60 (1.83%) | 3.35 -> 3.15 (5.97%)  | 13.05 -> 13.65 (-4.60%) | 21.35 -> 21.10 (1.17%) |

**Decision: reject.** No 20% gate passed. The small mixed single-block differences
were not a promising, consistently beneficial result warranting further confirmation.
The absence of repeated candidate sessions prevents a repeatability claim.

No >10% regression was detected by the comparator for the other captured guardrails.
Gzip changes were +57/+54/+38 bytes for baseline/manual/compiler, all below 0.1%.
Separate final retained-heap/row-ablation confirmation was not performed for this
rejected candidate. CSS candidates were **not timed**, rather than assigned 0% gains.

## Ownership extraction: three fresh paired blocks

Successful block order was:

1. `02`: candidate -> reference
2. `03`: reference -> candidate
3. `04`: candidate -> reference

Block `01` failed in a session-local configuration parser before measurement and was
not included. Each successful side launched fresh browser workloads with six balanced
loads, twenty warmed selection cycles, twenty warmed filtering cycles, and six isolated
load-memory trials per arm. Builds were served from separate immutable directories.

The table reports median reductions in block order against both the original pinned
reference and that block's fresh paired reference. **No row repeatably established
a 20% or 50% gate.** Some comparisons were inconclusive, not proven ineffective.

| Arm / endpoint         | Pinned reduction %: 02 / 03 / 04 | Paired reduction %: 02 / 03 / 04 |
| ---------------------- | -------------------------------- | -------------------------------- |
| Baseline load          | 18.85 / 11.85 / 16.10            | 2.20 / 1.68 / 13.87              |
| Baseline selection DOM | 21.97 / 17.42 / 22.73            | -6.19 / -2.83 / 19.05            |
| Baseline AP DOM        | 22.92 / 20.24 / 5.95             | 21.75 / 15.19 / 5.67             |
| Baseline clear DOM     | 20.00 / 24.40 / 10.77            | 13.74 / 15.89 / 13.98            |
| Manual load            | 19.16 / 12.61 / 14.83            | 1.83 / 2.40 / 13.35              |
| Manual selection DOM   | 20.69 / 17.24 / 3.45             | 6.12 / 4.00 / 5.08               |
| Manual AP DOM          | 17.04 / 15.19 / -1.11            | 14.50 / 11.58 / 0.73             |
| Manual clear DOM       | 21.23 / 15.33 / 7.78             | 15.66 / 4.52 / 5.56              |
| Compiler load          | 21.25 / 13.77 / 16.44            | 2.18 / 5.83 / 10.43              |
| Compiler selection DOM | 22.39 / 10.45 / 25.37            | 3.70 / -22.45 / 21.88            |
| Compiler AP DOM        | 14.18 / 10.73 / 1.15             | 12.50 / 3.32 / 4.44              |
| Compiler clear DOM     | 19.44 / 16.86 / 2.81             | 20.00 / 9.67 / -0.48             |

### Adverse guardrail signals

Positive worsening below denotes a regression. These endpoints exceeded 10% in
at least two of three blocks against both pinned and paired references.

| Endpoint                              | Paired worsening %: 02 / 03 / 04 | Pinned worsening %: 02 / 03 / 04 |
| ------------------------------------- | -------------------------------- | -------------------------------- |
| Manual API frame-opportunity median   | 56.86 / 16.40 / -0.00            | 48.15 / 35.80 / -0.62            |
| Compiler API frame-opportunity median | 34.09 / 13.61 / -15.31           | 57.33 / 28.00 / 10.67            |
| Compiler clear-frame p90              | -18.86 / 34.71 / 25.44           | -24.75 / 12.08 / 24.95           |

The recovery in block 04 is retained, not replaced with favorable samples.
Frame endpoints are two-rAF opportunities, not measured paint or INP. These signals
violated the experiment's conservative retention policy; they do not isolate a
unique application-caused regression amid host drift.

No repeated >10% load/selection/retained-heap/gzip regression against both references
was detected. Gzip candidate-minus-reference changes were +10/+17/-10 bytes.
Heap evidence remains in the external archive, not the portable timing extract.

### Reference drift

The unchanged paired-reference load medians were:

| Arm      | Block 02 ms | Block 03 ms | Block 04 ms |
| -------- | ----------: | ----------: | ----------: |
| Baseline |      275.15 |      297.30 |      323.00 |
| Manual   |      273.50 |      297.40 |      326.50 |
| Compiler |      277.65 |      315.80 |      321.75 |

For example, compiler load's first-block 21.25% pinned improvement was only 2.18%
against its paired reference. The reference itself was about 19.50% faster than
the old pin. Pinned-only gains could not be credited to the ownership refactor.

**Decision: reject and restore application sources and runnable builds.**
Baseline clear-DOM's repeated 13.74-15.89% screening gain was below target and did
not justify retaining the entire intervention in the presence of adverse guardrails.
No costly full Lighthouse/final row-memo timing confirmation was run after rejection.

## Latest baseline, not an improvement claim

A separate reference was captured after correcting descriptive warm-up metadata.
Application source and all six normal/profile builds matched the original reference.
The [stability record](stability.md) contains its four-session primary medians.
It was not a new optimized candidate or a retroactive replacement for old comparisons.
