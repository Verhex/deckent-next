import { isAiPrincipal, AgentCatalogError, AGENT_CATALOG_LIMITS, type CatalogAction, type CatalogSignature, type VerifiedPrincipal } from '#domain/index.js';
import type { AgentCatalogDependencies, AgentCatalogStore, SignedCatalogAction } from './contract.js';

/**
 * S8-5 (S8-DESIGN §8): the one signing step of every AI/system catalog write. A person's card carries no signature (one given is refused); an AI/system
 * principal signs with the `signed` its external key made (exactly one action) or through the host signer service with its own enrolled, active key —
 * only the `catalog-action:1` bytes the application built, never bytes a model chose. The append-only revocation log is checked first, so a key revoked
 * there (after a restore) or a broken log refuses before any signing; the store reads the key state again in its commit transaction.
 */
export async function signCatalogActions(deps: Pick<AgentCatalogDependencies, 'custody' | 'revocations'>, store: AgentCatalogStore, principal: VerifiedPrincipal, scopeId: string,
  actions: readonly CatalogAction[], external?: CatalogSignature): Promise<SignedCatalogAction[]> {
  if (!isAiPrincipal(principal)) { if (external) throw new AgentCatalogError('CATALOG_SIGNATURE_INVALID'); return []; }
  if (external && actions.length !== 1) throw new AgentCatalogError('CATALOG_SIGNATURE_INVALID');
  const revoked = deps.revocations ? await deps.revocations.list() : [], rows = await store.signers(scopeId, AGENT_CATALOG_LIMITS.signersPerScopeMax);
  const key = external ? rows.find(row => row.keyId === external.keyId) : rows.find(row => row.purpose === 'action' && row.state === 'active'
    && row.boundPrincipal?.issuer === principal.issuer && row.boundPrincipal.subject === principal.subject);
  if (!key || (!external && (key.custody !== 'host' || !deps.custody))) throw new AgentCatalogError(external ? 'CATALOG_SIGNER_UNKNOWN' : 'CATALOG_SIGNATURE_REQUIRED');
  if (revoked.some(row => row.scopeId === scopeId && row.keyId === key.keyId)) throw new AgentCatalogError('CATALOG_SIGNER_REVOKED');
  const signed: SignedCatalogAction[] = [];
  for (const action of actions) signed.push({ action, keyId: key.keyId, signature: external?.signature ?? await deps.custody!.signAction(key.keyId, action) });
  return signed;
}
/** Whether a host-custody principal could sign now: an active `action` key bound to it, the signer service wired and the revocation log readable. */
export async function canSignCatalogActions(deps: Pick<AgentCatalogDependencies, 'custody' | 'revocations'>, store: AgentCatalogStore, principal: { readonly issuer: string; readonly subject: string },
  scopeId: string): Promise<boolean> {
  if (!deps.custody) return false;
  let revoked;
  try { revoked = deps.revocations ? await deps.revocations.list() : []; } catch { return false; }
  return (await store.signers(scopeId, AGENT_CATALOG_LIMITS.signersPerScopeMax)).some(row => row.purpose === 'action' && row.state === 'active' && row.custody === 'host'
    && row.boundPrincipal?.issuer === principal.issuer && row.boundPrincipal.subject === principal.subject && !revoked.some(entry => entry.scopeId === scopeId && entry.keyId === row.keyId));
}
