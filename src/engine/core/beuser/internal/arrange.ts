import { z } from 'zod';
import { BeuserContractError, type BeuserArrangePort, type BeuserArrangeStep, type BeuserContext } from '#engine/core/beuser-contract/index.js';
import type { BeuserController } from './controller.js';

const ranSchema = z.object({ exitCode: z.number().int().nullable(), stdoutBytes: z.number().int().nonnegative().safe(),
  stdoutDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
/** Retained as an `arrange` transcript row: harness setup values only, never target output, a persona action or acceptance evidence. */
export type BeuserArrangeReceipt = z.infer<typeof ranSchema> & { readonly id: string; readonly version: number;
  readonly readback: BeuserArrangeStep['readback'] & { readonly met: boolean } };
export interface BeuserArrangement {
  readonly steps: readonly BeuserArrangeStep[]; readonly port: BeuserArrangePort;
  readonly record: (context: BeuserContext, receipt: BeuserArrangeReceipt) => Promise<void>;
}
/** Catalogued steps only, each gated by its own readback before the persona starts. Unmet stays typed unknown, never RED or a retry. */
export async function arrangeBeuserStart(controller: BeuserController, arrangement: BeuserArrangement): Promise<void> {
  const { limits } = controller.context;
  if (arrangement.steps.length > limits.maxSteps || arrangement.steps.some(step => step.timeoutMs >= limits.maxWaitMs)) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE');
  for (const step of arrangement.steps) {
    const ran = ranSchema.parse(await controller.call('beuser-sandbox', 'create', ctx => arrangement.port.run(ctx, step)));
    const observed = ran.exitCode === 0 ? await controller.call('beuser-sandbox', 'create', ctx => arrangement.port.observe(ctx)) : null;
    const met = typeof observed === 'object' && observed !== null && (observed as Record<string, unknown>)[step.readback.key] === step.readback.expected;
    await controller.call('beuser-transcript', 'inspect', ctx => arrangement.record(ctx, { id: step.id, version: step.version, ...ran, readback: { ...step.readback, met } }));
    if (!met) throw new BeuserContractError('BEUSER_START_STATE_UNMET');
  }
}
