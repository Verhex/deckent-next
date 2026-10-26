import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import { isAiPrincipal, isMcpPrincipal, isWorkloadPrincipalRef } from '#domain/core/principal/index.js';

/** The principal classes that may spend a connection (S3-DESIGN §10, owner Q-H3 2026-10-23): the person who connected it, an AI/MCP actor, a system workload. */
export const DELEGATION_PRINCIPAL_CLASSES = Object.freeze(['person', 'ai', 'system'] as const);
export type DelegationPrincipalClass = typeof DELEGATION_PRINCIPAL_CLASSES[number];
/**
 * The connection's delegated-use consent (S3-DESIGN §10, SIWC3): explicit, recorded and revocable, written only by the person through the connect
 * path (S3-3), on the invocation profile's adapter definition as `delegatedUse`. `classes` names who besides the person may spend it.
 */
export const delegatedUseConsentSchema = z.object({ consentedBy: z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly(), atMs: counterSchema,
  classes: z.array(z.enum(['ai', 'system'])).min(1).max(2).readonly() }).strict().readonly();
export type DelegatedUseConsent = z.infer<typeof delegatedUseConsentSchema>;
/** The consent an invocation profile's adapter definition carries (`null`: none, or not an object). Read only; the shape is checked by the rule. */
export function delegatedUseOf(definition: unknown): unknown {
  return definition !== null && typeof definition === 'object' && !Array.isArray(definition) ? (definition as { delegatedUse?: unknown }).delegatedUse ?? null : null;
}
/**
 * Pure (owner Q-H3 2026-10-23: background roles and AI/MCP planning use the subscription only after one explicit, revocable connection consent):
 * a subscription channel is spent by an AI or system principal only under the connection owner's consent naming its class. `owner` is the person
 * the workload acts for; consent by another person is refused in every class (SIWC1). Metered and local channels need no consent; an unknown
 * billing is never assumed metered for a non-person (fail closed). The person who connected it is the login owner and is never refused here.
 */
export function subscriptionDelegationRefusal(input: Readonly<{ billing: string | null; principalClass: DelegationPrincipalClass; owner: Readonly<{ issuer: string; subject: string }>;
  consent: unknown }>): 'HEADLESS_DELEGATION_REFUSED' | null {
  if (input.principalClass === 'person' || input.billing === 'metered' || input.billing === 'local') return null;
  const consent = delegatedUseConsentSchema.safeParse(input.consent);
  if (input.billing !== 'subscription' || !consent.success || consent.data.consentedBy.issuer !== input.owner.issuer || consent.data.consentedBy.subject !== input.owner.subject
    || !consent.data.classes.includes(input.principalClass)) return 'HEADLESS_DELEGATION_REFUSED';
  return null;
}
/** Who spends (owner Q-H3): a verified os-user person, a composition-root workload (recovery, evaluator, auditor, ...) or any other AI actor (MCP, token). */
export function delegationPrincipalClass(actor: Readonly<{ issuer: string; assurance?: string }>): DelegationPrincipalClass {
  return !isAiPrincipal(actor) ? 'person' : isWorkloadPrincipalRef(actor) && !isMcpPrincipal(actor) ? 'system' : 'ai';
}
/** The person an actor acts for: a workload or MCP identity's issuer without its suffix (same subject); anyone else is their own. */
export function delegationOwner(actor: Readonly<{ issuer: string; subject: string }>): Readonly<{ issuer: string; subject: string }> {
  return Object.freeze({ issuer: isWorkloadPrincipalRef(actor) ? actor.issuer.slice(0, actor.issuer.lastIndexOf('/')) : actor.issuer, subject: actor.subject });
}

/** Connected-app-only subscription use. Feature provenance is supplied by trusted composition, never the wire command. */
export function subscriptionRawUseRefusal(input: Readonly<{ entry: 'raw' | 'feature'; principalClass: DelegationPrincipalClass; rawUse: unknown }>): 'SUBSCRIPTION_RAW_USE_REFUSED' | null {
  return input.entry === 'raw' && input.principalClass !== 'person' && input.rawUse === 'person' ? 'SUBSCRIPTION_RAW_USE_REFUSED' : null;
}

/** One owner for revocable subscription feature consent; an absent choice preserves an existing person's choice. */
export function subscriptionConsent(existing: { readonly [key: string]: unknown } | null | undefined, classes: readonly ('ai' | 'system')[] | undefined,
  by: Readonly<{ issuer: string; subject: string }>, atMs: number): DelegatedUseConsent | null {
  const kept = delegatedUseConsentSchema.safeParse(existing?.['delegatedUse']), current = kept.success ? kept.data : null;
  if (classes === undefined) return current;
  const wanted = [...new Set(classes)].sort();
  if (!wanted.length) return null;
  return current && current.consentedBy.issuer === by.issuer && current.consentedBy.subject === by.subject && JSON.stringify([...current.classes].sort()) === JSON.stringify(wanted)
    ? current : { consentedBy: { issuer: by.issuer, subject: by.subject }, atMs, classes: wanted };
}
