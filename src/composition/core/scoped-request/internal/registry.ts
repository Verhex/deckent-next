import { userInfo } from 'node:os';
import { inspectProductFile, ManagedFileError, type ResolvedConfig } from '#platform/index.js';
import { readScopeCompanies, registerLedgerScopes } from '#adapters/index.js';
import { policySchema } from '#domain/index.js';
import { installationOwnScopes, resolvePolicyScopeMembership, type ScopeRegistryReader } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';

async function existingLedger(config: ResolvedConfig): Promise<string | null> {
  try { return await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']); }
  catch (error) { if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') return null; throw error; }
}

/** Ledger-backed registry reader. Read-only; a missing ledger has no pins, and the path is inspected only when a grant exists. */
function configuredScopeRegistry(config: ResolvedConfig): ScopeRegistryReader {
  return { async pinnedCompanies(scopeIds) {
    const path = await existingLedger(config);
    return path ? readScopeCompanies(path, config.storage.sqlite.busyTimeoutMs, scopeIds) : new Map();
  } };
}

/** The one fail-closed membership decision for every scoped entry point (CLI/SDK/MCP, runtime socket peer, inventory, service
 * shutdown): trusted grants, then registration to the configured company (H34 S1). */
export async function resolveConfiguredScopeMembership(config: ResolvedConfig, document: unknown,
  identity: { readonly issuer: string; readonly subject: string }, scopeIds: readonly string[]): Promise<readonly string[]> {
  return resolvePolicyScopeMembership(document, identity, scopeIds, config.company.id, configuredScopeRegistry(config));
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
