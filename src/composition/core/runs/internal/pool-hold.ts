import { AuditApplication, ExecutionPoolHoldApplication, PoolControlPolicyAuthorization, poolHoldCommandSchema, poolHoldQuerySchema } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteAttemptStore } from '#adapters/index.js';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** K5 typed pool hold: hold/resume (write, sealed audit) and status (read) for CLI, MCP and SDK through one engine application. Not a
 * runtime-service operation: the service sees the hold in the ledger at every reservation (`RUN_POOL_HELD` → a quiet `waiting` turn). */
export async function applyConfiguredPoolHold(projectRoot: string, input: unknown, options: ConfigLoadOptions = {}) { return poolHold(projectRoot, input, options, true, (app, value) => app.apply(value)); }
export async function inspectConfiguredPoolHold(projectRoot: string, input: unknown, options: ConfigLoadOptions = {}) { return poolHold(projectRoot, input, options, false, (app, value) => app.inspect(value)); }
async function poolHold<T>(projectRoot: string, input: unknown, options: ConfigLoadOptions, write: boolean, use: (app: ExecutionPoolHoldApplication, value: unknown) => Promise<T>) {
  try {
    const parsed = (write ? poolHoldCommandSchema : poolHoldQuerySchema).parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredScopeContext(projectRoot, parsed.scopeId, options, write ? 'write' : 'read');
    const integrity = write ? await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true) : null, clock = new SystemTrustedClock();
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
    try {
      return await use(new ExecutionPoolHoldApplication({ async verify() { return principal; } }, new PoolControlPolicyAuthorization({ async load() { return document; } }),
        store, audit => new AuditApplication(audit, integrity!), () => clock.sample().wallMs, config.admission?.poolId ?? null), parsed);
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
