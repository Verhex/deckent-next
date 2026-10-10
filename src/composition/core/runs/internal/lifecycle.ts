import { type ConfigLoadOptions } from '#platform/index.js';
import { openLocalIntegrityAuthority, openSqliteAttemptStore, openSqliteInventoryReader } from '#adapters/index.js';
import { AuditApplication, DispatchPolicyAuthorization, RunLifecycleApplication, runLifecycleCommandSchema, runProgressionParkCommandSchema, RunPolicyAuthorization, projectRunView, runQuerySchema, type RunQuery } from '#engine/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
/** Local human decisions and bounded lifecycle maintenance use existing policy cells; MCP never exposes decisions. */
export const applyConfiguredRunLifecycle = (root: string, command: unknown, options: ConfigLoadOptions = {}) => applyLifecycle(root, command, options, false);
export const parkConfiguredRunProgression = (root: string, command: unknown, options: ConfigLoadOptions = {}) => applyLifecycle(root, command, options, 'park');
export const advanceConfiguredRunLifecycle = (root: string, query: RunQuery, options: ConfigLoadOptions = {}) => applyLifecycle(root, query, options, true);
async function applyLifecycle(projectRoot: string, input: unknown, options: ConfigLoadOptions, maintain: boolean | 'park') {
  try {
    const command = maintain === 'park' ? runProgressionParkCommandSchema.parse(input) : maintain ? runQuerySchema.parse(input) : runLifecycleCommandSchema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredScopeContext(projectRoot, command.scopeId, options, 'write');
    const verifier = { async verify() { return principal; } }, authorization = new RunPolicyAuthorization({ async load() { return document; } });
    const store = await openSqliteInventoryReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs }); try {
      const integrity = maintain === true ? null : await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
      const policy = new DispatchPolicyAuthorization({ async load() { return document; } });
      const app = new RunLifecycleApplication({ loadRun: (scope, run) => store.loadRun(scope, run), hasTaskEvaluation: (identity, revision) => store.hasTaskEvaluation(identity, revision),
        loadRunReceipt: (scope, commandId) => store.loadRunReceipt(scope, commandId),
        async commitRunLifecycle(write, audit) {
          const writer = await openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
          try { return await writer.commitRunLifecycle(write, audit); } finally { writer.close(); }
        } }, verifier, authorization,
        { authorize: (identity, actor) => policy.authorizeIdentity('evaluate', identity, actor) }, audit => new AuditApplication(audit, integrity!),
        Date.now, config.runRuntime.parking.timeoutMs, document.revision);
      const receipt = maintain === 'park' ? await app.parkProgression(command) : maintain ? await app.advance(command) : await app.execute(command);
      if (!receipt) return null;
      return Object.freeze({ schemaVersion: 1 as const, layout, lifecycle: { schemaVersion: 1 as const, commandId: receipt.commandId, run: projectRunView(receipt.snapshot) } });
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
