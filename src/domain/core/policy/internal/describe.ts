import { isMcpPrincipal, isWorkloadPrincipalRef } from '#domain/core/principal/index.js';
import { policyChangeSchema, type PolicyChange } from './administer.js';
import { bindingsFileSchema, policyFileSchema, policyGrantSchema, type PolicyBinding, type PolicyFile, type PolicyGrant } from './schema.js';

/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17).
 * The human-readable, bounded, redacted diff of a `policy.administer@1` change set — what an approval card shows the decider instead of
 * a hex digest (POLICY-HARDEN, owner M3 "full diff"). Pure. One line per change (`+` added, `-` removed with the rule as it is now,
 * `~` replaced: old → new), rules in a fixed notation; free text never comes from the input (every field is a typed identifier or
 * selection), yet each value is stripped of control and bidirectional-formatting characters and cut, so a card cannot be spoofed or
 * flooded. Longer than `budget` characters: the remaining changes are counted, never silently dropped.
 */
export const POLICY_CHANGE_SUMMARY_MAX = 2048;
const VALUE_MAX = 48, LIST_MAX = 6;
/** Control (C0/C1), invisible and bidirectional-formatting code points: none of them can reach a card. */
const unsafe = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xad || code === 0x61c || code === 0x180e || (code >= 0x200b && code <= 0x200f)
  || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2060 && code <= 0x206f) || code === 0xfeff;
const cut = (value: string, length: number) => { let out = ''; for (const char of value) { if (out.length + char.length > length) break; out += char; } return out; };
const text = (value: string) => { const clean = [...value].map(char => unsafe(char.codePointAt(0)!) ? '?' : char); return clean.length > VALUE_MAX ? `${clean.slice(0, VALUE_MAX - 1).join('')}…` : clean.join(''); };
type Selection = 'all' | readonly string[];
const list = (selection: Selection) => selection === 'all' ? '*' : `[${selection.slice(0, LIST_MAX).map(text).join(',')}${selection.length > LIST_MAX ? `,+${selection.length - LIST_MAX}` : ''}]`;
const people = (principals: 'all' | readonly { readonly issuer: string; readonly subject: string }[]) =>
  principals === 'all' ? '*' : list(principals.map(item => `${item.issuer}:${item.subject}`));
const grantText = (grant: PolicyGrant) => `${grant.effect}${grant.modeEligible === true ? '(mode-eligible)' : ''} ${grant.resource.kind}${list(grant.resource.ids)} `
  + `actions${list(grant.actions)} scopes${list(grant.scopes)} principals ${people(grant.principals)}`;
const bindingText = (binding: PolicyBinding) => `roles${list(binding.roles)} principals ${people(binding.principals)} scopes${list(binding.scopes)}`;

type Change = PolicyChange['changes'][number];
type Role = Extract<PolicyFile, { schemaVersion: 2 }>['roles'][number];
type DescriptionBudget = { readonly budget: number; readonly elision: (count: number) => string };
const subset = (next: Selection, old: Selection) => old === 'all' || (next !== 'all' && next.every(value => old.includes(value)));
const namesAi = (principals: PolicyGrant['principals']) => principals === 'all' || principals.some(isWorkloadPrincipalRef);
const samePerson = (a: { readonly issuer: string; readonly subject: string }, b: { readonly issuer: string; readonly subject: string }) => a.issuer === b.issuer && a.subject === b.subject;
// Universal allow rules exclude MCP identities; universal approval rules still reach them.
const peopleWithin = (next: PolicyGrant['principals'], old: PolicyGrant['principals'], oldAllows = false, nextAllows = false) => next === 'all'
  ? old === 'all' && (!oldAllows || nextAllows)
  : next.every(person => old === 'all' ? !(oldAllows && isMcpPrincipal(person)) : old.some(value => samePerson(person, value)));
const grantWithin = (next: PolicyGrant, old: PolicyGrant) => old.effect !== 'deny' && (old.effect === 'allow' || next.effect === 'require-approval'
  && (next.modeEligible !== true || old.modeEligible === true)) && next.resource.kind === old.resource.kind && subset(next.resource.ids, old.resource.ids)
  && subset(next.actions, old.actions) && subset(next.scopes, old.scopes) && peopleWithin(next.principals, old.principals, old.effect === 'allow', next.effect === 'allow');

/** Presentation order only: evaluate against submitted-order snapshots, never reorder the actual changes. */
function changeLines(changes: readonly Change[], oldGrants: readonly PolicyGrant[], oldBindings: readonly PolicyBinding[], oldRoles: readonly Role[]): string[] {
  const grants = new Map(oldGrants.map(item => [item.id, item])), entries = new Map(oldBindings.map(item => [item.id, item]));
  const roles = new Map([...oldRoles, ...changes.flatMap(item => item.kind === 'role.add' ? [item.role] : [])].map(role => [role.id, role]));
  const aiBindings = [...oldBindings, ...changes.flatMap(item => item.kind === 'binding.add' || item.kind === 'binding.replace' ? [item.binding] : [])].filter(binding => namesAi(binding.principals));
  const positiveRole = (id: string) => roles.get(id)?.permissions.some(permission => permission.effect !== 'deny') ?? true;
  const first = (item: Change): boolean => {
    if (item.kind === 'grant.add' || item.kind === 'grant.replace') {
      const next = item.grant, old = grants.get(next.id);
      return next.effect !== 'deny' && namesAi(next.principals) && !(item.kind === 'grant.replace' && old && grantWithin(next, old));
    }
    if (item.kind === 'role.add') return positiveRole(item.role.id) && aiBindings.some(binding => binding.roles.includes(item.role.id));
    if (item.kind === 'binding.add' || item.kind === 'binding.replace') {
      const next = item.binding, old = entries.get(next.id);
      if (!namesAi(next.principals) || !next.roles.some(positiveRole)) return false;
      // Unknown roles and mixed deny replacements cannot prove narrowing from the available binding facts.
      const narrowing = old && subset(next.roles, old.roles) && subset(next.scopes, old.scopes) && peopleWithin(next.principals, old.principals)
        && [...next.roles, ...old.roles].every(id => roles.get(id)?.permissions.every(permission => permission.effect !== 'deny'));
      return item.kind === 'binding.replace' ? !narrowing : next.roles.some(positiveRole);
    }
    return false;
  };
  const now = <T>(map: Map<string, T>, id: string, render: (value: T) => string) => { const value = map.get(id); return value === undefined ? '(not found)' : render(value); };
  const prioritized: string[] = [], rest: string[] = [];
  for (const item of changes) {
    const target = first(item) ? prioritized : rest;
    const line = (() => {
      switch (item.kind) {
        case 'role.add': return `+ role ${text(item.role.id)}: ${item.role.permissions.map(permission => `${text(permission.id)} ${permission.effect} ${text(permission.resource.kind)}${list(permission.resource.ids)} actions${list(permission.actions)}`).join('; ')}`;
        case 'grant.add': return `+ grant ${text(item.grant.id)}: ${grantText(item.grant)}`;
        case 'grant.remove': return `- grant ${text(item.id)}: ${now(grants, item.id, grantText)}`;
        case 'grant.replace': return `~ grant ${text(item.grant.id)}: ${now(grants, item.grant.id, grantText)} → ${grantText(item.grant)}`;
        case 'binding.add': return `+ binding ${text(item.binding.id)}: ${bindingText(item.binding)}`;
        case 'binding.remove': return `- binding ${text(item.id)}: ${now(entries, item.id, bindingText)}`;
        case 'binding.replace': return `~ binding ${text(item.binding.id)}: ${now(entries, item.binding.id, bindingText)} → ${bindingText(item.binding)}`;
      }
    })();
    target.push(line);
    if (item.kind === 'grant.add' || item.kind === 'grant.replace') grants.set(item.grant.id, item.grant);
    else if (item.kind === 'grant.remove') grants.delete(item.id);
    else if (item.kind === 'binding.add' || item.kind === 'binding.replace') entries.set(item.binding.id, item.binding);
    else if (item.kind === 'binding.remove') entries.delete(item.id);
  }
  return [...prioritized, ...rest];
}

/** Installer additions use the same line producer and ordering, including whole-policy plans larger than POLICY_CHANGE_MAX. */
export function describePolicyGrants(input: readonly unknown[]): string | null {
  const parsed = policyGrantSchema.array().safeParse(input);
  return parsed.success ? changeLines(parsed.data.map(grant => ({ kind: 'grant.add', grant })), [], [], []).join('\n') : null;
}

/** Without a card budget this is the complete preview; the validated request still bounds its change count. */
export function describePolicyChange(files: { readonly policy: unknown; readonly bindings: unknown }, changeInput: unknown, options?: DescriptionBudget): string | null {
  const change = policyChangeSchema.safeParse(changeInput), policy = policyFileSchema.safeParse(files.policy), bindings = bindingsFileSchema.safeParse(files.bindings);
  if (!change.success || !policy.success || policy.data.schemaVersion === 1 || !bindings.success) return null;
  const lines = changeLines(change.data.changes, policy.data.grants, bindings.data.bindings, policy.data.roles);
  const head = `policy.administer@1 · ${lines.length} change${lines.length === 1 ? '' : 's'}`;
  const complete = [head, ...lines].join('\n');
  if (!options || complete.length <= options.budget) return complete;
  const { budget, elision } = options;
  const more = (count: number) => `\n${elision(count)}`;
  let out = head;
  for (const [index, line] of lines.entries()) {
    const left = lines.length - index - 1, next = `${out}\n${line}`;
    if (next.length + (left > 0 ? more(left).length : 0) <= budget) { out = next; continue; }
    // A partially shown line is included in the count of changes not shown in full.
    const notice = more(left + 1), room = budget - out.length - 1 - notice.length;
    if (room > 16) return `${out}\n${cut(line, room - 1)}…${notice}`;
    if (out.length + notice.length <= budget) return `${out}${notice}`;
    return notice.length - 1 <= budget ? notice.slice(1) : '';
  }
  return out;
}
