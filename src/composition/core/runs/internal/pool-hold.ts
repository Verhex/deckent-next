import { AuditApplication, QuotaReleaseApplication, quotaReleaseCommandSchema, ExecutionPoolHoldApplication, ExecutionPoolCapacityApplication, PoolControlPolicyAuthorization, RunPolicyAuthorization, poolHoldCommandSchema, poolCapacityCommandSchema, poolHoldQuerySchema, localRunOffered, localRunFallbackClosed } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteAttemptStore, readIdentityProfileConfig } from '#adapters/index.js';
import { SystemTrustedClock, loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
/** K2/K3: company policy, pool hold and profile posture close the shared offer; an unreadable authority source fails closed. */
export async function configuredLocalRunOffer(root: string, scopeId: string, options: ConfigLoadOptions = {}, code: unknown = 'RUN_ADMISSION_NOT_CONFIGURED'): Promise<boolean> {
  const paused = await loadConfiguredScopeContext(root, scopeId, options, 'read').then(context =>
    new RunPolicyAuthorization({ load: async () => context.document }).creationPaused(scopeId, context.principal)).catch(() => true);
  if (paused) return false;
  const config = await loadConfig(root, { ...options, heal: false }), held = (config['admission'] as { poolId?: unknown } | undefined)?.poolId ? await inspectConfiguredPoolHold(root, { schemaVersion: 1, scopeId }, { ...options, heal: false }).then(view => view.state !== 'open', () => true) : false;
  return localRunOffered(code, { closed: localRunFallbackClosed(readIdentityProfileConfig(config['identity'])?.profile ?? null), paused: held }); }
export async function applyConfiguredPoolHold(root: string, input: unknown, options: ConfigLoadOptions = {}) { return poolControl(root, input, options, poolHoldCommandSchema, true, (hold, _capacity, value) => hold.apply(value)); }
export async function inspectConfiguredPoolHold(root: string, input: unknown, options: ConfigLoadOptions = {}) { return poolControl(root, input, options, poolHoldQuerySchema, false, (hold, _capacity, value) => hold.inspect(value)); }
export async function applyConfiguredPoolCapacity(root: string, input: unknown, options: ConfigLoadOptions = {}) { return poolControl(root, input, options, poolCapacityCommandSchema, true, (_hold, capacity, value) => capacity.apply(value)); }
export async function inspectConfiguredPoolCapacity(root: string, input: unknown, options: ConfigLoadOptions = {}) { return poolControl(root, input, options, poolHoldQuerySchema, false, (_hold, capacity, value) => capacity.inspect(value)); }
export async function releaseConfiguredQuota(root: string, input: unknown, options: ConfigLoadOptions = {}) { return poolControl(root, input, options, quotaReleaseCommandSchema, true, (_hold, _capacity, value, quota) => quota.apply(value)); }
async function poolControl<T>(root: string, input: unknown, options: ConfigLoadOptions, schema: { parse(input: unknown): { scopeId: string } }, write: boolean,
  use: (hold: ExecutionPoolHoldApplication, capacity: ExecutionPoolCapacityApplication, input: unknown, quota: QuotaReleaseApplication) => Promise<T>) {
  try {
    const parsed = schema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredScopeContext(root, parsed.scopeId, options, write ? 'write' : 'read');
    const integrity = write ? await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true) : null, clock = new SystemTrustedClock();
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
    try {
      const args = [{ async verify() { return principal; } }, new PoolControlPolicyAuthorization({ async load() { return document; } }),
        store, (audit: import('#engine/index.js').AuditStore) => new AuditApplication(audit, integrity!), () => clock.sample().wallMs, config.admission?.poolId ?? null] as const;
      return await use(new ExecutionPoolHoldApplication(...args), new ExecutionPoolCapacityApplication(...args), parsed, new QuotaReleaseApplication(...args));
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
