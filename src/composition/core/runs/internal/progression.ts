import { sha256, type ConfigLoadOptions } from '#platform/index.js';
import { withLocalPrincipalChannel, readLocalOsIdentity, openSqliteInventoryReader } from '#adapters/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import { runProgressionSession, runProgressionObservation, selectRunProgression, runProgressionMissingPermissions, runProgressionEvaluationUnverified, runProgressionUnreservedCoverage, runProgressionDiagnosticSchema,
  type RunProgressionDiagnostic, type RunQuery } from '#engine/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** Called only after the caller's scope and Run inspect authorization. No admission, migration or stored diagnostic. */
export async function inspectConfiguredRunProgression(root: string, query: RunQuery, revision: number, options: ConfigLoadOptions, caller: VerifiedPrincipal): Promise<RunProgressionDiagnostic | undefined> {
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
        if (run.state.kind === 'terminal' || run.cancelRequested) return undefined;
        const session = runProgressionSession(), observed = runProgressionObservation(identity);
        if (!session || !observed) return runProgressionDiagnosticSchema.parse(current);
        let actorClass: 'ai' | 'person' = 'ai';
        let maintenance = false, disclose = true, selectionReason: string | undefined;
        let effective: Pick<typeof context, 'principal' | 'document'> | undefined = { principal, document };
        try {
          const selected = await selectRunProgression(identity, sha256(ledger), config.company.id, store,
            channel => withLocalPrincipalChannel(channel, readLocalOsIdentity), session);
          maintenance = selected.maintenance; actorClass = selected.channel === 'mcp' ? 'ai' : 'person';
          if (maintenance && selected.channel !== 'mcp') {
            const person = withLocalPrincipalChannel(selected.channel, readLocalOsIdentity);
            disclose = caller.assurance === 'os-user' && caller.id === person.id && caller.issuer === person.issuer && caller.subject === person.subject;
            if (disclose) {
              effective = undefined;
              effective = await withLocalPrincipalChannel(selected.channel, () => loadConfiguredScopeContext(root, query.scopeId, options, 'read'));
            }
          }
        } catch (error) { selectionReason = queryFailure(error).code; }
        const admission = session.admissionState({ ledger: sha256(ledger), companyId: config.company.id, ...identity, commandId: intent.commandId, actor: intent.actor }, run);
        const verified = disclose ? effective : undefined;
        const missing = verified ? runProgressionMissingPermissions(run, verified.principal, verified.document, maintenance) : [];
        const conditional = verified && !missing.length && await runProgressionEvaluationUnverified(run, verified.principal, verified.document, store);
        const coverage = verified && !maintenance && runProgressionUnreservedCoverage(run, verified.principal, verified.document).length > 0;
        const unknownReason = selectionReason && selectionReason !== 'RUN_PROGRESSION_REPROPOSE_REQUIRED' ? selectionReason
          : conditional ? 'RUN_PROGRESSION_EVALUATION_UNVERIFIED'
          : !maintenance && !missing.length && coverage && !observed.suspended && admission === 'eligible' ? 'RUN_PROGRESSION_COVERAGE_UNVERIFIED' : undefined;
        const reason = !disclose ? 'RUN_PROGRESSION_MAINTENANCE_ONLY' : unknownReason ?? missing[0]?.code ?? selectionReason
          ?? (observed.parkUnavailable ? 'RUN_PROGRESSION_PARK_UNAVAILABLE' : observed.suspended ? 'RUN_PROGRESSION_PARKED' : maintenance ? 'RUN_PROGRESSION_MAINTENANCE_ONLY' : 'RUN_PROGRESSION_ELIGIBLE');
        if ((await store.loadRun(query.scopeId, query.runId))?.revision !== revision) return runProgressionDiagnosticSchema.parse({ ...current, reason: 'RUN_STORE_CONFLICT' });
        return runProgressionDiagnosticSchema.parse({ ...current, actorClass,
          ...(verified ? { actor: { id: verified.principal.id, issuer: verified.principal.issuer, subject: verified.principal.subject }, policyRevision: verified.document.revision } : {}),
          session: admission, ...observed, missing: unknownReason ? [] : missing, reason,
          state: unknownReason ? 'unknown' : maintenance ? 'maintenance-only' : missing.length || selectionReason || observed.suspended || run.state.kind !== 'running' || run.cancelRequested ? 'blocked' : 'eligible' });
      } finally { store.close(); }
    });
  } catch (error) { return runProgressionDiagnosticSchema.parse({ ...base, reason: queryFailure(error).code }); }
}
