import { userInfo } from 'node:os';
import { inspectProductFile, ManagedFileError, type ResolvedConfig } from '#platform/index.js';
import { readScopeCompanies, registerLedgerScopes } from '#adapters/index.js';
import { policySchema } from '#domain/index.js';
import { installationOwnScopes, resolvePolicyScopeMembership, ScopeRegistrationError, type ScopeAccess, type ScopeRegistry } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
async function existingLedger(config: ResolvedConfig): Promise<string | null> {
  try { return await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']); }
  catch (error) { if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') return null; throw error; }
}
/** Read-only lookup; only first write admission inserts pins. Missing ledgers stay absent. */
function configuredScopeRegistry(config: ResolvedConfig): ScopeRegistry {
  return {
    async pinnedCompanies(scopeIds) {
      const path = await existingLedger(config);
      return path ? readScopeCompanies(path, config.storage.sqlite.busyTimeoutMs, scopeIds) : new Map();
    },
    async pinDeclared(scopeIds, companyId) {
      const path = await existingLedger(config);
      return path ? registerLedgerScopes(path, config.storage.sqlite, companyId, scopeIds, 'admission').pins : null;
    },
  };
}
/** H34 S1: all entry points share trusted grants plus durable company pins at first write admission. */
export async function resolveConfiguredScopeMembership(config: ResolvedConfig, document: unknown,
  identity: { readonly issuer: string; readonly subject: string }, scopeIds: readonly string[], access: ScopeAccess): Promise<readonly string[]> {
  return resolvePolicyScopeMembership(document, identity, scopeIds, config.company.id, configuredScopeRegistry(config), access);
}
/** Under endpoint custody after upgrade, register configured company/service/loop and trusted policy scopes.
 * Missing policy uses configured scopes; missing ledger stays absent. H34 S3 Q1 (owner 2026-09-27):
 * foreign pins refuse start before any write (ledger byte-identical), preventing unusable loops/shutdown.
 * Recheck registration pins for admissions racing outside endpoint custody; never name the foreign company
 * (Astra 2122/2123). The registry retains its transaction-level race backstop. */
export async function registerConfiguredScopesAtStart(config: ResolvedConfig) {
  const path = await existingLedger(config);
  if (!path) return null;
  const policy: unknown = await createLayoutPolicySource(config.productLayout, userInfo().uid, config.inspection.policyMaxBytes).load()
    .then(document => policySchema.parse(document)).catch(() => null);
  const scopes = installationOwnScopes(policy, [...(config.service.identity ? [config.service.identity.scopeId] : []),
    ...(config.cancellationRuntime?.scopeIds ?? []), ...(config.reconciliationRuntime?.scopeIds ?? [])]);
  const refuseIfForeign = (pins: ReadonlyMap<string, string>) => {
    const foreign = scopes.filter(scope => { const pin = pins.get(scope); return pin !== undefined && pin !== config.company.id; });
    if (foreign.length) throw new ScopeRegistrationError('RUNTIME_SERVICE_SCOPE_FOREIGN', foreign);
  };
  refuseIfForeign(readScopeCompanies(path, config.storage.sqlite.busyTimeoutMs, scopes));
  const registration = registerLedgerScopes(path, config.storage.sqlite, config.company.id, scopes);
  refuseIfForeign(registration.pins);
  // Keep policy-declared scopes separate from configured loop-only pins; registration grants no recovery authority.
  return Object.freeze({ ...registration, policyScopeIds: installationOwnScopes(policy, []) });
}
