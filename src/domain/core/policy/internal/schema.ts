import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';

const selection = z.union([z.literal('all'), z.array(identitySchema).min(1).readonly()]);
const principalRef = z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly();
const resource = z.object({ kind: identitySchema, ids: selection }).strict().readonly();
const effect = z.enum(['allow', 'deny', 'require-approval']);
const matchShape = { id: identitySchema, actions: selection, scopes: selection,
  principals: z.union([z.literal('all'), z.array(principalRef).min(1).readonly()]), resource };
const grant = z.object({ ...matchShape, effect }).strict().readonly();
const restriction = z.object(matchShape).strict().readonly();
export type PolicyRule = z.infer<typeof restriction>;
export type PolicyGrant = z.infer<typeof grant>;

export class PolicyError extends Error {
  constructor(readonly code: 'POLICY_INVALID' | 'POLICY_ROLE_UNKNOWN' = 'POLICY_INVALID') { super(code); this.name = 'PolicyError'; }
}
export function includes(values: 'all' | readonly string[], value: string) { return values === 'all' || values.includes(value); }
function unique(context: z.RefinementCtx, ids: readonly string[], message: string) {
  const seen = new Set<string>();
  for (const id of ids) { if (seen.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, message }); seen.add(id); }
}

/** v1: trusted grants may allow; overlays only restrict. A project/user overlay cannot create authority. */
const grantPolicySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema,
  grants: z.array(grant).readonly(), restrictions: z.array(restriction).readonly() }).strict().superRefine((policy, context) => {
    unique(context, [...policy.grants, ...policy.restrictions].map(rule => rule.id), 'POLICY_DUPLICATE_RULE');
  }).readonly();

// v2 (H34 S2). Role, permission and binding ids are short slugs, so a derived rule id `binding/role/permission` stays a unique identity.
const localId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/);
/** Each v2 revision is at most 127 characters so the effective `policy+bindings` revision stays one identity. */
const revision = identitySchema.refine(value => value.length <= 127);
const permission = z.object({ id: localId, effect, actions: selection, resource }).strict().readonly();
const role = z.object({ id: localId, permissions: z.array(permission).min(1).readonly() }).strict().readonly();
/** Separation of duties is organization policy data (C12 Q6); the rule vocabulary is versioned code. */
const duty = z.object({ id: identitySchema, rule: z.literal('requester-cannot-approve'), scopes: selection }).strict().readonly();
const binding = z.object({ id: localId, principals: z.array(principalRef).min(1).readonly(), roles: z.array(localId).min(1).readonly(),
  scopes: selection }).strict().readonly();
const v2Shape = { roles: z.array(role).readonly(), grants: z.array(grant).readonly(), restrictions: z.array(restriction).readonly(),
  separationOfDuties: z.array(duty).readonly() };
type V2Body = { readonly roles: readonly z.infer<typeof role>[]; readonly grants: readonly PolicyGrant[]; readonly restrictions: readonly PolicyRule[];
  readonly separationOfDuties: readonly z.infer<typeof duty>[] };
function checkV2(policy: V2Body, context: z.RefinementCtx) {
  unique(context, [...policy.grants, ...policy.restrictions, ...policy.separationOfDuties].map(rule => rule.id), 'POLICY_DUPLICATE_RULE');
  unique(context, policy.roles.map(value => value.id), 'POLICY_DUPLICATE_ROLE');
  for (const value of policy.roles) unique(context, value.permissions.map(item => item.id), 'POLICY_DUPLICATE_RULE');
}
function checkBindings(entries: readonly z.infer<typeof binding>[], context: z.RefinementCtx) {
  unique(context, entries.map(value => value.id), 'POLICY_DUPLICATE_BINDING');
  for (const value of entries) unique(context, value.roles, 'POLICY_DUPLICATE_BINDING');
}
/** policy.json v2: roles are data; bindings never live here (separate `bindings` resource). */
const rolePolicyFileSchema = z.object({ schemaVersion: z.literal(2), revision, ...v2Shape }).strict().superRefine(checkV2).readonly();
/** bindings.json: principals → roles at scopes. A binding only references a policy role; it creates no authority of its own. */
export const bindingsFileSchema = z.object({ schemaVersion: z.literal(1), revision, bindings: z.array(binding).readonly() }).strict()
  .superRefine((value, context) => checkBindings(value.bindings, context)).readonly();
/** The evaluator's v2 input: one trusted snapshot of policy + bindings, produced only by `resolvePolicyBindings`. */
const resolvedRolePolicySchema = z.object({ schemaVersion: z.literal(2), revision: identitySchema, policyRevision: revision, ...v2Shape,
  bindings: z.object({ revision, entries: z.array(binding).readonly() }).strict().readonly() }).strict().superRefine((policy, context) => {
    checkV2(policy, context); checkBindings(policy.bindings.entries, context);
    if (policy.revision !== `${policy.policyRevision}+${policy.bindings.revision}`) context.addIssue({ code: z.ZodIssueCode.custom, message: 'POLICY_REVISION' });
    const roles = new Set(policy.roles.map(value => value.id));
    if (policy.bindings.entries.some(value => value.roles.some(id => !roles.has(id)))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'POLICY_ROLE_UNKNOWN' });
  }).readonly();

/** Evaluator input: a v1 document (unchanged) or a resolved v2 snapshot. Every authorization consumer parses this. */
export const policySchema = z.union([grantPolicySchema, resolvedRolePolicySchema]);
/** What policy.json may contain. */
export const policyFileSchema = z.union([grantPolicySchema, rolePolicyFileSchema]);
export type Policy = z.infer<typeof policySchema>;
export type PolicyFile = z.infer<typeof policyFileSchema>;

/**
 * Resolves a policy file with its bindings into the one document the evaluator reads. v1 ignores bindings (never read for v1).
 * v2 needs its bindings; a binding naming a role the policy does not define refuses the whole authority (`POLICY_ROLE_UNKNOWN`).
 */
export function resolvePolicyBindings(policyInput: unknown, bindingsInput: unknown): Policy {
  const file = policyFileSchema.safeParse(policyInput);
  if (!file.success) throw new PolicyError();
  if (file.data.schemaVersion === 1) return file.data;
  const bound = bindingsFileSchema.safeParse(bindingsInput);
  if (!bound.success) throw new PolicyError();
  const roles = new Set(file.data.roles.map(value => value.id));
  if (bound.data.bindings.some(value => value.roles.some(id => !roles.has(id)))) throw new PolicyError('POLICY_ROLE_UNKNOWN');
  const { schemaVersion, revision: policyRevision, ...body } = file.data;
  const resolved = resolvedRolePolicySchema.safeParse({ schemaVersion, revision: `${policyRevision}+${bound.data.revision}`, policyRevision, ...body,
    bindings: { revision: bound.data.revision, entries: bound.data.bindings } });
  if (!resolved.success) throw new PolicyError();
  return resolved.data;
}

type Actor = { readonly issuer: string; readonly subject: string };
/**
 * The grants that can apply to one principal: explicit grants, then the permissions of the roles its bindings name, each at the
 * binding's scopes for exactly that principal (`binding/role/permission`). Derived per principal, never as bindings × principals.
 */
export function principalGrants(policy: Policy, actor: Actor): readonly PolicyGrant[] {
  if (policy.schemaVersion === 1) return policy.grants;
  const roles = new Map(policy.roles.map(value => [value.id, value]));
  const self = Object.freeze([Object.freeze({ issuer: actor.issuer, subject: actor.subject })]);
  const derived = policy.bindings.entries
    .filter(value => value.principals.some(item => item.issuer === actor.issuer && item.subject === actor.subject))
    .flatMap(value => value.roles.flatMap(roleId => (roles.get(roleId)?.permissions ?? []).map(item => Object.freeze({
      id: `${value.id}/${roleId}/${item.id}`, effect: item.effect, actions: item.actions, scopes: value.scopes, principals: self, resource: item.resource }))));
  return [...policy.grants, ...derived];
}

/** Whether any explicit rule or role permission targets `kind` (e.g. the task-admission restriction). */
export function policyHasResourceRules(input: unknown, kind: string): boolean {
  const policy = policySchema.parse(input);
  return [...policy.grants, ...policy.restrictions].some(rule => rule.resource.kind === kind)
    || (policy.schemaVersion === 2 && policy.roles.some(value => value.permissions.some(item => item.resource.kind === kind)));
}

/**
 * Four-eyes (C12 Q6): the id of the separation-of-duties rule an approval decision by `decider` would violate, or null.
 * Identity is exact issuer + subject; a display id never distinguishes principals. v1 has no such rules.
 */
export function separationOfDutiesViolation(input: unknown, decision: { readonly scopeId: string; readonly requester: Actor; readonly decider: Actor }): string | null {
  const policy = policySchema.parse(input);
  if (policy.schemaVersion === 1) return null;
  if (decision.requester.issuer !== decision.decider.issuer || decision.requester.subject !== decision.decider.subject) return null;
  return policy.separationOfDuties.find(rule => rule.rule === 'requester-cannot-approve' && includes(rule.scopes, decision.scopeId))?.id ?? null;
}
