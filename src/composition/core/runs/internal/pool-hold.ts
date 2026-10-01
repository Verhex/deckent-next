import { AuditApplication, ExecutionPoolHoldApplication, PoolControlPolicyAuthorization, poolHoldCommandSchema, poolHoldQuerySchema } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteAttemptStore } from '#adapters/index.js';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** K5 typed pool hold: hold/resume (write, sealed audit) and status (read) for CLI, MCP and SDK through one engine application. Not a
 * runtime-service operation: the service sees the hold in the ledger at every reservation (`RUN_POOL_HELD` → a quiet `waiting` turn). */
export async function applyConfiguredPoolHold(projectRoot: string, input: unknown, options: ConfigLoadOptions = {}) { return poolHold(projectRoot, input, options, 'write'); }
export async function inspectConfiguredPoolHold(projectRoot: string, input: unknown, options: ConfigLoadOptions = {}) { return poolHold(projectRoot, input, options, 'read'); }
async function poolHold(projectRoot: string, input: unknown, options: ConfigLoadOptions, access: 'read' | 'write') {
  try {
    const parsed = access === 'write' ? poolHoldCommandSchema.parse(input) : poolHoldQuerySchema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredScopeContext(projectRoot, parsed.scopeId, options, access);
    const integrity = access === 'write' ? await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true) : null, clock = new SystemTrustedClock();
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
    try {
      const application = new ExecutionPoolHoldApplication({ async verify() { return principal; } }, new PoolControlPolicyAuthorization({ async load() { return document; } }),
        store, audit => new AuditApplication(audit, integrity!), () => clock.sample().wallMs, config.admission?.poolId ?? null);
      return await (access === 'write' ? application.apply(parsed) : application.inspect(parsed));
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
