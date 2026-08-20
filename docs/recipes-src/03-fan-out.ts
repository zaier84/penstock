// Runnable against the local source. Published code imports from 'penstock'.
import { setTimeout as sleep } from 'node:timers/promises';
import { defineStep, pipeline } from '../../src/index.js';

interface DashboardInput {
  accountId: string;
}

// A supplier API that records how many calls are in flight at once, so the
// concurrency cap is observable rather than asserted.
let inFlight = 0;
let peak = 0;
const supplier = {
  async fetch(name: string, ms: number) {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    console.log(`    -> ${name} started (${inFlight} in flight)`);
    await sleep(ms);
    inFlight -= 1;
    return `${name}-data`;
  },
};

const forDashboard = defineStep<DashboardInput>();

const profile = forDashboard('profile', async () => ({
  profile: await supplier.fetch('profile', 40),
}));
const invoices = forDashboard('invoices', async () => ({
  invoices: await supplier.fetch('invoices', 30),
}));
const usage = forDashboard('usage', async () => ({
  usage: await supplier.fetch('usage', 20),
}));
const tickets = forDashboard('tickets', async () => ({
  tickets: await supplier.fetch('tickets', 50),
}));
const alerts = forDashboard('alerts', async () => ({
  alerts: await supplier.fetch('alerts', 10),
}));

const build = (concurrency?: number) =>
  pipeline<DashboardInput>('dashboard')
    .step('authorize', () => {})
    .parallel(
      [profile, invoices, usage, tickets, alerts],
      concurrency === undefined ? undefined : { concurrency },
    )
    .step('assemble', (ctx) => {
      // Every parallel step's contribution is here, all required.
      const parts = [ctx.profile, ctx.invoices, ctx.usage, ctx.tickets, ctx.alerts];
      return { widgets: parts.length };
    });

const run = async (label: string, concurrency?: number) => {
  inFlight = 0;
  peak = 0;
  const started = performance.now();
  const result = await build(concurrency).execute({ accountId: 'acct_1' });
  const elapsed = Math.round((performance.now() - started) / 10) * 10;
  console.log(`${label}`);
  console.log(`  ok: ${result.ok} | widgets: ${result.context.widgets}`);
  console.log(`  peak concurrency: ${peak} | elapsed ~${elapsed}ms`);
  console.log(`  report order: ${result.steps.map((s) => s.name).join(', ')}`);
  console.log();
};

console.log('=== unbounded: all five at once ===');
await run('unbounded', undefined);

console.log('=== capped at 2 ===');
await run('concurrency: 2', 2);
