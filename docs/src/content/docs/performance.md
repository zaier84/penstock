---
title: Performance
description: Measured orchestration overhead — roughly 4 microseconds per step — with the raw numbers, the method, and an honest account of what they do and do not mean.
---

penstock adds about **4 microseconds per step** of orchestration overhead on the
machine below. This page exists to show the abstraction is cheap, **not to claim
speed as a feature**. Nothing here is a throughput number for your application.

## What is measured

Every step body does no real work — an immediately resolved promise. What is
timed is the machinery around a step, never the step itself. A pipeline whose
steps call a database is bounded by the database, and no number on this page
tells you anything about that.

The suite benchmarks `dist/index.js`, the built ESM output an npm consumer
loads, using [tinybench](https://github.com/tinylibs/tinybench). It lives in
`bench/` with its own `package.json`, so tinybench never enters the library's
dependency tree.

```sh
npm run build          # at the repository root
cd bench && npm install && npm run bench
```

It prints the table below and writes `bench/results.json`.

## The environment

| | |
| --- | --- |
| Node | v22.22.3 (V8 12.4.254.21-node.56) |
| OS | win32 10.0.26200 (x64) |
| CPU | Intel Core i7-10810U @ 1.10GHz, 12 logical cores |
| Memory | 32 GB |
| Date | 2026-08-20 |

**This is a mobile laptop CPU with a 1.1 GHz base clock, running Windows with
other things going on.** A server-class machine will produce lower numbers.
Treat the ratios as more portable than the absolute figures.

## The numbers

Each scenario runs its unit of work 20 times per timed iteration, uniformly, and
the reported latency is divided by 20. That is not tuning: it applies to every
row including the baseline, and it exists because the sub-microsecond baseline
otherwise retains tens of millions of samples and exhausts the heap.

| # | Scenario | ops/sec | ns/op mean | ns/op p50 | ±rme |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Baseline: five plain sequential awaits | 1,851,860 | 540 | 430 | 1.05% |
| 2 | Typed builder: five sequential steps | 38,043 | 26,286 | 19,955 | 3.19% |
| 3 | Class API: five sequential steps | 45,125 | 22,161 | 15,750 | 5.16% |
| 4 | Five steps with `before`/`after` hooks | 27,636 | 36,185 | 21,425 | 8.40% |
| 5 | Parallel group of five | 23,704 | 42,188 | 28,990 | 14.23% |
| 6 | Parallel group of five, `concurrency: 2` | 22,570 | 44,307 | 31,435 | 3.69% |
| 7 | Five steps with `retry` configured, no failures | 34,357 | 29,106 | 19,500 | 4.21% |
| 8 | Five steps with a no-op `Tracer` | 13,188 | 75,829 | 21,795 | **111.33%** |
| 9 | Rollback: fifth step fails, four compensations run | 18,075 | 55,325 | 40,830 | 4.66% |
| 10 | `serializeResult` on a twenty-step `Result` | 1,278,897 | 782 | 370 | 4.53% |

`ops/sec` is derived from the mean, so the two columns describe one measurement.
tinybench also reports a `throughput.mean` that averages per-sample throughput;
for a right-skewed distribution that disagrees with `1 / mean`, and two columns
that contradict each other are worse than one.

## Read the median, not the mean

Look at row 8. Its **relative margin of error is 111%**, and its mean of
75,829 ns is more than three times its median of 21,795 ns. That row's mean is
not a measurement of anything.

Garbage collection is why. These scenarios allocate — a context, a `Result`,
five `StepReport`s, a UUID per run — so GC pauses land inside timed samples and
drag the mean around. Running the suite four times:

- **Medians moved by about 5%.** Row 2's p50 across four runs: 20,185 / 20,140 /
  21,480 / 19,955 ns.
- **Means and margins did not settle.** Row 9's margin of error came out at 34%,
  104%, 88%, and 4.66% on four consecutive runs of identical code.

So the median is the number to read, and it was chosen for that reason rather
than because it is smaller. The mean and the margin stay in the table so you can
see the skew instead of taking my word for it.

## Per-step overhead

Scenario 2 minus scenario 1, divided by five, from the medians:

```text
per-step overhead, typed builder vs baseline : 3.905 us
per-step overhead, class API vs baseline     : 3.064 us
per-step cost of the builder facade itself   : 0.841 us
```

Across four runs that first figure came out at 3.953, 3.942, 4.208, and
3.905 µs. **Call it 4 µs per step.**

Two things follow that are worth stating plainly.

**The class API is faster than the typed builder**, by roughly 0.6–0.8 µs per
step. The builder wraps each `run` to merge its returned contribution onto the
context, and that wrapper plus the merge is the difference. If you are running
millions of pipelines and every microsecond counts, `toPipeline()` and the class
API are measurably cheaper. For everyone else the accumulated types are worth
more than 0.8 µs.

**4 µs is not nothing in CPU terms.** At this clock that is thousands of cycles.
It buys a fresh context, a UUID per run, an engine-resolving `Proxy`, per-step
idempotency-key resolution, a combined `AbortSignal` per attempt, a
`StepReport`, hook dispatch, tracing guards, and the contribution merge. That is
what the feature list costs when you total it up.

## Is 4 µs a lot?

Only against other microseconds.

| Operation | Typical | Five-step penstock overhead as a share |
| --- | ---: | ---: |
| In-memory computation | 0.1–1 µs | **dominant — do not use a pipeline** |
| Redis `GET`, localhost | 50–150 µs | ~13–40% |
| Postgres simple query | 0.2–2 ms | ~1–10% |
| HTTP call, same region | 5–50 ms | ~0.04–0.4% |
| HTTP call, cross-region | 50–500 ms | under 0.04% |

A five-step pipeline carries roughly 20 µs of orchestration. Against a single
cross-region HTTP call that is invisible. Against a tight in-memory loop it is
the whole cost — which is exactly the case
[Why penstock](../why-penstock/) tells you to write plain `async`/`await` for.
The library is for multi-step operations with side effects, and side effects
mean I/O, and I/O is measured in milliseconds.

## The other scenarios

**Hooks (row 4)** add roughly 1.5 µs over row 2 for a `before` and an `after`
that do nothing — the dispatch loop and its containment `try`, five times over.

**Parallel groups (rows 5 and 6)** are *slower* than sequential steps for work
this small: about 29 µs against 20 µs. A group allocates a combined
`AbortSignal`, a settlement barrier, and per-step scheduling, and none of that
pays for itself when the steps take no time. Capping concurrency costs a further
2.5 µs for the queueing. Groups win when the steps actually wait on something —
which is the only reason to use one.

**Retry (row 7)** costs essentially nothing when nothing fails. The policy is
checked, the loop runs once, and the measurement sits inside the run-to-run
noise of row 2.

**A no-op tracer (row 8)** costs about 1.8 µs over row 2, reading the medians:
six spans started and ended for a five-step run — one pipeline span and five
step spans — each call wrapped in the containment that stops a broken tracer
breaking a pipeline.

**Rollback (row 9)** roughly doubles a run, to about 41 µs. It is the most
expensive path and it should be: a failure, a `StepError` with a stack capture,
four compensations with their own metadata and spans. It is also the path that
runs when something has already gone wrong, where 20 extra microseconds is not
your problem.

**`serializeResult` (row 10)** flattens a twenty-step `Result` in about 370 ns,
which is cheaper than a single pipeline step. Logging every run costs nothing
worth measuring.

## Reproducing it

`bench/results.json` in the repository holds the raw output of the run above,
including p99 latencies and sample counts. The suite is deterministic in shape:
the same ten scenarios, the same batch size, and no picking of which run to
publish. If your numbers differ, the machine differs — publish yours.

## Next

- [Why penstock](../why-penstock/) — including when plain `async`/`await` wins.
- [Parallel groups and concurrency](../guides/parallel/) — when a group pays off.
- [Serialization and logging](../guides/serialization/) — row 10 in practice.
