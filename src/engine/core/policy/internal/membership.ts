import { policyScopeMembership } from '#domain/index.js';

/** Application-owned projection of the scopes a verified actor may claim from policy. */
export function resolvePolicyScopeMembership(
  policy: unknown,
  actor: { readonly issuer: string; readonly subject: string },
  candidates: readonly string[],
): readonly string[] {
  return policyScopeMembership(policy, actor, candidates);
}
