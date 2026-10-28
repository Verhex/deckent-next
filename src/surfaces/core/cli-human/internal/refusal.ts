import { ErrorRegistry } from '#platform/index.js';

/**
 * BeUser D-04/E-05: a policy refusal of a founder-grantable action names the missing cell and the founder-baseline family whose card grants it
 * (`deckent init policy --scope <s> --owner-baseline <family> --apply`). The code stays POLICY_DENIED; nothing is granted or retried here.
 */
export function withFounderStep(error: unknown, input: { readonly cell: string; readonly scope: string; readonly family: string }): unknown {
  if ((error as { code?: unknown } | null)?.code !== 'POLICY_DENIED') return error;
  return ErrorRegistry.createError('POLICY_DENIED', { params: { cell: input.cell, scope: input.scope, family: input.family }, cause: error });
}
