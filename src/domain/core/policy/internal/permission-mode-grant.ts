import { isMcpPrincipal } from '#domain/core/principal/index.js';
import { identitySchema } from '#domain/core/primitives/index.js';
import { evaluatePolicy, matchingRuleIds, type PolicyDecision } from './evaluate.js';
import { anchorsPerson, namesPerson, policyNamedPeople } from './first-run-template.js';
import { PERMISSION_MODES, policyFileSchema, policyGrantSchema, resolvePolicyBindings, type PermissionMode, type PolicyGrant } from './schema.js';
import { policyResources } from './vocabulary.js';

/**
 * PRE-9 SOLO-MOD-IZNI (owner 2026-10-21, law audit AUDIT-PRE9-LAW): the installation owner opens `full-auto` / `full-access` for a person with
 * `deckent init policy --scope <id> --modes <set>`. A mode is opened by one managed rule (`permission-mode`/`set` on exactly that mode, that
 * scope, that person alone); the plan and its result are the **effective** decision before and after the change (ARCHITECTURE.md:16:
 * managed-rule presence and effective permission are separate): a mode another rule already allows adds nothing, a closed managed rule that
 * leaves the mode open names the rules that still allow it, and a deny/approval rule that still decides refuses the whole plan. Pure; the
 * installer (file owner + authority witness) writes it through the authority documents' one conditional writer.
 */
export type OpenablePermissionMode = Exclude<PermissionMode, 'standart'>;
export const OPENABLE_PERMISSION_MODES: readonly OpenablePermissionMode[] = Object.freeze(PERMISSION_MODES.filter((mode): mode is OpenablePermissionMode => mode !== 'standart'));
/** Not a template rule id (the first-run template never writes it): the installer's managed rule for one mode. */
export const INSTALLER_PERMISSION_MODE_RULE_PREFIX = 'installer-permission-mode-';
/** Version 1 of the installer's permission-mode change: the authority write key and the `authority-change` audit `commandId` start with it. */
export const INSTALLER_PERMISSION_MODES_COMMAND_PREFIX = 'installer-permission-modes-v1-';
export const installerPermissionModeRuleId = (mode: OpenablePermissionMode): string => `${INSTALLER_PERMISSION_MODE_RULE_PREFIX}${mode}`;

type Person = { readonly issuer: string; readonly subject: string };
type Effect = PolicyDecision['decision'];
/** One mode of the plan: wanted or not, the effective decision before and after, what happens to its managed rule, the other rules that allow
 * it after the change (never the managed one) and, when it is still not allowed, the rule that decides (null: no rule grants it). */
export interface PermissionModeGrantState {
  readonly mode: OpenablePermissionMode; readonly wanted: boolean; readonly before: Effect; readonly after: Effect;
  readonly managed: 'added' | 'removed' | 'held' | 'none' | 'conflict'; readonly others: readonly string[]; readonly blockedBy: string | null;
}
export type PermissionModeGrantPlan =
  | { readonly status: 'plan' | 'current'; readonly basis: 'first-run' | 'named-person'; readonly modes: readonly PermissionModeGrantState[]; readonly added: readonly PolicyGrant[];
    readonly removed: readonly string[]; readonly conflicts: readonly string[]; readonly policy: unknown }
  | { readonly status: 'refused'; readonly reason: 'policy-refused' | 'rule-conflict'; readonly basis: 'first-run' | 'named-person'; readonly modes: readonly PermissionModeGrantState[];
    readonly conflicts: readonly string[] }
  | { readonly status: 'unavailable'; readonly reason: 'not-first-run' | 'not-this-person' | 'person-not-named' | 'invalid'; readonly people: readonly Person[] };

/**
 * The plan for `modes` (the wanted set of opened modes; `[]` closes both) over the raw policy and bindings documents. `explicit`: the person was
 * named with `--person` (the same rules as `init policy --upgrade --person`): a first-run policy's read rule must name the person in this scope;
 * a hand-built policy needs an explicitly named person who is already named on an allow rule of the scope (else the refusal lists who is).
 * The MCP actor is never planned for.
 */
export function planInstallerPermissionModes(policyDocument: unknown, bindingsDocument: unknown, input: { readonly person: Person; readonly explicit: boolean;
  readonly scopeId: string; readonly modes: readonly string[]; readonly peopleLimit: number }): PermissionModeGrantPlan {
  const unavailable = (reason: Extract<PermissionModeGrantPlan, { status: 'unavailable' }>['reason'], people: readonly Person[] = []) => Object.freeze({ status: 'unavailable' as const, reason, people });
  const parsed = policyFileSchema.safeParse(policyDocument), scope = identitySchema.safeParse(input.scopeId);
  const issuer = identitySchema.safeParse(input.person.issuer), subject = identitySchema.safeParse(input.person.subject);
  const wanted = new Set(input.modes);
  if (!parsed.success || parsed.data.schemaVersion !== 2 || !scope.success || !issuer.success || !subject.success || wanted.size !== input.modes.length
    || input.modes.some(mode => !OPENABLE_PERMISSION_MODES.includes(mode as OpenablePermissionMode))) return unavailable('invalid');
  const person = { issuer: issuer.data, subject: subject.data }, scopeId = scope.data, grants = parsed.data.grants;
  const read = grants.find(grant => grant.id === 'first-run-read-tools' && grant.scopes !== 'all');
  const people = () => policyNamedPeople(parsed.data, scopeId, input.peopleLimit);
  let basis: 'first-run' | 'named-person';
  if (read) {
    if (isMcpPrincipal(person) || !namesPerson(read, person) || read.scopes === 'all' || !read.scopes.includes(scopeId)) return unavailable('not-this-person');
    basis = 'first-run';
  } else {
    if (!input.explicit) return unavailable('not-first-run', people());
    if (isMcpPrincipal(person) || !grants.some(grant => anchorsPerson(grant, person, scopeId))) return unavailable('person-not-named', people());
    basis = 'named-person';
  }
  const raw = policyDocument as { readonly grants: readonly unknown[] };
  let current;
  try { current = resolvePolicyBindings(policyDocument, bindingsDocument); } catch { return unavailable('invalid'); }
  const principal = { id: 'installer-plan', ...person, assurance: 'os-user' as const, scopeIds: [scopeId] };
  const request = (mode: OpenablePermissionMode) => ({ principal, scopeId, action: policyResources.permissionMode.actions[0], resource: { kind: policyResources.permissionMode.kind, id: mode } });
  const rule = (mode: OpenablePermissionMode): PolicyGrant => policyGrantSchema.parse({ id: installerPermissionModeRuleId(mode), effect: 'allow', actions: [policyResources.permissionMode.actions[0]],
    scopes: [scopeId], principals: [person], resource: { kind: policyResources.permissionMode.kind, ids: [mode] } });
  const same = (held: PolicyGrant, want: PolicyGrant) => JSON.stringify(policyGrantSchema.parse(held)) === JSON.stringify(want);
  const added: PolicyGrant[] = [], removed: string[] = [], conflicts: string[] = [];
  const managed = new Map<OpenablePermissionMode, PermissionModeGrantState['managed']>();
  for (const mode of OPENABLE_PERMISSION_MODES) {
    const want = rule(mode), held = grants.find(grant => grant.id === want.id), open = wanted.has(mode);
    if (held && !same(held, want)) { conflicts.push(want.id); managed.set(mode, 'conflict'); continue; }
    if (open && held) managed.set(mode, 'held');
    // A mode another rule already allows is open: nothing is added (the managed rule would only duplicate it).
    else if (open && evaluatePolicy(current, request(mode)).decision !== 'allow') { added.push(want); managed.set(mode, 'added'); }
    else if (!open && held) { removed.push(want.id); managed.set(mode, 'removed'); }
    else managed.set(mode, 'none');
  }
  const next = { ...raw, grants: [...raw.grants.filter(grant => !removed.includes((grant as { readonly id?: unknown }).id as string)), ...added] };
  const after = resolvePolicyBindings(next, bindingsDocument);
  const modes = OPENABLE_PERMISSION_MODES.map(mode => {
    const decided = evaluatePolicy(after, request(mode));
    return Object.freeze({ mode, wanted: wanted.has(mode), before: evaluatePolicy(current, request(mode)).decision, after: decided.decision, managed: managed.get(mode)!,
      others: Object.freeze(matchingRuleIds(after, request(mode), 'allow').filter(id => id !== installerPermissionModeRuleId(mode) || managed.get(mode) === 'conflict')),
      blockedBy: decided.decision === 'allow' ? null : decided.ruleId ?? null });
  });
  // A wanted mode that is still not allowed after the change (a deny, a restriction, an approval rule, or a same-id rule it cannot replace) refuses the whole plan.
  const blocked = modes.filter(state => state.wanted && state.after !== 'allow');
  if (blocked.length) return Object.freeze({ status: 'refused' as const, reason: blocked.some(state => state.managed === 'conflict') ? 'rule-conflict' as const : 'policy-refused' as const,
    basis, modes: Object.freeze(modes), conflicts: Object.freeze(conflicts) });
  return Object.freeze({ status: added.length || removed.length ? 'plan' as const : 'current' as const, basis, modes: Object.freeze(modes), added: Object.freeze(added),
    removed: Object.freeze(removed), conflicts: Object.freeze(conflicts), policy: next });
}
