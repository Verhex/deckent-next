import { policyChangeSchema, type PolicyChange } from './administer.js';
import { bindingsFileSchema, policyFileSchema, type PolicyBinding, type PolicyGrant } from './schema.js';

/**
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
const text = (value: string) => { const clean = [...value].map(char => unsafe(char.codePointAt(0)!) ? '?' : char).join(''); return clean.length > VALUE_MAX ? `${clean.slice(0, VALUE_MAX - 1)}…` : clean; };
type Selection = 'all' | readonly string[];
const list = (selection: Selection) => selection === 'all' ? '*' : `[${selection.slice(0, LIST_MAX).map(text).join(',')}${selection.length > LIST_MAX ? `,+${selection.length - LIST_MAX}` : ''}]`;
const people = (principals: 'all' | readonly { readonly issuer: string; readonly subject: string }[]) =>
  principals === 'all' ? '*' : list(principals.map(item => `${item.issuer}:${item.subject}`));
const grantText = (grant: PolicyGrant) => `${grant.effect}${grant.modeEligible === true ? '(mode-eligible)' : ''} ${grant.resource.kind}${list(grant.resource.ids)} `
  + `actions${list(grant.actions)} scopes${list(grant.scopes)} principals ${people(grant.principals)}`;
const bindingText = (binding: PolicyBinding) => `roles${list(binding.roles)} principals ${people(binding.principals)} scopes${list(binding.scopes)}`;

export function describePolicyChange(files: { readonly policy: unknown; readonly bindings: unknown }, changeInput: unknown, budget = POLICY_CHANGE_SUMMARY_MAX): string | null {
  const change = policyChangeSchema.safeParse(changeInput), policy = policyFileSchema.safeParse(files.policy), bindings = bindingsFileSchema.safeParse(files.bindings);
  if (!change.success || !policy.success || policy.data.schemaVersion === 1 || !bindings.success) return null;
  const grants = new Map(policy.data.grants.map(item => [item.id, item as PolicyGrant])), entries = new Map(bindings.data.bindings.map(item => [item.id, item]));
  const now = <T>(map: Map<string, T>, id: string, render: (value: T) => string) => { const value = map.get(id); return value === undefined ? '(not found)' : render(value); };
  const lines = change.data.changes.map((item: PolicyChange['changes'][number]) => {
    switch (item.kind) {
      case 'grant.add': return `+ grant ${text(item.grant.id)}: ${grantText(item.grant)}`;
      case 'grant.remove': return `- grant ${text(item.id)}: ${now(grants, item.id, grantText)}`;
      case 'grant.replace': return `~ grant ${text(item.grant.id)}: ${now(grants, item.grant.id, grantText)} → ${grantText(item.grant)}`;
      case 'binding.add': return `+ binding ${text(item.binding.id)}: ${bindingText(item.binding)}`;
      case 'binding.remove': return `- binding ${text(item.id)}: ${now(entries, item.id, bindingText)}`;
      case 'binding.replace': return `~ binding ${text(item.binding.id)}: ${now(entries, item.binding.id, bindingText)} → ${bindingText(item.binding)}`;
    }
  });
  const head = `policy.administer@1 · ${lines.length} change${lines.length === 1 ? '' : 's'}`;
  const more = (count: number) => `\n… +${count} more`;
  let out = head;
  for (const [index, line] of lines.entries()) {
    const left = lines.length - index - 1, next = `${out}\n${line}`;
    if (next.length + (left > 0 ? more(left).length : 0) <= budget) { out = next; continue; }
    // The line does not fit: cut it to the room left (a card always shows what it can), then count the rest.
    const room = budget - out.length - 1 - more(left + 1).length;
    if (room > 16) return `${out}\n${line.slice(0, room - 1)}…${left > 0 ? more(left) : ''}`;
    return `${out}${more(left + 1)}`;
  }
  return out;
}
