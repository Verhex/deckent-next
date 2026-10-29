import { z } from 'zod';
import { BeuserContractError, type BeuserArrangePort, type BeuserArrangeStep, type BeuserContext, type BeuserUnarrangedState } from '#engine/core/beuser-contract/index.js';
import type { BeuserController } from './controller.js';

const ranSchema = z.object({ exitCode: z.number().int().nullable(), stdoutBytes: z.number().int().nonnegative().safe(),
  stdoutDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
/** Retained as an `arrange` transcript row: harness setup values only, never target output, a persona action or acceptance evidence. A `check` runs nothing. */
export interface BeuserArrangeReceipt { readonly id: string; readonly version: number; readonly ran: z.infer<typeof ranSchema> | null;
  readonly readback: BeuserArrangeStep['readback'] & { readonly met: boolean } }
export interface BeuserArrangement {
  readonly steps: readonly BeuserArrangeStep[]; readonly unarranged: readonly BeuserUnarrangedState[]; readonly port: BeuserArrangePort;
  readonly record: (context: BeuserContext, receipt: BeuserArrangeReceipt) => Promise<void>;
}
/** Every field `expected` names must match the observation. */
const matches = (observed: unknown, expected: unknown): boolean => typeof expected !== 'object' || expected === null ? observed === expected
  : typeof observed === 'object' && observed !== null && Object.entries(expected).every(([key, value]) => (observed as Record<string, unknown>)[key] === value);
/** Catalogued steps only, each gated by its own readback before the persona starts. A branch with a typed-unknown state never starts
 * (UNREACHABLE, before any effect); an unmet step stays typed unknown. Never RED, never a retry. */
export async function arrangeBeuserStart(controller: BeuserController, arrangement: BeuserArrangement): Promise<void> {
  const { limits } = controller.context;
  if (arrangement.unarranged.some(row => row.reason !== 'persona')) throw new BeuserContractError('BEUSER_START_STATE_UNREACHABLE');
  if (arrangement.steps.length > limits.maxSteps || arrangement.steps.some(step => step.kind !== 'check' && step.timeoutMs >= limits.maxWaitMs)) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE');
  for (const step of arrangement.steps) {
    const ran = step.kind === 'check' ? null : ranSchema.parse(await controller.call('beuser-sandbox', 'create', ctx => arrangement.port.run(ctx, step)));
    const met = (ran === null || ran.exitCode === 0)
      && matches(await controller.call('beuser-sandbox', 'create', ctx => arrangement.port.observe(ctx, step.readback)), step.readback.expected);
    await controller.call('beuser-transcript', 'inspect', ctx => arrangement.record(ctx, { id: step.id, version: step.version, ran, readback: { ...step.readback, met } }));
    if (!met) throw new BeuserContractError('BEUSER_START_STATE_UNMET');
  }
}
