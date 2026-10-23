import { ArtifactError } from '#capabilities/index.js';
import { getConfigKnownSecrets, inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { FileArtifactStore, openSqliteInventoryReader, selectWorkTarget } from '#adapters/index.js';
import { DeliverySummaryApplication, RunPolicyAuthorization, queueTicketCommandIds, WorkspacePatchApplication, WorkspacePatchError, deliverySummaryRequestSchema, workspacePatchChangeFacts,
  type DeliverySummary, type DeliverySummaryRequest } from '#engine/index.js';
import { contextDispatchAuthorization } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/**
 * TESLIM-KARTI-OZET (alpha.53 A3): the DeliverySummary of each delivery card, read in this process under the person's own grants (Run inspect,
 * Attempt read-output) with one scope context and ledger reader per scope. The git workspace adapter fills `change` from the retained patch and
 * its K6 scope. A card whose Run is absent or not inspectable gets null. Nothing is written; the result is a view, never authority.
 */
export async function describeConfiguredDeliverySummaries(root: string, input: readonly DeliverySummaryRequest[], options: ConfigLoadOptions = {}): Promise<readonly (DeliverySummary | null)[]> {
  try {
    // REVISE 2734 R4: one bad card (an invalid request, a failed read or projection) shows "not available" alone; it never blanks the batch.
    const requests = input.map(raw => { const parsed = deliverySummaryRequestSchema.safeParse(raw); if (!parsed.success) return null;
      const { ticketCommandId, ...request } = parsed.data;
      return ticketCommandId === undefined || request.verificationRunId !== null ? request : { ...request, verificationRunId: queueTicketCommandIds(request.identity.scopeId, ticketCommandId).verificationRun }; });
    const out: (DeliverySummary | null)[] = requests.map(() => null);
    for (const scopeId of new Set(requests.flatMap(request => request ? [request.identity.scopeId] : []))) {
      const c = await loadConfiguredScopeContext(root, scopeId, options, 'read');
      const reader = await openSqliteInventoryReader(await c.path(), { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
      try {
        const attempts = contextDispatchAuthorization(c), artifacts = new FileArtifactStore({ root: await inspectProductDirectory(c.layout, 'artifacts'), maxBytes: c.config.artifacts.maxBytes });
        const patches = new WorkspacePatchApplication(reader, artifacts, { async verify() { return c.principal; } }, attempts, c.config.artifacts.maxBytes, selectWorkTarget(c.config.execution)?.scope?.mode ?? 'warn');
        // REVISE 2734 R3: the same scope config snapshot's known secrets mask every card string (the shadow path already carries them).
        const app = new DeliverySummaryApplication({ store: reader, artifacts, runs: new RunPolicyAuthorization({ async load() { return c.document; } }), attempts, known: getConfigKnownSecrets(c.config),
          // No retained patch (or an unreadable one) is no change evidence; a policy refusal stays a refusal (the application shows it as withheld).
          change: async identity => { try { const { patch, scope } = await patches.preview(identity); return workspacePatchChangeFacts(patch, scope); }
            catch (error) { if (error instanceof WorkspacePatchError || error instanceof ArtifactError) return null; throw error; } } });
        for (const [index, request] of requests.entries()) {
          if (request?.identity.scopeId !== scopeId) continue;
          out[index] = await app.describe(request, c.principal).catch(() => null);
        }
      } finally { reader.close(); }
    }
    return Object.freeze(out);
  } catch (error) { throw queryFailure(error); }
}
