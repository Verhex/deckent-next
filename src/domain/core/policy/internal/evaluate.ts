import { aiAuthorityFloor } from './ai-floor.js';
import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { verifiedPrincipalSchema, isMcpPrincipal } from '#domain/core/principal/index.js';
import { includes, policySchema, principalGrants, PolicyError, type Policy, type PolicyRule } from './schema.js';
export { includes, policySchema, PolicyError } from './schema.js';
export type { Policy } from './schema.js';
/** Role is never a request field: authority comes from the principal's bindings in trusted policy data, not from the caller. */
export const policyRequestSchema = z.object({ principal: verifiedPrincipalSchema, scopeId: identitySchema, action: identitySchema,
  resource: z.object({ kind: identitySchema, id: identitySchema }).strict().readonly() }).strict().readonly();
export type PolicyRequest = z.infer<typeof policyRequestSchema>;
export type PolicyDecision = Readonly<{ decision: 'allow' | 'deny' | 'require-approval'; revision: string; reason: 'GRANTED' | 'NO_GRANT' | 'DENIED' | 'SCOPE' | 'APPROVAL_REQUIRED' | 'AI_NON_DELEGABLE'; ruleId?: string }>;
function matches(rule: PolicyRule, request: PolicyRequest) {
  return includes(rule.actions, request.action) && includes(rule.scopes, request.scopeId) && rule.resource.kind === request.resource.kind
    && includes(rule.resource.ids, request.resource.id) && (rule.principals === 'all' ? !('effect' in rule && rule.effect === 'allow' && isMcpPrincipal(request.principal)) : rule.principals.some(principal =>
      principal.issuer === request.principal.issuer && principal.subject === request.principal.subject));
}
/** A deep-frozen document (every policy schema level is readonly, so a parsed document is one) is validated once per object: one monitor
 * snapshot evaluates the same loaded document for hundreds of attempts. Any other input is validated on every call, as before. */
const validated = new WeakMap<object, Policy>(), unfrozen = new WeakSet<object>();
const deepFrozen = (value: unknown): boolean => value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(deepFrozen));
function parsePolicy(input: unknown): ReturnType<typeof policySchema.safeParse> {
  const object = input !== null && typeof input === 'object' ? input : null, known = object ? validated.get(object) : undefined;
  if (known) return { success: true, data: known };
  const parsed = policySchema.safeParse(input);
  if (object && parsed.success && !unfrozen.has(object)) { if (deepFrozen(object)) validated.set(object, parsed.data); else unfrozen.add(object); }
  return parsed;
}
/** Order is fixed and version-independent: scope → deny/restriction → require-approval → allow → NO_GRANT. Roles only add candidates. */
export function evaluatePolicy(input: unknown, requestInput: unknown): PolicyDecision {
  const parsed = parsePolicy(input); const checked = policyRequestSchema.safeParse(requestInput);
  if (!parsed.success || !checked.success) throw new PolicyError();
  const policy = parsed.data; const request = checked.data;
  if (!request.principal.scopeIds.includes(request.scopeId)) return Object.freeze({ decision: 'deny', revision: policy.revision, reason: 'SCOPE' });
  if (aiAuthorityFloor(request.principal, request.resource, request.action)) return Object.freeze({ decision: 'deny', revision: policy.revision, reason: 'AI_NON_DELEGABLE' });
  const grants = principalGrants(policy, request.principal);
  const denied = grants.find(rule => rule.effect === 'deny' && matches(rule, request)) ?? policy.restrictions.find(rule => matches(rule, request));
  if (denied) return Object.freeze({ decision: 'deny', revision: policy.revision, reason: 'DENIED', ruleId: denied.id });
  const required = grants.find(rule => rule.effect === 'require-approval' && matches(rule, request));
  if (required) return Object.freeze({ decision: 'require-approval', revision: policy.revision, reason: 'APPROVAL_REQUIRED', ruleId: required.id });
  const allowed = grants.find(rule => rule.effect === 'allow' && matches(rule, request));
  return allowed ? Object.freeze({ decision: 'allow', revision: policy.revision, reason: 'GRANTED', ruleId: allowed.id })
    : Object.freeze({ decision: 'deny', revision: policy.revision, reason: 'NO_GRANT' });
}

/**
 * Whether a `require-approval` decision may be lowered by a permission mode (T-L4 slice 4a): the ids of **every** matching
 * `require-approval` rule when all of them are marked `modeEligible` (company data, policy v2), else null. Evaluated in the same
 * order as `evaluatePolicy`, so a deny, a restriction, an allow or a missing grant is never eligible, and an allow rule never adds
 * eligibility to a require-approval it does not own.
 */
export function modeEligibleApproval(input: unknown, requestInput: unknown): readonly string[] | null {
  if (evaluatePolicy(input, requestInput).decision !== 'require-approval') return null;
  const policy = policySchema.parse(input), request = policyRequestSchema.parse(requestInput);
  const required = principalGrants(policy, request.principal).filter(rule => rule.effect === 'require-approval' && matches(rule, request));
  return required.length > 0 && required.every(rule => rule.modeEligible === true) ? Object.freeze(required.map(rule => rule.id)) : null;
}
