import { z } from 'zod';
import data from './rebind-classes.json' with { type: 'json' };
import { includes, principalGrants, type Policy, type PolicyRule } from './schema.js';

/** Versioned code vocabulary, never a policy overlay target. */
export const rebindClasses = z.strictObject({ schemaVersion: z.literal(1),
  classes: z.tuple([z.literal('device-only'), z.literal('moved')]).readonly(),
  open: z.tuple([z.literal('device-only')]).readonly(), delegable: z.tuple([z.literal('moved')]).readonly() }).readonly().parse(data);
export const REBIND_CLASS = Object.freeze({ deviceOnly: rebindClasses.classes[0], moved: rebindClasses.classes[1] });
export type RebindClass = typeof rebindClasses.classes[number];

/** Scope-free bootstrap permission: only a direct, named, installation-wide grant allows; every matching refusal wins. */
export function explicitRebindGrant(policy: Policy, actor: { readonly issuer: string; readonly subject: string }, change: RebindClass) {
  if (!rebindClasses.delegable.some(value => value === change)) return null;
  const names = (rule: PolicyRule) => rule.principals === 'all' || rule.principals.some(person => person.issuer === actor.issuer && person.subject === actor.subject);
  const targets = (rule: PolicyRule) => names(rule) && includes(rule.actions, 'rebind')
    && rule.resource.kind === 'installation' && includes(rule.resource.ids, change);
  if (policy.restrictions.some(targets) || principalGrants(policy, actor).some(rule => rule.effect !== 'allow' && targets(rule))) return null;
  const grant = policy.grants.find(rule => rule.effect === 'allow' && names(rule) && rule.principals !== 'all'
    && rule.actions !== 'all' && rule.actions.includes('rebind') && rule.resource.kind === 'installation'
    && rule.resource.ids !== 'all' && rule.resource.ids.includes(change) && rule.scopes === 'all');
  return grant ? { ruleId: grant.id, policyRevision: policy.revision } : null;
}
