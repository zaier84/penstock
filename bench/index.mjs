// penstock benchmark suite.
//
// Measures ORCHESTRATION OVERHEAD ONLY. Every step body does no real work — an
// immediately resolved promise — so what is timed is the cost of the machinery
// around a step, not the step. Numbers produced here are meaningless as a
// throughput claim and are published only to show the abstraction is cheap.
//
// It benchmarks ../dist/index.js, the built ESM output an npm consumer loads,
// so run `npm run build` at the repository root first.
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { Bench } from 'tinybench';
import {
  Pipeline,
  Step,
  defineStep,
  pipeline,
  serializeResult,
} from '../dist/index.js';

// A sink, so nothing measured can be eliminated as dead code.
let sink = null;

const input = { id: 'bench' };

// ── Scenario 1: hand-written baseline ───────────────────────────────────────
// Five sequential awaited calls, each producing a value assigned onto a context
// object. Exactly what a five-step pipeline does, minus all orchestration.
const w1 = async () => true;
const w2 = async () => true;
const w3 = async () => true;
const w4 = async () => true;
const w5 = async () => true;

const baseline = async () => {
  const ctx = { input };
  ctx.s1 = await w1();
  ctx.s2 = await w2();
  ctx.s3 = await w3();
  ctx.s4 = await w4();
  ctx.s5 = await w5();
  return ctx;
};

// ── Scenario 2: typed builder, five sequential steps ────────────────────────
// Steps return a contribution, which is the normal way the builder is used and
// includes the merge onto the context.
const buildTyped = () =>
  pipeline('bench')
    .step('s1', async () => ({ s1: true }))
    .step('s2', async () => ({ s2: true }))
    .step('s3', async () => ({ s3: true }))
    .step('s4', async () => ({ s4: true }))
    .step('s5', async () => ({ s5: true }));

const typedFive = buildTyped();

// ── Scenario 3: class API, five sequential steps ────────────────────────────
// The same logical work, assigned rather than returned, so scenario 2 minus
// scenario 3 isolates the builder facade itself.
const classFive = new Pipeline('bench')
  .addStep(new Step('s1', async (ctx) => { ctx.s1 = true; }))
  .addStep(new Step('s2', async (ctx) => { ctx.s2 = true; }))
  .addStep(new Step('s3', async (ctx) => { ctx.s3 = true; }))
  .addStep(new Step('s4', async (ctx) => { ctx.s4 = true; }))
  .addStep(new Step('s5', async (ctx) => { ctx.s5 = true; }));

// ── Scenario 4: five steps with before/after hooks registered ───────────────
const hooked = buildTyped()
  .before(() => {})
  .after(() => {});

// ── Scenarios 5 and 6: a parallel group of five ─────────────────────────────
const forBench = defineStep();
const p1 = forBench('p1', async () => ({ p1: true }));
const p2 = forBench('p2', async () => ({ p2: true }));
const p3 = forBench('p3', async () => ({ p3: true }));
const p4 = forBench('p4', async () => ({ p4: true }));
const p5 = forBench('p5', async () => ({ p5: true }));

const parallelAll = pipeline('bench').parallel([p1, p2, p3, p4, p5]);
const parallelCapped = pipeline('bench').parallel([p1, p2, p3, p4, p5], {
  concurrency: 2,
});

// ── Scenario 7: five steps with retry configured, never failing ─────────────
const retried = pipeline('bench')
  .step('s1', async () => ({ s1: true })).retry({ attempts: 3 })
  .step('s2', async () => ({ s2: true })).retry({ attempts: 3 })
  .step('s3', async () => ({ s3: true })).retry({ attempts: 3 })
  .step('s4', async () => ({ s4: true })).retry({ attempts: 3 })
  .step('s5', async () => ({ s5: true })).retry({ attempts: 3 });

// ── Scenario 8: five steps with a no-op Tracer ──────────────────────────────
const noopSpan = {
  setAttribute() {},
  recordException() {},
  setStatus() {},
  end() {},
};
const noopTracer = { startSpan: () => noopSpan };

// ── Scenario 9: rollback path — the fifth step fails, four undos run ────────
const rollbackFail = new Error('bench failure');
const rolling = pipeline('bench')
  .step('s1', async () => ({ s1: true })).undo(async () => {})
  .step('s2', async () => ({ s2: true })).undo(async () => {})
  .step('s3', async () => ({ s3: true })).undo(async () => {})
  .step('s4', async () => ({ s4: true })).undo(async () => {})
  .step('s5', async () => {
    throw rollbackFail;
  });

// ── Scenario 10: serializeResult over a twenty-step Result ──────────────────
let twentyStep = pipeline('bench');
for (let i = 1; i <= 20; i++) {
  twentyStep = twentyStep.step(`s${i}`, async () => ({ [`s${i}`]: true }));
}
const twentyStepResult = await twentyStep.execute(input);
if (twentyStepResult.steps.length !== 20) {
  throw new Error('expected a twenty-step Result');
}

// ── Run ─────────────────────────────────────────────────────────────────────
const SCENARIOS = [
  ['1. baseline: five plain sequential awaits', async () => { sink = await baseline(); }],
  ['2. typed builder: five sequential steps', async () => { sink = await typedFive.execute(input); }],
  ['3. class API: five sequential steps', async () => { sink = await classFive.execute(input); }],
  ['4. five steps with before/after hooks', async () => { sink = await hooked.execute(input); }],
  ['5. parallel group of five', async () => { sink = await parallelAll.execute(input); }],
  ['6. parallel group of five, concurrency 2', async () => { sink = await parallelCapped.execute(input); }],
  ['7. five steps with retry configured', async () => { sink = await retried.execute(input); }],
  ['8. five steps with a no-op tracer', async () => { sink = await typedFive.execute(input, { tracer: noopTracer }); }],
  ['9. rollback: fifth step fails, four undos', async () => { sink = await rolling.execute(input); }],
  ['10. serializeResult on a twenty-step Result', () => { sink = serializeResult(twentyStepResult); }],
];

// Every scenario runs its unit of work BATCH times per timed iteration, and the
// reported latency is divided by BATCH. Uniform across all ten scenarios, so it
// changes no comparison. It exists for two reasons: the sub-microsecond
// baseline otherwise produces tens of millions of retained samples and
// exhausts the heap, and batching lifts each sample well clear of timer
// resolution.
const BATCH = 20;

const batched = (fn) => async () => {
  for (let i = 0; i < BATCH; i++) await fn();
};

const bench = new Bench({ time: 2000, warmupIterations: 200, throws: true });
for (const [name, fn] of SCENARIOS) bench.add(name, batched(fn));

console.log('running 10 scenarios, 2s each plus warmup...\n');
await bench.run();
if (sink === null) throw new Error('sink never written');

const cpus = os.cpus();
const environment = {
  node: process.version,
  v8: process.versions.v8,
  os: `${os.platform()} ${os.release()} (${os.arch()})`,
  cpu: cpus[0]?.model.trim() ?? 'unknown',
  cores: cpus.length,
  memoryGB: Math.round(os.totalmem() / 1024 ** 3),
  date: new Date().toISOString().slice(0, 10),
  target: '../dist/index.js (built ESM output)',
  batchSize: BATCH,
};

const rows = bench.tasks.map((task) => {
  const r = task.result;
  return {
    scenario: task.name,
    // ops/sec is derived from mean latency rather than taken from tinybench's
    // throughput.mean, which averages per-sample throughput. For a right-skewed
    // latency distribution the two disagree, because mean(1/x) is not 1/mean(x),
    // and two columns that contradict each other are worse than one.
    opsPerSec: 1e9 / ((r.latency.mean * 1e6) / BATCH),
    nsPerOp: (r.latency.mean * 1e6) / BATCH,
    nsPerOpMedian: (r.latency.p50 * 1e6) / BATCH,
    nsPerOpP99: (r.latency.p99 * 1e6) / BATCH,
    rmePercent: r.latency.rme,
    samples: r.latency.samples.length,
  };
});

// Per-step overhead: scenario 2 minus scenario 1, divided by five.
// Derived from medians: the mean is dragged around by GC pauses, and the
// median is what a typical call actually costs.
const nsBaseline = rows[0].nsPerOpMedian;
const nsTyped = rows[1].nsPerOpMedian;
const nsClass = rows[2].nsPerOpMedian;
const perStepOverheadUs = (nsTyped - nsBaseline) / 5 / 1000;
const perStepClassUs = (nsClass - nsBaseline) / 5 / 1000;
const builderFacadeUs = (nsTyped - nsClass) / 5 / 1000;

const fmt = (n, d = 0) =>
  n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const widths = [46, 12, 12, 12, 9];
const header = ['scenario', 'ops/sec', 'ns/op mean', 'ns/op p50', '±rme'];
const line = (cells, pad = ' ') =>
  cells.map((c, i) => (i === 0 ? String(c).padEnd(widths[i], pad) : String(c).padStart(widths[i], pad))).join('  ');

console.log(line(header));
console.log(line(widths.map((w) => '-'.repeat(w)), '-'));
for (const row of rows) {
  console.log(
    line([
      row.scenario,
      fmt(row.opsPerSec),
      fmt(row.nsPerOp),
      fmt(row.nsPerOpMedian),
      `${row.rmePercent.toFixed(2)}%`,
    ]),
  );
}

console.log('\nderived');
console.log(`  per-step overhead, typed builder vs baseline : ${perStepOverheadUs.toFixed(3)} us`);
console.log(`  per-step overhead, class API vs baseline     : ${perStepClassUs.toFixed(3)} us`);
console.log(`  per-step cost of the builder facade itself   : ${builderFacadeUs.toFixed(3)} us`);

console.log('\nenvironment');
for (const [k, v] of Object.entries(environment)) console.log(`  ${k.padEnd(9)} ${v}`);

const payload = {
  environment,
  scenarios: rows,
  derived: {
    perStepOverheadUs,
    perStepClassApiUs: perStepClassUs,
    builderFacadeUs,
    note: 'Per-step overhead is (scenario 2 - scenario 1) / 5. Steps do no real work, so this is orchestration cost only.',
  },
};
writeFileSync(new URL('./results.json', import.meta.url), `${JSON.stringify(payload, null, 2)}\n`);
console.log('\nwrote bench/results.json');
