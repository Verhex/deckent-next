import { randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, identitySchema, type AuditEvent } from '#domain/index.js';
import { executionPoolSchema, type ExecutionPool } from '#engine/core/runs/index.js';
import type { AuditStore } from '#engine/core/audit/index.js';

export interface InstallationPoolResult {
  readonly schemaVersion: 1;
  readonly scopeId: string;
  readonly status: 'preview' | 'created' | 'current' | 'conflict' | 'unavailable';
  readonly configured: ExecutionPool | null;
  readonly stored?: ExecutionPool;
  readonly ledgerVersion?: number;
  readonly reason?: 'not-owner' | 'invalid-admission' | 'invalid-config' | 'ledger-missing' | 'ledger-version' | 'ledger-unavailable' | 'pool-policy';
}
/** Installer-only port: inspect is read-only; provision rechecks and audits before insertion in one transaction. */
export interface InstallationPoolStore {
  inspect(pool: ExecutionPool): Promise<Omit<InstallationPoolResult, 'schemaVersion' | 'scopeId' | 'configured'>>;
  provision(pool: ExecutionPool, audit: (store: AuditStore) => void): Promise<Omit<InstallationPoolResult, 'schemaVersion' | 'scopeId' | 'configured'>>;
}
export function configuredInstallationPool(admission: { readonly poolId?: unknown; readonly executionSlots?: unknown; readonly inFlightSlots?: unknown } | null | undefined): ExecutionPool | null {
  const parsed = executionPoolSchema.safeParse({ schemaVersion: 1, poolId: admission?.poolId,
    capacity: { executionSlots: admission?.executionSlots, inFlightSlots: admission?.inFlightSlots } });
  return parsed.success ? parsed.data : null;
}
export async function installExecutionPool(input: { readonly scopeId: string; readonly owner: boolean; readonly pool: ExecutionPool | null;
  readonly apply: boolean; readonly store: InstallationPoolStore; readonly principal: { readonly issuer: string; readonly subject: string };
  readonly policyRevision: string; readonly now: () => number; readonly record: (store: AuditStore, event: AuditEvent) => void }): Promise<InstallationPoolResult> {
  const scopeId = identitySchema.parse(input.scopeId), base = { schemaVersion: 1 as const, scopeId, configured: input.pool };
  if (!input.owner) return { ...base, status: 'unavailable', reason: 'not-owner' };
  if (!input.pool) return { ...base, status: 'unavailable', reason: 'invalid-admission' };
  const pool = executionPoolSchema.parse(input.pool);
  const result = input.apply ? await input.store.provision(pool, store => input.record(store, {
    schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId, principal: { issuer: input.principal.issuer, subject: input.principal.subject },
    policyRevision: input.policyRevision, atMs: input.now(), subject: { kind: 'installation-pool', installer: { basis: 'file-owner' },
      poolId: pool.poolId, capacity: pool.capacity },
  })) : await input.store.inspect(pool);
  return { ...base, ...result };
}
