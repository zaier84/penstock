// User-onboarding example. Run it with: npm run example:onboarding
//
// This example imports from the local source so it runs against the repo
// without a build/link step. In your own project you would instead:
//   import { Pipeline, Step } from 'penstock';
import { Pipeline, Step } from '../src/index.js';
import type { BaseContext } from '../src/index.js';

interface SignupInput {
  email: string;
  plan: 'free' | 'pro';
  sendWelcome: boolean;
}

interface OnboardCtx extends BaseContext<SignupInput> {
  userId?: string;
  trialEndsAt?: string;
}

const validateSignup = new Step<OnboardCtx>('validate-signup', (ctx) => {
  if (!ctx.input.email.includes('@')) {
    throw new Error('Invalid email address');
  }
});

const createAccount = new Step<OnboardCtx>('create-account', {
  run: (ctx) => {
    ctx.userId = `usr_${ctx.input.email.split('@')[0]}`;
    console.log(`  created account ${ctx.userId}`);
  },
  undo: (ctx) => {
    console.log(`  ↩ deleted account ${ctx.userId}`);
  },
});

const startProTrial = new Step<OnboardCtx>('start-pro-trial', {
  run: (ctx) => {
    ctx.trialEndsAt = '14 days';
    console.log('  started 14-day pro trial');
  },
  when: (ctx) => ctx.input.plan === 'pro',
});

const sendWelcomeEmail = new Step<OnboardCtx>('send-welcome-email', {
  run: () => {
    console.log('  queued welcome email');
  },
  when: (ctx) => ctx.input.sendWelcome,
});

const onboarding = new Pipeline<OnboardCtx>('user-onboarding')
  .addStep(validateSignup)
  .addStep(createAccount)
  .addStep(startProTrial)
  .addStep(sendWelcomeEmail);

const input: SignupInput = {
  email: 'ada@example.com',
  plan: 'free',
  sendWelcome: true,
};

const statuses = (steps: { name: string; status: string }[]): string =>
  steps.map((s) => `${s.name}:${s.status}`).join(', ');

// Dry-run plans the flow — guards are evaluated, but no run/undo executes.
console.log('▶ dry run (plan only — no side effects)');
const plan = await onboarding.execute(input, { dryRun: true });
console.log('  steps:', statuses(plan.steps));

console.log('\n▶ live run');
const result = await onboarding.execute(input);
console.log('  ok:', result.ok, '| userId:', result.context.userId);
console.log('  steps:', statuses(result.steps));
