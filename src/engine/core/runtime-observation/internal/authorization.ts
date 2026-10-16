import type { VerifiedPrincipal } from '#domain/index.js';
import { authorizeApproval } from '#engine/core/approval/index.js';
import { RunPolicyAuthorization, DispatchPolicyAuthorization, ProviderSpendAccountPolicyAuthorization, ModelActivationPolicyAuthorization,
  ModelCatalogPolicyAuthorization, ModelInvocationPolicyAuthorization } from '#engine/core/policy/index.js';
import { authorizeRuntimeEventsInventory, type RuntimeEventsSelection, type RuntimeObservationRow } from '#engine/core/runtime/index.js';
const denied = (error: unknown) => error instanceof Error && 'code' in error && ['POLICY_DENIED', 'POLICY_APPROVAL_UNSUPPORTED', 'APPROVAL_DENIED'].includes(String(error.code));
/** Collection gates precede opening any private source; exact-record gates only narrow admission. */
export async function authorizeRuntimeObservationTopics(query: RuntimeEventsSelection, document: unknown, principal: VerifiedPrincipal) {
  const source = { load: async () => document }, dispatch = new DispatchPolicyAuthorization(source);
  // These are collection gates. Record selectors below remain mandatory and can only narrow them.
  for (const topic of query.topics) {
    if (topic === 'run' || topic === 'worker') await dispatch.authorizeScopeReadOutput(query.scopeId, principal);
    if (topic === 'approval') authorizeApproval(document, 'inspect', query.scopeId, query.scopeId, principal);
    if (topic === 'inventory') {
      authorizeRuntimeEventsInventory(document, query.scopeId, principal);
    }
  }
 }
export function runtimeObservationRecordAuthorizer(query: RuntimeEventsSelection, document: unknown, principal: VerifiedPrincipal) {
  const source = { load: async () => document }, dispatch = new DispatchPolicyAuthorization(source);
  return async (row: RuntimeObservationRow) => {
      try {
        const record = row.record;
        if (record.topic === 'run') {
          await new RunPolicyAuthorization(source).authorize('inspect', { scopeId: query.scopeId, runId: record.runId ?? record.id }, principal);
        }
        if (row.identity) {
          if (row.identity.scopeId !== query.scopeId) return false;
          await dispatch.authorizeIdentity('read-output', row.identity, principal);
          await new RunPolicyAuthorization(source).authorize('inspect', { scopeId: query.scopeId, runId: row.identity.runId }, principal);
        }
        if (record.topic === 'approval') authorizeApproval(document, 'inspect', query.scopeId, record.id, principal);
        if (row.budgetId) await new ProviderSpendAccountPolicyAuthorization(source).authorize('inspect', { scopeId: query.scopeId, budgetId: row.budgetId, budgetRevision: record.revision }, principal);
        if (row.reference) {
          if (record.topic === 'usage') await new ModelInvocationPolicyAuthorization(source).authorize('inspect', { scopeId: query.scopeId, reference: row.reference }, principal);
          else await new ModelActivationPolicyAuthorization(source).authorize('inspect', { scopeId: query.scopeId, reference: row.reference }, principal);
        }
        if (row.catalogTarget) await new ModelCatalogPolicyAuthorization(source).authorize('inspect', query.scopeId, row.catalogTarget, principal, 'scope');
        return true;
      } catch (error) { if (denied(error)) return false; throw error; }
    };
}
