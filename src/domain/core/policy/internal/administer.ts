import { isMcpPrincipal } from '#domain/core/principal/index.js';
import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { bindingsFileSchema, policyBindingSchema, policyFileSchema, policyGrantSchema, policyRoleSchema, policySchema, principalGrants, resolvePolicyBindings, type Policy,
  type PolicyBinding, type PolicyFile, type PolicyGrant } from './schema.js';

/**
 * Governed policy administration (POLICY-ADMIN P1, lead decision A1 `policy.administer@1`). Pure: a typed, bounded change set over the
 * company policy (v2 grants) and the role bindings, the documents it produces, and the delegation bound — a principal grants,
 * delegates or revokes only what its own effective authority holds. Input v2 additionally creates immutable profile roles;
 * restrictions, separation of duties and permission modes retain their own contracts.
 */
export const POLICY_CHANGE_MAX = 32;
/** Largest number of (action × id × scope) cells one change may make the bound evaluate; an `'all'` dimension counts once. */
export const DELEGATION_CELL_LIMIT = 4096;
/** The owner root is data, never a code branch: a role of this id, bound to the installing principal, evaluated like any other. */
export const INSTALLATION_OWNER_ROLE_ID = 'installation-owner';

const changeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('grant.add'), grant: policyGrantSchema }).strict(),
  z.object({ kind: z.literal('grant.remove'), id: identitySchema }).strict(),
  z.object({ kind: z.literal('grant.replace'), grant: policyGrantSchema }).strict(),
  z.object({ kind: z.literal('binding.add'), binding: policyBindingSchema }).strict(),
  z.object({ kind: z.literal('binding.remove'), id: identitySchema }).strict(),
  z.object({ kind: z.literal('binding.replace'), binding: policyBindingSchema }).strict(),
]);
/** `policy.administer@1` input v1: 1–32 changes applied in order to one snapshot. */
const legacyPolicyChangeSchema = z.object({ schemaVersion: z.literal(1), changes: z.array(changeSchema).min(1).max(POLICY_CHANGE_MAX).readonly() }).strict().readonly();
/** I2 input v2 adds immutable roles. Old v1 commands remain unchanged; older writers reject v2. */
const profilePolicyChangeSchema = z.object({ schemaVersion: z.literal(2),
  changes: z.array(z.union([changeSchema, z.object({ kind: z.literal('role.add'), role: policyRoleSchema }).strict()])).min(1).max(POLICY_CHANGE_MAX).readonly(),
  profile: z.object({ id: identitySchema, version: z.number().int().positive().safe(), digest: z.string().regex(/^[a-f0-9]{64}$/),
    registryDigest: z.string().regex(/^[a-f0-9]{64}$/), previewDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly(),
}).strict().readonly();
export const policyChangeSchema = z.union([legacyPolicyChangeSchema, profilePolicyChangeSchema]);
export type PolicyChange = z.infer<typeof policyChangeSchema>;

export class PolicyChangeError extends Error {
  constructor(readonly code: 'POLICY_CHANGE_INVALID' | 'POLICY_CHANGE_TOO_LARGE' | 'POLICY_ADMINISTER_UNSUPPORTED') { super(code); this.name = 'PolicyChangeError'; }
}

type Selection = 'all' | readonly string[];
/** A rule a change touches, at the scopes where it takes effect (a role binding's rule takes the binding's scopes). */
export interface DelegatedRule {
  readonly id: string; readonly effect: 'allow' | 'deny' | 'require-approval'; readonly actions: Selection; readonly scopes: Selection;
  readonly resource: { readonly kind: string; readonly ids: Selection }; readonly modeEligible?: boolean | undefined;
}
type RolePolicyFile = Extract<PolicyFile, { schemaVersion: 2 }>;
type BindingsFile = z.infer<typeof bindingsFileSchema>;
type Body<T> = { readonly [K in Exclude<keyof T, 'revision'>]: T[K] };
export interface PolicyChangePlan {
  /** The next policy.json body without its revision (the writer chains it), or null when the policy file does not change. */
  readonly policy: Body<RolePolicyFile> | null;
  readonly bindings: Body<BindingsFile> | null;
  /** I8: revocations write bindings first. I2 may publish new, unbound roles first before binding removals/additions;
   * both intermediate snapshots must be valid. New roles mixed with grant revocations are refused. */
  readonly order: 'policy-first' | 'bindings-first';
  readonly touched: readonly DelegatedRule[];
  readonly counts: { readonly grantsAdded: number; readonly grantsRemoved: number; readonly bindingsAdded: number; readonly bindingsRemoved: number };
}

const omit = (value: object, keys: readonly string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const invalid = (): never => { throw new PolicyChangeError('POLICY_CHANGE_INVALID'); };
const planned = <T extends object>(body: T) => ({ ...body, revision: 'planned' });
function validSnapshot(policy: unknown, bindings: unknown) {
  try { resolvePolicyBindings(policy, bindings); } catch { invalid(); }
}
const rule = (grant: PolicyGrant): DelegatedRule => Object.freeze({ id: grant.id, effect: grant.effect, actions: grant.actions, scopes: grant.scopes, resource: grant.resource,
  ...(grant.modeEligible === undefined ? {} : { modeEligible: grant.modeEligible }) });

/**
 * Applies a change set to one snapshot (policy v2 + its bindings): the next bodies, the write order, and every rule the change touches
 * — added, removed, and both sides of a replacement; a binding touches each permission of each role it names, at its scopes.
 * Typed refusals: an input that is not a versioned change set, an id that is missing or taken, an unknown role, or a result or intermediate
 * state that is not a valid snapshot → `POLICY_CHANGE_INVALID`; a v1 policy (no bindings) → `POLICY_ADMINISTER_UNSUPPORTED`.
 */
export function planPolicyChange(policyInput: unknown, bindingsInput: unknown, changeInput: unknown): PolicyChangePlan {
  const change = policyChangeSchema.safeParse(changeInput);
  const policyParsed = policyFileSchema.safeParse(policyInput);
  if (!change.success || !policyParsed.success) return invalid();
  if (policyParsed.data.schemaVersion === 1) throw new PolicyChangeError('POLICY_ADMINISTER_UNSUPPORTED');
  const policy = policyParsed.data;
  const bindingsParsed = bindingsFileSchema.safeParse(bindingsInput);
  if (!bindingsParsed.success) return invalid();
  const bindings = bindingsParsed.data;
  const roles = new Map(policy.roles.map(value => [value.id, value]));
  const derive = (binding: PolicyBinding): DelegatedRule[] => binding.roles.flatMap(roleId => (roles.get(roleId) ?? invalid()).permissions.map(item => Object.freeze({
    id: `${binding.id}/${roleId}/${item.id}`, effect: item.effect, actions: item.actions, scopes: binding.scopes, resource: item.resource,
    ...(item.modeEligible === undefined ? {} : { modeEligible: item.modeEligible }) })));
  const grants = [...policy.grants], entries = [...bindings.bindings];
  const touched: DelegatedRule[] = [];
  const counts = { grantsAdded: 0, grantsRemoved: 0, bindingsAdded: 0, bindingsRemoved: 0 };
  let removal = false;
  let rolesAdded = 0;
  const at = <T extends { readonly id: string }>(list: readonly T[], id: string) => { const index = list.findIndex(value => value.id === id); return index < 0 ? invalid() : index; };
  for (const item of change.data.changes) {
    if (item.kind === 'role.add') {
      if (roles.has(item.role.id)) invalid();
      roles.set(item.role.id, item.role); rolesAdded++;
    } else if (item.kind === 'grant.add') {
      if (grants.some(value => value.id === item.grant.id)) invalid();
      grants.push(item.grant); touched.push(rule(item.grant)); counts.grantsAdded++;
    } else if (item.kind === 'grant.remove' || item.kind === 'grant.replace') {
      const index = at(grants, item.kind === 'grant.remove' ? item.id : item.grant.id);
      touched.push(rule(grants[index]!)); counts.grantsRemoved++; removal = true;
      if (item.kind === 'grant.remove') grants.splice(index, 1);
      else { grants[index] = item.grant; touched.push(rule(item.grant)); counts.grantsAdded++; }
    } else if (item.kind === 'binding.add') {
      if (entries.some(value => value.id === item.binding.id)) invalid();
      entries.push(item.binding); touched.push(...derive(item.binding)); counts.bindingsAdded++;
    } else {
      const index = at(entries, item.kind === 'binding.remove' ? item.id : item.binding.id);
      touched.push(...derive(entries[index]!)); counts.bindingsRemoved++; removal = true;
      if (item.kind === 'binding.remove') entries.splice(index, 1);
      else { entries[index] = item.binding; touched.push(...derive(item.binding)); counts.bindingsAdded++; }
    }
  }
  const policyBody = omit(policy, ['revision']) as Body<RolePolicyFile>, bindingsBody = omit(bindings, ['revision']) as Body<BindingsFile>;
  const nextPolicy = counts.grantsAdded + counts.grantsRemoved + rolesAdded > 0 ? Object.freeze({ ...policyBody, roles: Object.freeze([...roles.values()]), grants: Object.freeze(grants) }) : null;
  const nextBindings = counts.bindingsAdded + counts.bindingsRemoved > 0 ? Object.freeze({ ...bindingsBody, bindings: Object.freeze(entries) }) : null;
  // New, unbound roles can be published first before removing/replacing bindings. Grant revocations retain I8's order.
  if (rolesAdded && counts.grantsRemoved) invalid();
  const order = removal && !rolesAdded ? 'bindings-first' as const : 'policy-first' as const;
  validSnapshot(planned(nextPolicy ?? policyBody), planned(nextBindings ?? bindingsBody));
  // A profile cannot remove the last installation-wide owner root. Existing roles stay immutable.
  const owner = (binding: PolicyBinding) => binding.roles.includes(INSTALLATION_OWNER_ROLE_ID) && binding.scopes === 'all';
  if (change.data.schemaVersion === 2 && bindings.bindings.some(owner) && !entries.some(owner)) invalid();
  if (nextPolicy && nextBindings) validSnapshot(planned(order === 'policy-first' ? nextPolicy : policyBody), planned(order === 'policy-first' ? bindingsBody : nextBindings));
  return Object.freeze({ policy: nextPolicy, bindings: nextBindings, order, touched: Object.freeze(touched), counts: Object.freeze(counts) });
}

/**
 * The owner root's permissions: every resource kind the caller names (the Core vocabulary, plus registered extension kinds) with every
 * action on every id — "the whole catalog" as data (U2 form). Kind matching lives in `kindCovers` only: if the owner decides the joker
 * kind (S2 = U1), `kindCovers` accepts `'all'`, this list becomes one permission, and the bound below is unchanged.
 */
export function installationOwnerPermissions(kinds: readonly string[]) {
  return Object.freeze([...new Set(kinds)].map(kind => Object.freeze({ id: `all-${kind}`, effect: 'allow' as const, actions: 'all' as const,
    resource: Object.freeze({ kind, ids: 'all' as const }) })));
}
/** Whether a rule of `ruleKind` reaches resources of `kind`. Today: exact kind (no joker kind exists in policy v2). */
export function kindCovers(ruleKind: string, kind: string): boolean { return ruleKind === kind; }

export type DelegationVerdict = { readonly ok: true } | { readonly ok: false; readonly ruleId: string; readonly reason: 'deny' | 'require-approval' | 'no-grant' | 'mode-eligible' };
const ALL: unique symbol = Symbol('all');
type Cell = string | typeof ALL;
const cells = (selection: Selection): readonly Cell[] => selection === 'all' ? [ALL] : selection;
const covers = (selection: Selection, value: Cell) => selection === 'all' || (value !== ALL && selection.includes(value));
const meets = (selection: Selection, value: Cell) => selection === 'all' || value === ALL || selection.includes(value);

/**
 * The delegation bound (I2): every touched rule must lie inside the actor's own authority, cell by cell (action × id × scope; an
 * `'all'` dimension is one indivisible cell), decided in the evaluator's order over the actor's grants (explicit and role-derived,
 * for exactly this principal) and the restrictions that apply to it: any deny/restriction meeting the cell → `deny`; no allow or
 * require-approval rule covering it → `no-grant`; a require-approval meeting it keeps the cell at require-approval, so an `allow` rule
 * there → `require-approval`; `modeEligible` only where the actor's cell is allow or every meeting require-approval is eligible.
 * Removals pass the same bound (a principal revokes only what it could grant; its own deny can never be lifted this way). The owner
 * root is not special: its role is data and a restriction binds it too. Cost is bounded (`POLICY_CHANGE_TOO_LARGE`).
 */
export function delegationWithin(input: Policy, actor: { readonly issuer: string; readonly subject: string }, touched: readonly DelegatedRule[]): DelegationVerdict {
  const policy = policySchema.parse(input);
  let total = 0;
  for (const value of touched) total += cells(value.actions).length * cells(value.resource.ids).length * cells(value.scopes).length;
  if (total > DELEGATION_CELL_LIMIT) throw new PolicyChangeError('POLICY_CHANGE_TOO_LARGE');
  const own = (value: { readonly principals: 'all' | readonly { readonly issuer: string; readonly subject: string }[] }) => value.principals === 'all'
    || value.principals.some(item => item.issuer === actor.issuer && item.subject === actor.subject);
  const grants = principalGrants(policy, actor).filter(value => own(value) && !(value.effect === 'allow' && value.principals === 'all' && isMcpPrincipal(actor)));
  const denies = [...grants.filter(value => value.effect === 'deny'), ...policy.restrictions.filter(own)];
  const asks = grants.filter(value => value.effect === 'require-approval'), allows = grants.filter(value => value.effect === 'allow');
  for (const value of touched) {
    for (const action of cells(value.actions)) for (const id of cells(value.resource.ids)) for (const scope of cells(value.scopes)) {
      const hit = (other: { readonly actions: Selection; readonly scopes: Selection; readonly resource: { readonly kind: string; readonly ids: Selection } },
        test: (selection: Selection, cell: Cell) => boolean) => kindCovers(other.resource.kind, value.resource.kind) && test(other.actions, action)
          && test(other.resource.ids, id) && test(other.scopes, scope);
      const refuse = (reason: 'deny' | 'require-approval' | 'no-grant' | 'mode-eligible') => Object.freeze({ ok: false as const, ruleId: value.id, reason });
      if (denies.some(other => hit(other, meets))) return refuse('deny');
      if (![...asks, ...allows].some(other => hit(other, covers))) return refuse('no-grant');
      const asked = asks.filter(other => hit(other, meets));
      const allowed = asked.length === 0 && allows.some(other => hit(other, covers));
      if (value.effect === 'allow' && !allowed) return refuse('require-approval');
      if (value.modeEligible === true && !allowed && !asked.every(other => other.modeEligible === true)) return refuse('mode-eligible');
    }
  }
  return Object.freeze({ ok: true as const });
}

/** The policy.json and bindings.json documents a resolved v2 snapshot was built from (the inverse of `resolvePolicyBindings`). */
export function authorityDocuments(input: Policy): { readonly policy: unknown; readonly bindings: unknown } {
  const policy = policySchema.parse(input);
  if (policy.schemaVersion === 1) throw new PolicyChangeError('POLICY_ADMINISTER_UNSUPPORTED');
  const { bindings, policyRevision } = policy;
  return Object.freeze({ policy: { ...omit(policy, ['bindings', 'policyRevision', 'revision']), revision: policyRevision }, bindings: bindings.modes === undefined
    ? { schemaVersion: 1, revision: bindings.revision, bindings: bindings.entries } : { schemaVersion: 2, revision: bindings.revision, bindings: bindings.entries, modes: bindings.modes } });
}
