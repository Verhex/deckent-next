import { AuditApplication, ExecutionPoolHoldApplication, ExecutionPoolCapacityApplication, PoolControlPolicyAuthorization, poolHoldCommandSchema, poolCapacityCommandSchema, poolHoldQuerySchema } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteAttemptStore } from '#adapters/index.js';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
export async function applyConfiguredPoolHold(root: string, input: unknown, options: ConfigLoadOptions = {}) { return poolControl(root, input, options, poolHoldCommandSchema, true, (hold, _capacity, value) => hold.apply(value)); }
export async function inspectConfiguredPoolHold(root: string, input: unknown, options: ConfigLoadOptions = {}) { return poolControl(root, input, options, poolHoldQuerySchema, false, (hold, _capacity, value) => hold.inspect(value)); }
export async function applyConfiguredPoolCapacity(root: string, input: unknown, options: ConfigLoadOptions = {}) { return poolControl(root, input, options, poolCapacityCommandSchema, true, (_hold, capacity, value) => capacity.apply(value)); }
export async function inspectConfiguredPoolCapacity(root: string, input: unknown, options: ConfigLoadOptions = {}) { return poolControl(root, input, options, poolHoldQuerySchema, false, (_hold, capacity, value) => capacity.inspect(value)); }
async function poolControl<T>(root: string, input: unknown, options: ConfigLoadOptions, schema: { parse(input: unknown): { scopeId: string } }, write: boolean,
  use: (hold: ExecutionPoolHoldApplication, capacity: ExecutionPoolCapacityApplication, input: unknown) => Promise<T>) {
  try {
    const parsed = schema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredScopeContext(root, parsed.scopeId, options, write ? 'write' : 'read');
    const integrity = write ? await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true) : null, clock = new SystemTrustedClock();
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
    try {
      const args = [{ async verify() { return principal; } }, new PoolControlPolicyAuthorization({ async load() { return document; } }),
        store, (audit: import('#engine/index.js').AuditStore) => new AuditApplication(audit, integrity!), () => clock.sample().wallMs, config.admission?.poolId ?? null] as const;
      return await use(new ExecutionPoolHoldApplication(...args), new ExecutionPoolCapacityApplication(...args), parsed);
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
