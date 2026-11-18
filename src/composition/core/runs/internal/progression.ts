import { sha256, type ConfigLoadOptions } from '#platform/index.js';
import { withLocalPrincipalChannel, readLocalOsIdentity, openSqliteInventoryReader } from '#adapters/index.js';
import { runProgressionSession, runProgressionObservation, selectRunProgression, runProgressionMissingPermissions, runProgressionDiagnosticSchema,
  type RunProgressionDiagnostic, type RunQuery } from '#engine/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** Called only after the caller's scope and Run inspect authorization. No admission, migration or stored diagnostic. */
export async function inspectConfiguredRunProgression(root: string, query: RunQuery, revision: number, options: ConfigLoadOptions): Promise<RunProgressionDiagnostic | undefined> {
  const observedAtMs = Date.now();
  const base = { ...query, revision, observedAtMs, validUntilMs: observedAtMs,
    state: 'unknown' as const, actorClass: 'ai' as const, reason: 'RUN_PROGRESSION_SESSION_UNVERIFIED', session: 'unknown' as const, suspended: false, parkUnavailable: false, missing: [] };
  const { schemaVersion: _version, ...identity } = query; void _version;
  try {
    return await withLocalPrincipalChannel('mcp', async () => {
      const context = await loadConfiguredScopeContext(root, query.scopeId, options, 'read');
      const { config, principal, document, path } = context, ledger = await path();
      const current = { ...base, validUntilMs: observedAtMs + config.runRuntime.failureBackoffMs };
      const store = await openSqliteInventoryReader(ledger, { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
      try {
        const intent = store.readRunProgressionIntent(query.scopeId, query.runId, config.company.id);
        const local = readLocalOsIdentity();
        if (!intent || intent.actor.id !== local.id || intent.actor.issuer !== local.issuer || intent.actor.subject !== local.subject) return undefined;
        const run = await store.loadRun(query.scopeId, query.runId);
        if (!run || run.revision !== revision) return runProgressionDiagnosticSchema.parse({ ...current, reason: 'RUN_STORE_CONFLICT' });
        const session = runProgressionSession(), observed = runProgressionObservation(identity);
        if (!session || !observed) return runProgressionDiagnosticSchema.parse(current);
        let actorClass: 'ai' | 'person' = 'ai';
        let maintenance = false, selectionReason: string | undefined, effective = { principal, document };
        try {
          const selected = await selectRunProgression(identity, sha256(ledger), config.company.id, store,
            channel => withLocalPrincipalChannel(channel, readLocalOsIdentity), session);
          maintenance = selected.maintenance; actorClass = selected.channel === 'mcp' ? 'ai' : 'person';
          if (maintenance && selected.channel !== 'mcp') effective = await withLocalPrincipalChannel(selected.channel, () => loadConfiguredScopeContext(root, query.scopeId, options, 'read'));
        } catch (error) { selectionReason = queryFailure(error).code; }
        const admission = session.admissionState({ ledger: sha256(ledger), companyId: config.company.id, ...identity, commandId: intent.commandId, actor: intent.actor }, run);
        const missing = runProgressionMissingPermissions(run, effective.principal, effective.document, maintenance);
        const unknown = selectionReason && selectionReason !== 'RUN_PROGRESSION_REPROPOSE_REQUIRED';
        const reason = unknown ? selectionReason : missing[0]?.code ?? selectionReason
          ?? (observed.parkUnavailable ? 'RUN_PROGRESSION_PARK_UNAVAILABLE' : observed.suspended ? 'RUN_PROGRESSION_PARKED' : maintenance ? 'RUN_PROGRESSION_MAINTENANCE_ONLY' : 'RUN_PROGRESSION_ELIGIBLE');
        if ((await store.loadRun(query.scopeId, query.runId))?.revision !== revision) return runProgressionDiagnosticSchema.parse({ ...current, reason: 'RUN_STORE_CONFLICT' });
        return runProgressionDiagnosticSchema.parse({ ...current, actorClass, actor: { id: effective.principal.id, issuer: effective.principal.issuer, subject: effective.principal.subject }, policyRevision: effective.document.revision, session: admission, ...observed, missing: unknown ? [] : missing, reason,
          state: unknown ? 'unknown' : maintenance ? 'maintenance-only' : missing.length || selectionReason || observed.suspended || run.state.kind !== 'running' || run.cancelRequested ? 'blocked' : 'eligible' });
      } finally { store.close(); }
    });
  } catch (error) { return runProgressionDiagnosticSchema.parse({ ...base, reason: queryFailure(error).code }); }
}
