// Runnable against the local source. Published code imports from 'penstock'.
import { pipeline } from '../../src/index.js';

interface SignupInput {
  email: string;
  plan: 'team' | 'enterprise';
  breakTheRefund?: boolean;
}

// ── Three independent services, each with its own store ─────────────────────
const identity = {
  users: new Set<string>(),
  async createUser(email: string) {
    const id = `usr_${email.split('@')[0]}`;
    this.users.add(id);
    return id;
  },
  async deleteUser(id: string) {
    this.users.delete(id);
    console.log(`    [identity] deleted ${id}`);
  },
};

const billing = {
  subscriptions: new Set<string>(),
  async subscribe(userId: string, plan: string) {
    const id = `sub_${userId}_${plan}`;
    this.subscriptions.add(id);
    return id;
  },
  async cancel(id: string, broken: boolean) {
    if (broken) throw new Error('billing API returned 503');
    this.subscriptions.delete(id);
    console.log(`    [billing] cancelled ${id}`);
  },
};

const workspace = {
  spaces: new Set<string>(),
  async provision(userId: string) {
    const id = `ws_${userId}`;
    this.spaces.add(id);
    return id;
  },
  async destroy(id: string) {
    this.spaces.delete(id);
    console.log(`    [workspace] destroyed ${id}`);
  },
};

// ── One transaction spanning all three ──────────────────────────────────────
const onboard = pipeline<SignupInput>('onboard-customer')
  .step('create-user', async (ctx) => ({
    userId: await identity.createUser(ctx.input.email),
  }))
  .undo(async (ctx) => identity.deleteUser(ctx.userId))
  .step('start-subscription', async (ctx) => ({
    subscriptionId: await billing.subscribe(ctx.userId, ctx.input.plan),
  }))
  .undo(async (ctx) => billing.cancel(ctx.subscriptionId, ctx.input.breakTheRefund === true))
  .step('provision-workspace', async (ctx) => ({
    workspaceId: await workspace.provision(ctx.userId),
  }))
  .undo(async (ctx) => workspace.destroy(ctx.workspaceId))
  .step('activate', () => {
    // The last hop fails, after all three services have committed.
    throw new Error('activation service unreachable');
  });

const stores = () =>
  `users:${identity.users.size} subs:${billing.subscriptions.size} spaces:${workspace.spaces.size}`;

const reset = () => {
  identity.users.clear();
  billing.subscriptions.clear();
  workspace.spaces.clear();
};

const show = (r: Awaited<ReturnType<typeof onboard.execute>>) => {
  console.log(`  ok: ${r.ok} | error: ${r.error?.message}`);
  for (const s of r.steps) console.log(`    ${s.name.padEnd(20)} ${s.status}`);
  console.log(`  rollbackErrors: ${JSON.stringify(r.rollbackErrors.map((e) => e.message))}`);
  console.log(`  stores after: ${stores()}`);
  console.log();
};

console.log('=== all three services compensate, in reverse ===');
reset();
show(await onboard.execute({ email: 'ada@example.com', plan: 'team' }));

console.log('=== the billing compensation itself fails ===');
reset();
show(
  await onboard.execute({
    email: 'grace@example.com',
    plan: 'enterprise',
    breakTheRefund: true,
  }),
);
