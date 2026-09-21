import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { verifiedPrincipalSchema } from '#domain/core/principal/index.js';
const selection = z.union([z.literal('all'), z.array(identitySchema).min(1).readonly()]);
const matchShape = { id: identitySchema, actions: selection, scopes: selection,
  principals: z.union([z.literal('all'), z.array(z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly()).min(1).readonly()]),
  resource: z.object({ kind: identitySchema, ids: selection }).strict().readonly() };
const grant = z.object({ ...matchShape, effect: z.enum(['allow', 'deny', 'require-approval']) }).strict().readonly();
const restriction = z.object(matchShape).strict().readonly();
/** Trusted grants may allow; overlays only restrict. A project/user overlay cannot create authority. */
export const policySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema,
  grants: z.array(grant).readonly(), restrictions: z.array(restriction).readonly() }).strict().superRefine((policy, context) => {
    const ids = new Set<string>();
    for (const rule of [...policy.grants, ...policy.restrictions]) {
      if (ids.has(rule.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'POLICY_DUPLICATE_RULE' });
      ids.add(rule.id);
    }
  }).readonly();
export const policyRequestSchema = z.object({ principal: verifiedPrincipalSchema, scopeId: identitySchema, action: identitySchema,
  resource: z.object({ kind: identitySchema, id: identitySchema }).strict().readonly() }).strict().readonly();
export type Policy = z.infer<typeof policySchema>;
export type PolicyRequest = z.infer<typeof policyRequestSchema>;
export type PolicyDecision = Readonly<{ decision: 'allow' | 'deny' | 'require-approval'; revision: string; reason: 'GRANTED' | 'NO_GRANT' | 'DENIED' | 'SCOPE' | 'APPROVAL_REQUIRED'; ruleId?: string }>;
export class PolicyError extends Error { constructor() { super('POLICY_INVALID'); this.name = 'PolicyError'; } }
function includes(values: 'all' | readonly string[], value: string) { return values === 'all' || values.includes(value); }
function matches(rule: z.infer<typeof restriction>, request: PolicyRequest) {
  return includes(rule.actions, request.action) && includes(rule.scopes, request.scopeId) && rule.resource.kind === request.resource.kind
    && includes(rule.resource.ids, request.resource.id) && (rule.principals === 'all' || rule.principals.some(principal =>
      principal.issuer === request.principal.issuer && principal.subject === request.principal.subject));
}
export function evaluatePolicy(input: unknown, requestInput: unknown): PolicyDecision {
  const parsed = policySchema.safeParse(input); const checked = policyRequestSchema.safeParse(requestInput);
  if (!parsed.success || !checked.success) throw new PolicyError();
  const policy = parsed.data; const request = checked.data;
  if (!request.principal.scopeIds.includes(request.scopeId)) return Object.freeze({ decision: 'deny', revision: policy.revision, reason: 'SCOPE' });
  const denied = policy.grants.find(rule => rule.effect === 'deny' && matches(rule, request)) ?? policy.restrictions.find(rule => matches(rule, request));
  if (denied) return Object.freeze({ decision: 'deny', revision: policy.revision, reason: 'DENIED', ruleId: denied.id });
  const required = policy.grants.find(rule => rule.effect === 'require-approval' && matches(rule, request));
  if (required) return Object.freeze({ decision: 'require-approval', revision: policy.revision, reason: 'APPROVAL_REQUIRED', ruleId: required.id });
  const allowed = policy.grants.find(rule => rule.effect === 'allow' && matches(rule, request));
  return allowed ? Object.freeze({ decision: 'allow', revision: policy.revision, reason: 'GRANTED', ruleId: allowed.id })
    : Object.freeze({ decision: 'deny', revision: policy.revision, reason: 'NO_GRANT' });
}

/** Membership candidates originate only from trusted allow grants. This is not action authorization:
 * evaluatePolicy must still enforce resource/action matching, explicit denies and restrictions.
 */
export function policyScopeMembership(input: unknown, actor: { issuer: string; subject: string }, candidates: readonly string[]): readonly string[] {
  const policy = policySchema.parse(input); const issuer = identitySchema.parse(actor.issuer); const subject = identitySchema.parse(actor.subject);
  const scopes = [...new Set(candidates.map(candidate => identitySchema.parse(candidate)))];
  return Object.freeze(scopes.filter(scope => policy.grants.some(rule => rule.effect === 'allow' && includes(rule.scopes, scope)
    && (rule.principals === 'all' || rule.principals.some(principal => principal.issuer === issuer && principal.subject === subject)))));
}
