import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import type { BaseContext } from '../src/context';
import { StepError } from '../src/errors';
import { Pipeline } from '../src/pipeline';
import { Step } from '../src/step';
import type { Result, StepReport } from '../src/types';

// End-to-end scenario combining every 0.3.0 feature (spec Phase C, step 4):
//
//   Pipeline 'checkout':
//     1. validate-order       (sequential, with guard + undo)
//     2. [parallel group]
//        - fetch-inventory    (retry + timeout + undo)
//        - check-fraud        (pipeline-as-step: nested fraud-check pipeline)
//        - fetch-pricing      (timeout)
//     3. charge-payment       (sequential, with undo)
//     4. [parallel group]
//        - notify-warehouse
//        - notify-user
//     5. confirm              (sequential)
//
// Input flags force each scenario: a flaky inventory service (retry proves
// itself), a fraudulent order (the nested pipeline fails), a declined card
// (a later sequential step fails), and cooperative holds so cancellation can
// land mid-group deterministically.

interface CheckoutInput {
  orderId: string;
  items: string[];
  /** The inventory service fails its first call; the retry policy covers it. */
  flakyInventory?: boolean;
  /** The nested fraud-check pipeline rejects the order (scenario c). */
  fraudulent?: boolean;
  /** charge-payment throws (scenario b). */
  declineCard?: boolean;
  /** fetch-pricing waits cooperatively on meta.signal (scenarios c and d). */
  holdPricing?: boolean;
  /** The nested pipeline's assess step waits cooperatively (scenario d). */
  holdFraud?: boolean;
}

interface CheckoutCtx extends BaseContext<CheckoutInput> {
  validated?: boolean;
  inventoryToken?: string;
  fraudScore?: number;
  price?: number;
  chargeId?: string;
  warehouseNotified?: boolean;
  userNotified?: boolean;
  confirmed?: boolean;
}

interface FraudInput {
  orderId: string;
  flagged: boolean;
  hold: boolean;
}

interface FraudCtx extends BaseContext<FraudInput> {
  screened?: boolean;
  score?: number;
}

/** Looks up a step report by name (names are unique within a pipeline). */
function report<C extends BaseContext>(
  result: Result<C>,
  name: string,
): StepReport {
  return result.steps.find((s) => s.name === name) as StepReport;
}

/**
 * Builds a fresh checkout pipeline per test (lifecycle callbacks and the
 * flaky-service counter are per-build state), recording lifecycle firings in
 * `events` and every undo in `undone` (inner and outer alike, in call order).
 */
function buildCheckout() {
  const events: string[] = [];
  const undone: string[] = [];
  let inventoryCalls = 0;

  const fraudPipeline = new Pipeline<FraudCtx>('fraud-check')
    .addStep(
      new Step<FraudCtx>('screen', {
        run: (ctx) => {
          ctx.screened = true;
        },
        undo: () => {
          undone.push('screen');
        },
      }),
    )
    .addStep(
      new Step<FraudCtx>('assess', {
        run: async (ctx) => {
          if (ctx.input.hold) {
            // Cooperative: settles only when the outer cancel propagates in.
            await new Promise<never>((_resolve, reject) => {
              ctx.signal.addEventListener(
                'abort',
                () => reject(ctx.signal.reason),
                { once: true },
              );
            });
          }
          if (ctx.input.flagged) {
            // Let the group's fast peers finish before the failure lands.
            await sleep(25);
            throw new Error('fraud detected');
          }
          ctx.score = 0.07;
        },
      }),
    );

  const checkout = new Pipeline<CheckoutCtx>('checkout')
    .addStep(
      new Step<CheckoutCtx>('validate-order', {
        run: (ctx) => {
          ctx.validated = true;
        },
        when: (ctx) => ctx.input.items.length > 0,
        undo: () => {
          undone.push('validate-order');
        },
      }),
    )
    .addParallel([
      new Step<CheckoutCtx>('fetch-inventory', {
        run: (ctx) => {
          inventoryCalls += 1;
          if (ctx.input.flakyInventory && inventoryCalls === 1) {
            throw new Error('inventory service unavailable');
          }
          ctx.inventoryToken = `inv_${ctx.input.orderId}`;
        },
        retry: { attempts: 3, delayMs: 0 },
        timeout: 1000,
        undo: () => {
          undone.push('fetch-inventory');
        },
      }),
      fraudPipeline.asStep<CheckoutCtx>('check-fraud', {
        mapInput: (ctx) => ({
          orderId: ctx.input.orderId,
          flagged: ctx.input.fraudulent === true,
          hold: ctx.input.holdFraud === true,
        }),
        mapResult: (innerResult, ctx) => {
          ctx.fraudScore = (innerResult as Result<FraudCtx>).context.score;
        },
        undo: () => {
          undone.push('check-fraud');
        },
      }),
      new Step<CheckoutCtx>('fetch-pricing', {
        run: (ctx, meta) => {
          if (ctx.input.holdPricing) {
            // Cooperative: settles only when this invocation's signal aborts —
            // meta.signal carries the group abort (a peer failing) as well as
            // a pipeline cancel (0.4.0 spec, section 1.3).
            return new Promise<void>((_resolve, reject) => {
              meta.signal.addEventListener(
                'abort',
                () => reject(meta.signal.reason),
                { once: true },
              );
            });
          }
          ctx.price = ctx.input.items.length * 100;
        },
        timeout: 1000,
      }),
    ])
    .addStep(
      new Step<CheckoutCtx>('charge-payment', {
        run: (ctx) => {
          if (ctx.input.declineCard) {
            throw new Error('card declined');
          }
          ctx.chargeId = `chg_${ctx.input.orderId}`;
        },
        undo: () => {
          undone.push('charge-payment');
        },
      }),
    )
    .addParallel([
      new Step<CheckoutCtx>('notify-warehouse', (ctx) => {
        ctx.warehouseNotified = true;
      }),
      new Step<CheckoutCtx>('notify-user', (ctx) => {
        ctx.userNotified = true;
      }),
    ])
    .addStep(
      new Step<CheckoutCtx>('confirm', (ctx) => {
        ctx.confirmed = true;
      }),
    )
    .onComplete(() => {
      events.push('complete');
    })
    .onFailure(() => {
      events.push('failure');
    })
    .onCancel(() => {
      events.push('cancel');
    })
    .onSettled(() => {
      events.push('settled');
    });

  return { checkout, events, undone };
}

describe('integration: checkout combining parallel groups, asStep, and lifecycle (0.3.0)', () => {
  it('scenario a: everything succeeds — onComplete fires and steps[] is complete in declaration order', async () => {
    const { checkout, events, undone } = buildCheckout();

    const result = await checkout.execute({
      orderId: 'ord_1',
      items: ['a', 'b'],
      flakyInventory: true,
    });

    expect(result.ok).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.error).toBeNull();
    expect(result.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
      'validate-order:completed',
      'fetch-inventory:completed',
      'check-fraud:completed',
      'fetch-pricing:completed',
      'charge-payment:completed',
      'notify-warehouse:completed',
      'notify-user:completed',
      'confirm:completed',
    ]);
    // The flaky inventory service failed once; the retry policy covered it.
    expect(report(result, 'fetch-inventory').attempts).toBe(2);
    // The nested pipeline ran to completion and surfaced its own Result.
    const fraud = report(result, 'check-fraud');
    expect(fraud.innerResult?.ok).toBe(true);
    expect(fraud.innerResult?.steps.map((s) => s.name)).toEqual([
      'screen',
      'assess',
    ]);
    // Every step's context writes landed (distinct keys, so parallel-safe).
    expect(result.context.validated).toBe(true);
    expect(result.context.inventoryToken).toBe('inv_ord_1');
    expect(result.context.fraudScore).toBe(0.07);
    expect(result.context.price).toBe(200);
    expect(result.context.chargeId).toBe('chg_ord_1');
    expect(result.context.warehouseNotified).toBe(true);
    expect(result.context.userNotified).toBe(true);
    expect(result.context.confirmed).toBe(true);
    expect(undone).toEqual([]);
    expect(result.rollbackErrors).toEqual([]);
    expect(events).toEqual(['complete', 'settled']);
  });

  it('scenario b: charge-payment fails — group 2 never runs; group 1 and validate-order roll back; onFailure fires', async () => {
    const { checkout, events, undone } = buildCheckout();

    const result = await checkout.execute({
      orderId: 'ord_2',
      items: ['a'],
      flakyInventory: true,
      declineCard: true,
    });

    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(false);
    expect((result.error as StepError).stepName).toBe('charge-payment');
    // Only the entries that ran are reported: group 2 and confirm never
    // started, so they have no reports at all.
    expect(result.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
      'validate-order:rolled-back',
      'fetch-inventory:rolled-back',
      'check-fraud:rolled-back',
      'fetch-pricing:completed', // no undo: declares itself to need none
      'charge-payment:failed',
    ]);
    // Reverse rollback: group 1 in reverse declaration order, then the prior
    // sequential step. The nested pipeline succeeded, so only the asStep
    // undo compensates it — its inner undos never re-run (scenario B of
    // section 1.2.4: 'screen' is absent).
    expect(undone).toEqual([
      'check-fraud',
      'fetch-inventory',
      'validate-order',
    ]);
    // The committed inner Result is still inspectable on the wrapping step.
    expect(report(result, 'check-fraud').innerResult?.ok).toBe(true);
    expect(result.rollbackErrors).toEqual([]);
    expect(events).toEqual(['failure', 'settled']);
  });

  it('scenario c: the nested fraud pipeline fails — the group cancels its peers; onFailure fires', async () => {
    const { checkout, events, undone } = buildCheckout();

    const result = await checkout.execute({
      orderId: 'ord_3',
      items: ['a'],
      fraudulent: true,
      holdPricing: true,
    });

    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(false);
    // The failure is the wrapping step's; its cause chain reaches the inner
    // pipeline's own StepError and the raw error beneath it.
    expect((result.error as StepError).stepName).toBe('check-fraud');
    const innerError = (result.error as StepError).cause as StepError;
    expect(innerError.stepName).toBe('assess');
    expect((innerError.cause as Error).message).toBe('fraud detected');
    expect(result.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
      'validate-order:rolled-back',
      'fetch-inventory:rolled-back',
      'check-fraud:failed',
      'fetch-pricing:skipped',
    ]);
    expect(report(result, 'fetch-pricing').skipReason).toBe(
      'cancelled (parallel peer failed)',
    );
    // The nested pipeline rolled itself back (scenario A of section 1.2.4):
    // its 'screen' undo ran inside the inner execute, before the outer
    // rollback walked the group in reverse declaration order.
    const fraud = report(result, 'check-fraud');
    expect(fraud.innerResult?.ok).toBe(false);
    expect(fraud.innerResult?.aborted).toBe(false);
    expect(report(fraud.innerResult as Result<FraudCtx>, 'screen').status).toBe(
      'rolled-back',
    );
    expect(undone).toEqual(['screen', 'fetch-inventory', 'validate-order']);
    expect(events).toEqual(['failure', 'settled']);
  });

  it('scenario d: cancelled mid-group — in-flight steps cancelled, completed ones rolled back; onCancel fires', async () => {
    const { checkout, events, undone } = buildCheckout();
    const controller = new AbortController();
    const reason = new Error('customer cancelled');
    // fetch-inventory completes immediately; the two held steps are still
    // in-flight when the cancel lands and settle only through the abort.
    setTimeout(() => controller.abort(reason), 15);

    const result = await checkout.execute(
      { orderId: 'ord_4', items: ['a'], holdPricing: true, holdFraud: true },
      { signal: controller.signal },
    );

    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.error).toBe(reason);
    expect(result.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
      'validate-order:rolled-back',
      'fetch-inventory:rolled-back',
      'check-fraud:skipped',
      'fetch-pricing:skipped',
      'charge-payment:skipped',
      'notify-warehouse:skipped',
      'notify-user:skipped',
      'confirm:skipped',
    ]);
    // In-flight group steps and everything after carry the cancel reason.
    for (const name of ['check-fraud', 'fetch-pricing', 'charge-payment']) {
      expect(report(result, name).skipReason).toBe('cancelled');
    }
    // The cancel propagated into the nested pipeline mid-run: it stopped,
    // rolled back its completed 'screen' step, and reported itself aborted.
    const fraud = report(result, 'check-fraud');
    expect(fraud.innerResult?.aborted).toBe(true);
    expect(report(fraud.innerResult as Result<FraudCtx>, 'screen').status).toBe(
      'rolled-back',
    );
    expect(undone).toEqual(['screen', 'fetch-inventory', 'validate-order']);
    expect(events).toEqual(['cancel', 'settled']);
  });
});
