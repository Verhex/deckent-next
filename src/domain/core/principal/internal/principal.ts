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

/**
 * S4B-1 (owner S-M1/S-M2 2026-10-23, S4B-DESIGN §5 A1): the memory distiller's workload identity, issued only by the composition root (no
 * client channel names it; same auditor/OG5 precedent). Its floor is an exact allow-list (`MEMORY_DISTILLER_ALLOWED_PAIRS`). A forged `os-user`
 * distiller is still it, and still AI.
 */
export const memoryDistillerPrincipalRef = (owner: { readonly issuer: string; readonly subject: string }) =>
  Object.freeze({ issuer: identitySchema.parse(`${owner.issuer}/memory-distiller`), subject: identitySchema.parse(owner.subject) });
export const isMemoryDistillerPrincipal = (actor: { readonly issuer: string }) => actor.issuer.endsWith('/memory-distiller');
export const memoryDistillerPrincipal = (owner: { readonly issuer: string; readonly subject: string }, scopeIds: readonly string[]): VerifiedPrincipal => {
  const ref = memoryDistillerPrincipalRef(owner);
  return verifiedPrincipalSchema.parse({ id: `${ref.subject}@${ref.issuer}`, ...ref, assurance: 'workload-verified', scopeIds: [...scopeIds] });
};

/**
 * S4B-3 (owner S-M3/S-M4 2026-10-23, S4B-DESIGN §5 A4): the independent memory evaluator's workload identity, issued only by the composition root
 * (same auditor/OG5 precedent). Its floor is the exact allow-list `MEMORY_EVALUATOR_ALLOWED_PAIRS` (V1–V5); it never proposes, so the proposing
 * AI never verifies its own entry. A forged `os-user` evaluator is still it, and still AI.
 */
export const memoryEvaluatorPrincipalRef = (owner: { readonly issuer: string; readonly subject: string }) =>
  Object.freeze({ issuer: identitySchema.parse(`${owner.issuer}/memory-evaluator`), subject: identitySchema.parse(owner.subject) });
export const isMemoryEvaluatorPrincipal = (actor: { readonly issuer: string }) => actor.issuer.endsWith('/memory-evaluator');
export const memoryEvaluatorPrincipal = (owner: { readonly issuer: string; readonly subject: string }, scopeIds: readonly string[]): VerifiedPrincipal => {
  const ref = memoryEvaluatorPrincipalRef(owner);
  return verifiedPrincipalSchema.parse({ id: `${ref.subject}@${ref.issuer}`, ...ref, assurance: 'workload-verified', scopeIds: [...scopeIds] });
};

/**
 * S6R-4 (S6R-DESIGN §9; lead on s6r3 Q4): the recovery system's workload identity, issued only by the composition root (same auditor/OG5
 * precedent). Its floor is the exact allow-list `RECOVERY_ALLOWED_PAIRS`; it never holds a target credential (an effect reconciles under its
 * operation's own identity) and acts only under the owner's standing grant. A forged `os-user` recovery principal is still it, and still AI.
 */
export const recoveryPrincipalRef = (owner: { readonly issuer: string; readonly subject: string }) =>
  Object.freeze({ issuer: identitySchema.parse(`${owner.issuer}/recovery`), subject: identitySchema.parse(owner.subject) });
export const isRecoveryPrincipal = (actor: { readonly issuer: string }) => actor.issuer.endsWith('/recovery');
export const recoveryPrincipal = (owner: { readonly issuer: string; readonly subject: string }, scopeIds: readonly string[]): VerifiedPrincipal => {
  const ref = recoveryPrincipalRef(owner);
  return verifiedPrincipalSchema.parse({ id: `${ref.subject}@${ref.issuer}`, ...ref, assurance: 'workload-verified', scopeIds: [...scopeIds] });
};

/** S8-3 (S8-DESIGN §3, §9): the catalog aggregator's workload identity (composition root only, same precedent); held to `CATALOG_AGGREGATOR_ALLOWED_PAIRS`, it writes only signed. */
export const catalogAggregatorPrincipalRef = (owner: { readonly issuer: string; readonly subject: string }) =>
  Object.freeze({ issuer: identitySchema.parse(`${owner.issuer}/catalog-aggregator`), subject: identitySchema.parse(owner.subject) });
export const isCatalogAggregatorPrincipal = (actor: { readonly issuer: string }) => actor.issuer.endsWith('/catalog-aggregator');
export const catalogAggregatorPrincipal = (owner: { readonly issuer: string; readonly subject: string }, scopeIds: readonly string[]): VerifiedPrincipal => {
  const ref = catalogAggregatorPrincipalRef(owner);
  return verifiedPrincipalSchema.parse({ id: `${ref.subject}@${ref.issuer}`, ...ref, assurance: 'workload-verified', scopeIds: [...scopeIds] });
};
/** A reference that names a non-person actor by its transport identity (MCP, auditor, Nervous, memory distiller or evaluator, recovery, catalog aggregator): never an installing person. */
export const isWorkloadPrincipalRef = (ref: { readonly issuer: string }) => isMcpPrincipal(ref) || isAuditorPrincipal(ref) || isNervousPrincipal(ref) || isMemoryDistillerPrincipal(ref)
  || isMemoryEvaluatorPrincipal(ref) || isRecoveryPrincipal(ref) || isCatalogAggregatorPrincipal(ref);
/** Transport identity dominates assurance: a forged legacy MCP, auditor, Nervous, memory-distiller/evaluator or recovery os-user is still AI. */
export const isAiPrincipal = (actor: { readonly issuer: string; readonly assurance?: string }) => isWorkloadPrincipalRef(actor) || actor.assurance !== 'os-user';
