import { beuserReadbackSchema, type BeuserReadback } from '#capabilities/index.js';
import { assertBeuserAccess, type BeuserContext } from '#engine/core/beuser-contract/index.js';
/** A controller-owned probe reads only this allowlist; there is no path, arbitrary command or raw receipt port. */
export async function collectBeuserReadback(context: BeuserContext, probe: () => Promise<unknown>): Promise<BeuserReadback> {
  assertBeuserAccess(context, context.binding, context.principal, { kind: 'beuser-transcript', id: context.binding.transcriptId }, 'inspect');
  const result = beuserReadbackSchema.parse(await probe());
  assertBeuserAccess(context, result.binding, context.principal, { kind: 'beuser-transcript', id: context.binding.transcriptId }, 'inspect');
  return result;
}
