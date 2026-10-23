import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import { encodeCommandProjection } from '#domain/core/command/index.js';
import { AgentCatalogError } from './contract.js';
import limits from './limits.json' with { type: 'json' };

/**
 * S8-5 signer keys (S8-DESIGN §8, owner 2026-10-23 "imzalayarak"). A signer row names one Ed25519 public key (SPKI DER, base64) of one scope: an
 * `action` key bound to exactly one AI/system principal, or an `import`/`publish`/`hub` key that vouches for content. Only a person adds or revokes a
 * row (a floor in versioned code, whatever a grant says). Host custody: the private key is generated and kept by the host signer service and never
 * leaves it; external custody: a remote principal holds its own key and the row only attributes. Revoked is final; rows are never deleted.
 */
export const SIGNER_PURPOSES = ['action', 'import', 'publish', 'hub'] as const;
/** Fixed, versioned domain-separation labels: every signature covers `deckent-sig/<label>\n` + canonical bytes, never accepted under another label. */
export const SIGNATURE_LABELS = Object.freeze({ catalogAction: 'catalog-action:1', skill: 'skill-signature:1', skillV2: 'skill-signature:2', package: 'package-signature:1',
  revocationFeed: 'revocation-feed:1', hubKeyHandover: 'hub-key-handover:1', publisherKeyRotation: 'publisher-key-rotation:1', hubKeyDelegation: 'hub-key-delegation:1',
  hubModeratorRoster: 'hub-moderator-roster:1', hubProfile: 'hub-profile:1', hubKeyProof: 'hub-key-proof:1', hubModerationLog: 'hub-moderation-log:1' } as const);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly();
const person = z.object({ issuer: identitySchema, subject: identitySchema, ai: z.literal(false) }).strict().readonly();
const label = z.string().min(1).refine(value => value.trim() === value && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  && new TextEncoder().encode(value).length <= limits.nameMaxBytes);
export const signerPublicKeySchema = z.string().regex(/^[A-Za-z0-9+/]{59}=$/); // 44 bytes of SPKI DER
export const signerKeySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, keyId: digest, algorithm: z.literal('ed25519'), publicKey: signerPublicKeySchema,
  purpose: z.enum(SIGNER_PURPOSES), boundPrincipal: ref.nullable(), custody: z.enum(['host', 'external']), label, state: z.enum(['active', 'revoked']),
  addedBy: person, atMs: counterSchema, commandId: identitySchema, revision: counterSchema.positive(),
  revoked: z.object({ by: person, atMs: counterSchema, commandId: identitySchema, basis: z.enum(['person-card', 'revocation-log']) }).strict().readonly().optional() }).strict()
  .refine(row => (row.purpose === 'action') === (row.boundPrincipal !== null) && (row.custody === 'external' || row.purpose === 'action')
    && (row.state === 'revoked') === (row.revoked !== undefined) && row.revision === (row.revoked ? 2 : 1)).readonly();
export type SignerKey = z.infer<typeof signerKeySchema>;
export type SignerPurpose = typeof SIGNER_PURPOSES[number];
type Actor = { readonly issuer: string; readonly subject: string; readonly ai: boolean };
const refuse = (actor: Actor) => { if (actor.ai) throw new AgentCatalogError('SKILL_SIGNER_REFUSED'); return { issuer: actor.issuer, subject: actor.subject, ai: false as const }; };

/** A person enrols (host) or registers (external) one key; an AI principal is refused whatever it is granted (N22). An action key is never bound to the person adding it. */
export function addSignerKey(input: { readonly scopeId: string; readonly keyId: string; readonly publicKey: string; readonly purpose: SignerPurpose; readonly boundPrincipal: z.infer<typeof ref> | null;
  readonly custody: 'host' | 'external'; readonly label: string; readonly actor: Actor; readonly atMs: number; readonly commandId: string }): SignerKey {
  const addedBy = refuse(input.actor), bound = input.boundPrincipal;
  if (bound && bound.issuer === addedBy.issuer && bound.subject === addedBy.subject) throw new AgentCatalogError('SKILL_SIGNER_INVALID');
  const row = signerKeySchema.safeParse({ schemaVersion: 1, scopeId: input.scopeId, keyId: input.keyId, algorithm: 'ed25519', publicKey: input.publicKey, purpose: input.purpose,
    boundPrincipal: bound ? { issuer: bound.issuer, subject: bound.subject } : null, custody: input.custody, label: input.label, state: 'active', addedBy, atMs: input.atMs, commandId: input.commandId, revision: 1 });
  if (!row.success) throw new AgentCatalogError('SKILL_SIGNER_INVALID');
  return row.data;
}
/** The one revoke step, for a person's card and for the startup re-revocation from the append-only log (same code). Already revoked: null (nothing to do). */
export function revokeSignerKey(row: SignerKey, input: { readonly actor: Actor; readonly atMs: number; readonly commandId: string; readonly basis: 'person-card' | 'revocation-log' }): SignerKey | null {
  const by = refuse(input.actor);
  if (row.state === 'revoked') return null;
  return signerKeySchema.parse({ ...row, state: 'revoked', revision: 2, revoked: { by, atMs: input.atMs, commandId: input.commandId, basis: input.basis } });
}
/** Write-time key check of a signed AI/system action, run inside the catalog write transaction: known, active, the right purpose, bound to the caller. */
export function requireActionSigner(row: SignerKey | null, scopeId: string, principal: { readonly issuer: string; readonly subject: string }, purpose: SignerPurpose = 'action'): SignerKey {
  if (!row || row.scopeId !== scopeId) throw new AgentCatalogError('CATALOG_SIGNER_UNKNOWN');
  if (row.state !== 'active') throw new AgentCatalogError('CATALOG_SIGNER_REVOKED');
  if (row.purpose !== purpose || (purpose === 'action' && (row.boundPrincipal?.issuer !== principal.issuer || row.boundPrincipal.subject !== principal.subject))) throw new AgentCatalogError('CATALOG_SIGNER_MISMATCH');
  return row;
}

export const CATALOG_ACTIONS = ['define', 'import', 'promote', 'demote', 'restore', 'retire', 'dismiss', 'suggest', 'narrow'] as const;
/** `catalog-action:1`: the exact command a signature covers — built by the application from the typed command, never by the model (S8-3: a WorkClass or
 * lesson-audience suggestion names its `work-class` target). */
export const catalogActionSchema = z.object({ scopeId: identitySchema, action: z.enum(CATALOG_ACTIONS),
  target: z.object({ kind: z.enum(['agent', 'skill', 'work-class']), id: identitySchema, revision: counterSchema.positive(), workClass: identitySchema.optional() }).strict(),
  expectedRevision: counterSchema.positive().nullable(), contentDigest: digest.nullable(), toStanding: identitySchema.nullable(), suggestionId: digest.nullable(),
  commandId: identitySchema, principal: ref }).strict().readonly();
export type CatalogAction = z.infer<typeof catalogActionSchema>;
export const catalogActionBytes = (action: CatalogAction) => encodeCommandProjection(SIGNATURE_LABELS.catalogAction, catalogActionSchema.parse(action));
/** The signature an AI/system catalog write carries (`signature`: base64 of 64 bytes). */
export const catalogSignatureSchema = z.object({ keyId: digest, signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict().readonly();
export type CatalogSignature = z.infer<typeof catalogSignatureSchema>;
