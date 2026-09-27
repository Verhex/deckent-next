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
  identity: { readonly issuer: string; readonly subject: string }, scopeIds: readonly string[], access: ScopeAccess): Promise<readonly string[]> {
  return resolvePolicyScopeMembership(document, identity, scopeIds, config.company.id, configuredScopeRegistry(config), access);
}

/**
 * First-start registration (solo: no user step). Under the caller's endpoint custody, after the ledger upgrade: pins the configured
 * company and the installation's own scopes — the service identity scope, the runtime loop scopes and every scope the trusted policy
 * names. An unavailable policy registers the configured scopes only (a start does not require a policy). A missing ledger is not
 * created; the next start registers.
 *
 * H34 S3 Q1 (owner 2026-09-27 evening decision 6): a start never proceeds while one of these own scopes is already pinned to another
 * company — every loop and governed shutdown would otherwise fail closed on each page with no way to recover short of editing the
 * ledger by hand. The read-only precheck runs before any write, so a start that refuses here leaves the ledger byte-identical (no
 * `companies` row, no scope pin); `registerLedgerScopes`'s own `pinnedElsewhere` is kept as a narrow backstop for the admission race
 * (a declared-scope admission from another process does not hold this start's endpoint guard and could pin a scope in the gap between
 * the precheck and the write). The refusal never names the other company (Astra 2122/2123 non-disclosure extends to start).
 */
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
  return registration;
}
