// Runnable against the local source. Published code imports from 'penstock'.
import { setTimeout as sleep } from 'node:timers/promises';
import { pipeline } from '../../src/index.js';

interface JobInput {
  jobId: string;
  batches: number;
  budgetMs: number;
  slowBatch?: number;
}

const marker = { open: false };

const reindex = pipeline<JobInput>('nightly-reindex')
  .step('open-index', (ctx) => {
    marker.open = true;
    console.log(`  [job] opened writer for ${ctx.input.jobId}`);
    return { writer: `wr_${ctx.input.jobId}` };
  })
  .undo((ctx) => {
    marker.open = false;
    console.log(`  [job] closed and discarded ${ctx.writer}`);
  })
  .step('write-batches', async (ctx, meta) => {
    let written = 0;
    for (let i = 1; i <= ctx.input.batches; i++) {
      // The one place a long loop must cooperate: check the invocation signal.
      if (meta.signal.aborted) {
        console.log(`  [job] stopping early after ${written} batch(es)`);
        throw new Error('budget exhausted mid-batch');
      }
      const ms = i === ctx.input.slowBatch ? 200 : 20;
      await sleep(ms, undefined, { signal: meta.signal }).catch(() => {
        throw new Error(`batch ${i} abandoned`);
      });
      written = i;
      console.log(`  [job] batch ${i}/${ctx.input.batches} written`);
    }
    return { written };
  })
  .timeout(150) // per attempt
  .retry({ attempts: 2, delayMs: 20 })
  .step('publish', (ctx) => {
    marker.open = false;
    console.log(`  [job] published ${ctx.written} batch(es)`);
  });

const run = async (input: JobInput) => {
  marker.open = false;
  // The whole-job budget. AbortSignal.timeout is a Node built-in.
  const result = await reindex.execute(input, {
    signal: AbortSignal.timeout(input.budgetMs),
  });
  console.log(`  ok: ${result.ok} | aborted: ${result.aborted}`);
  for (const s of result.steps) {
    const extra = s.skipReason === undefined ? '' : ` ${s.skipReason}`;
    console.log(
      `    ${s.name.padEnd(14)} ${s.status.padEnd(11)}` +
        ` attempts=${s.attempts ?? '-'} timedOut=${s.timedOut ?? '-'}${extra}`,
    );
  }
  console.log(`  index writer still open: ${marker.open}`);
  console.log();
};

console.log('=== 1. finishes inside its budget ===');
await run({ jobId: 'job_1', batches: 3, budgetMs: 2000 });

console.log('=== 2. one batch is slow: the per-attempt timeout fires, then it retries ===');
await run({ jobId: 'job_2', batches: 3, budgetMs: 2000, slowBatch: 2 });

console.log('=== 3. the whole-job budget expires ===');
await run({ jobId: 'job_3', batches: 20, budgetMs: 120 });
