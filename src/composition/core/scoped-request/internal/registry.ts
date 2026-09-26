import { userInfo } from 'node:os';
import { inspectProductFile, ManagedFileError, type ResolvedConfig } from '#platform/index.js';
import { readScopeCompanies, registerLedgerScopes } from '#adapters/index.js';
import { policySchema } from '#domain/index.js';
import { installationOwnScopes, resolvePolicyScopeMembership, type ScopeAccess, type ScopeRegistry } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';

async function existingLedger(config: ResolvedConfig): Promise<string | null> {
  try { return await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']); }
  catch (error) { if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') return null; throw error; }
}

/** Ledger-backed registry. Lookups are read-only; only a declared scope's first write admission writes (one insert-only
 * transaction). A missing ledger has no pins and nothing is created: writers need an existing current ledger anyway. */
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

/** The one fail-closed membership decision for every scoped entry point (CLI/SDK/MCP, runtime socket peer, inventory, service
 * shutdown): trusted grants, then a durable pin to the configured company, written at a declared scope's first admission (H34 S1). */
export async function resolveConfiguredScopeMembership(config: ResolvedConfig, document: unknown,
  identity: { readonly issuer: string; readonly subject: string }, scopeIds: readonly string[], access: ScopeAccess = 'write'): Promise<readonly string[]> {
  return resolvePolicyScopeMembership(document, identity, scopeIds, config.company.id, configuredScopeRegistry(config), access);
}

/**
 * First-start registration (solo: no user step). Under the caller's endpoint custody, after the ledger upgrade: pins the configured
 * company and the installation's own scopes — the service identity scope, the runtime loop scopes and every scope the trusted policy
 * names. An unavailable policy registers the configured scopes only (a start does not require a policy). A missing ledger is not
 * created; the next start registers.
 */
export async function registerConfiguredScopesAtStart(config: ResolvedConfig) {
  const path = await existingLedger(config);
  if (!path) return null;
  const policy: unknown = await createLayoutPolicySource(config.productLayout, userInfo().uid, config.inspection.policyMaxBytes).load()
    .then(document => policySchema.parse(document)).catch(() => null);
  const scopes = installationOwnScopes(policy, [...(config.service.identity ? [config.service.identity.scopeId] : []),
    ...(config.cancellationRuntime?.scopeIds ?? []), ...(config.reconciliationRuntime?.scopeIds ?? [])]);
  return registerLedgerScopes(path, config.storage.sqlite, config.company.id, scopes);
}
