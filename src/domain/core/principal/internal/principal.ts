import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';

/** A verifier result, never an accepted client-authored identity claim. */
export const verifiedPrincipalSchema = z.object({
  id: identitySchema, issuer: identitySchema, subject: identitySchema,
  assurance: z.enum(['os-user', 'token-verified', 'workload-verified']),
  scopeIds: z.array(identitySchema).min(1).readonly(),
}).strict().readonly();
export type VerifiedPrincipal = z.infer<typeof verifiedPrincipalSchema>;

/** MCP is a separate local actor, never an alias for the terminal owner. */
export const mcpPrincipalRef = (owner: { readonly issuer: string; readonly subject: string }) =>
  Object.freeze({ issuer: identitySchema.parse(`${owner.issuer}/mcp`), subject: identitySchema.parse(owner.subject) });
export const isMcpPrincipal = (actor: { readonly issuer: string }) => actor.issuer.endsWith('/mcp');

/**
 * S5 (AUDITOR-MODEL, owner 2026-10-17 Q4): the read-only auditor, a workload identity only the composition root issues (no client channel
 * names it; a new principal kind waits for OG5). Its issuer suffix is the identity: a forged `os-user` auditor is still the auditor.
 */
export const auditorPrincipalRef = (owner: { readonly issuer: string; readonly subject: string }) =>
  Object.freeze({ issuer: identitySchema.parse(`${owner.issuer}/auditor`), subject: identitySchema.parse(owner.subject) });
export const isAuditorPrincipal = (actor: { readonly issuer: string }) => actor.issuer.endsWith('/auditor');
export const auditorPrincipal = (owner: { readonly issuer: string; readonly subject: string }, scopeIds: readonly string[]): VerifiedPrincipal => {
  const ref = auditorPrincipalRef(owner);
  return verifiedPrincipalSchema.parse({ id: `${ref.subject}@${ref.issuer}`, ...ref, assurance: 'workload-verified', scopeIds: [...scopeIds] });
};

/**
 * S6 Nervous (K-B, owner 2026-10-23): the deterministic violation watcher's workload identity, issued only by the composition root (no client
 * channel names it). It reads and proposes; its only write is its own sealed `recovery-detection` record. A forged `os-user` Nervous is still it.
 */
export const nervousPrincipalRef = (owner: { readonly issuer: string; readonly subject: string }) =>
  Object.freeze({ issuer: identitySchema.parse(`${owner.issuer}/nervous`), subject: identitySchema.parse(owner.subject) });
export const isNervousPrincipal = (actor: { readonly issuer: string }) => actor.issuer.endsWith('/nervous');

/** Transport identity dominates assurance: a forged legacy MCP, auditor or Nervous os-user is still AI. */
export const isAiPrincipal = (actor: { readonly issuer: string; readonly assurance?: string }) =>
  isMcpPrincipal(actor) || isAuditorPrincipal(actor) || isNervousPrincipal(actor) || actor.assurance !== 'os-user';
