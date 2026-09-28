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
/**
 * Terminal permission modes (T-L4 slice 4a, owner 2026-09-27 q2): a v2 company rule may mark its `require-approval` as
 * mode-eligible. The mark lowers nothing by itself; only a person's mode (bindings) may lower exactly such a rule, and only on a
 * relaxable cell. On any other effect the mark is invalid (a mode can never touch allow, deny or a restriction).
 */
const modeEligible = { modeEligible: z.boolean().optional() };
const eligibleOnlyOnApproval = (rule: { readonly effect: string; readonly modeEligible?: boolean | undefined }) => rule.modeEligible !== true || rule.effect === 'require-approval';
const markedGrant = z.object({ ...matchShape, effect, ...modeEligible }).strict().refine(eligibleOnlyOnApproval, 'POLICY_MODE_ELIGIBLE').readonly();
/** A v2 company grant as `policy.administer` changes carry it (same schema as in policy.json). */
export const policyGrantSchema = markedGrant;
export type PolicyRule = z.infer<typeof restriction>;
export type PolicyGrant = z.infer<typeof grant> & { readonly modeEligible?: boolean | undefined };

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
const permission = z.object({ id: localId, effect, actions: selection, resource, ...modeEligible }).strict().refine(eligibleOnlyOnApproval, 'POLICY_MODE_ELIGIBLE').readonly();
const role = z.object({ id: localId, permissions: z.array(permission).min(1).readonly() }).strict().readonly();
/** Separation of duties is organization policy data (C12 Q6); the rule vocabulary is versioned code. */
const duty = z.object({ id: identitySchema, rule: z.literal('requester-cannot-approve'), scopes: selection }).strict().readonly();
const binding = z.object({ id: localId, principals: z.array(principalRef).min(1).readonly(), roles: z.array(localId).min(1).readonly(),
  scopes: selection }).strict().readonly();
/** A role binding as `policy.administer` changes carry it (same schema as in bindings.json). */
export const policyBindingSchema = binding;
export type PolicyBinding = z.infer<typeof binding>;
const v2Shape = { roles: z.array(role).readonly(), grants: z.array(markedGrant).readonly(), restrictions: z.array(restriction).readonly(),
  separationOfDuties: z.array(duty).readonly() };
/**
 * A person's terminal permission mode (bindings v2, owner 2026-09-27 q3): one principal, explicit scopes, one mode. It creates no
 * authority: it only lets a mode-eligible company `require-approval` be lowered on a relaxable cell. `ask` equals no entry.
 */
export const PERMISSION_MODES = ['ask', 'auto-edit', 'full-auto'] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
const modeEntry = z.object({ id: localId, principal: principalRef, scopes: z.array(identitySchema).min(1).readonly(), mode: z.enum(PERMISSION_MODES) }).strict().readonly();
type V2Body = { readonly roles: readonly z.infer<typeof role>[]; readonly grants: readonly z.infer<typeof markedGrant>[]; readonly restrictions: readonly PolicyRule[];
  readonly separationOfDuties: readonly z.infer<typeof duty>[] };
function checkV2(policy: V2Body, context: z.RefinementCtx) {
  unique(context, [...policy.grants, ...policy.restrictions, ...policy.separationOfDuties].map(rule => rule.id), 'POLICY_DUPLICATE_RULE');
  unique(context, policy.roles.map(value => value.id), 'POLICY_DUPLICATE_ROLE');
  for (const value of policy.roles) unique(context, value.permissions.map(item => item.id), 'POLICY_DUPLICATE_RULE');
}
function checkBindings(entries: readonly z.infer<typeof binding>[], context: z.RefinementCtx, modes: readonly z.infer<typeof modeEntry>[] = []) {
  unique(context, entries.map(value => value.id), 'POLICY_DUPLICATE_BINDING');
  for (const value of entries) unique(context, value.roles, 'POLICY_DUPLICATE_BINDING');
  unique(context, modes.map(value => value.id), 'POLICY_DUPLICATE_BINDING');
  for (const value of modes) unique(context, value.scopes, 'POLICY_DUPLICATE_BINDING');
}
/** policy.json v2: roles are data; bindings never live here (separate `bindings` resource). */
const rolePolicyFileSchema = z.object({ schemaVersion: z.literal(2), revision, ...v2Shape }).strict().superRefine(checkV2).readonly();
/** bindings.json: principals → roles at scopes. A binding only references a policy role; it creates no authority of its own.
 * v2 (T-L4 slice 4a) adds the persons' terminal permission `modes`; v1 stays readable (everyone `ask`); an older reader refuses v2. */
const roleBindingsSchema = z.object({ schemaVersion: z.literal(1), revision, bindings: z.array(binding).readonly() }).strict()
  .superRefine((value, context) => checkBindings(value.bindings, context)).readonly();
const modeBindingsSchema = z.object({ schemaVersion: z.literal(2), revision, bindings: z.array(binding).readonly(), modes: z.array(modeEntry).readonly() }).strict()
  .superRefine((value, context) => checkBindings(value.bindings, context, value.modes)).readonly();
export const bindingsFileSchema = z.union([roleBindingsSchema, modeBindingsSchema]);
/** The evaluator's v2 input: one trusted snapshot of policy + bindings, produced only by `resolvePolicyBindings`. */
const resolvedRolePolicySchema = z.object({ schemaVersion: z.literal(2), revision: identitySchema, policyRevision: revision, ...v2Shape,
  bindings: z.object({ revision, entries: z.array(binding).readonly(), modes: z.array(modeEntry).readonly().optional() }).strict().readonly() }).strict().superRefine((policy, context) => {
    checkV2(policy, context); checkBindings(policy.bindings.entries, context, policy.bindings.modes);
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
    bindings: { revision: bound.data.revision, entries: bound.data.bindings, ...(bound.data.schemaVersion === 2 ? { modes: bound.data.modes } : {}) } });
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
      id: `${value.id}/${roleId}/${item.id}`, effect: item.effect, actions: item.actions, scopes: value.scopes, principals: self, resource: item.resource,
      ...(item.modeEligible === undefined ? {} : { modeEligible: item.modeEligible }) }))));
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

/**
 * The person's terminal permission mode in one scope (T-L4 slice 4a): exactly one v2 bindings entry for this exact issuer + subject
 * naming the scope, or null (= `ask`). Two entries for the same person and scope are ambiguous and fail closed as null; a v1 policy
 * reads no bindings, so it has no modes.
 */
export function principalPermissionMode(input: unknown, actor: Actor, scopeId: string): { readonly mode: PermissionMode; readonly id: string } | null {
  const policy = policySchema.parse(input);
  if (policy.schemaVersion === 1) return null;
  const matches = (policy.bindings.modes ?? []).filter(entry => entry.principal.issuer === actor.issuer && entry.principal.subject === actor.subject
    && entry.scopes.includes(scopeId));
  return matches.length === 1 && matches[0]!.mode !== 'ask' ? Object.freeze({ mode: matches[0]!.mode, id: matches[0]!.id }) : null;
}
