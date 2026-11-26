import { ModelInvocationError, modelInvocationQueryInputSchema, modelInvocationCommandQueryInputSchema, type ModelInvocationQuery, type ModelInvocationCommandQuery } from '#domain/index.js';
import { verifiedPrincipal, ModelInvocationInspectionApplication, ModelInvocationPolicyAuthorization, type ModelInvocationDelivery } from '#engine/index.js';
import { openSqliteModelInvocationReader, type LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadInvocationContext, loadPeerInvocationContext } from './context.js';

export async function inspectConfiguredModelInvocation(projectRoot: string, input: ModelInvocationQuery, options: ConfigLoadOptions = {}) {
  return inspect(input, scopeId => loadInvocationContext(projectRoot, scopeId, options, 'read'));
}
/** Local read path; uses the same inspection application and policy as SDK/runtime queries, never a replay. */
export async function inspectConfiguredModelInvocationCommand(projectRoot: string, input: ModelInvocationCommandQuery, options: ConfigLoadOptions = {}) {
  const parsed = modelInvocationCommandQueryInputSchema.safeParse(input);
  if (!parsed.success) throw queryFailure(new ModelInvocationError('MODEL_INVOCATION_INVALID'));
  const query = parsed.data;
  try { return await inspectionApplication(await loadInvocationContext(projectRoot, query.scopeId, options, 'read')).inspectCommand(query); }
  catch (error) { throw queryFailure(error); }
}
/** Internal runtime wiring only; actual socket peer evidence is supplied out of band. */
export async function inspectPeerConfiguredModelInvocation(projectRoot: string, input: ModelInvocationQuery,
  peer: LocalPeerIdentity, options: ConfigLoadOptions = {}, delivery?: ModelInvocationDelivery) {
  return inspect(input, scopeId => loadPeerInvocationContext(projectRoot, scopeId, options, peer, 'read'), delivery);
}
async function inspect(input: ModelInvocationQuery, loadContext: (scopeId: string) => ReturnType<typeof loadInvocationContext>,
  delivery?: ModelInvocationDelivery) {
  try {
    const parsed = modelInvocationQueryInputSchema.safeParse(input);
    if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
    const query = parsed.data as ModelInvocationQuery;
    return await inspectionApplication(await loadContext(query.scopeId)).inspect(query, undefined, delivery);
  } catch (error) { throw queryFailure(error); }
}
type InspectionContext = Awaited<ReturnType<typeof loadInvocationContext>>;
export const inspectionApplication = (context: Pick<InspectionContext, 'principal' | 'policy' | 'path' | 'config'>) => new ModelInvocationInspectionApplication(verifiedPrincipal(context.principal), new ModelInvocationPolicyAuthorization(context.policy),
    async () => openSqliteModelInvocationReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs }));

/** The caller owns the verified audit read. Inspect both permissions using its bound person and policy. */
export async function inspectRefusalCandidate(context: Pick<InspectionContext, 'principal' | 'path' | 'config' | 'layout' | 'ownerUid' | 'installationId' | 'document'>,
  scopeId: string, candidate: Pick<ModelInvocationQuery, 'invocationId' | 'reference'>) {
  if (!context.installationId || context.principal.assurance !== 'os-user') return null;
  const policy = contextPolicySource(context, context.document);
  const result = await inspectionApplication({ ...context, policy }).inspect({ schemaVersion: 2, scopeId, invocationId: candidate.invocationId,
    reference: candidate.reference, includeResponseContent: true });
  const receipt = result.invocation;
  if (!receipt || receipt.outcome?.state !== 'responded' || result.contentStatus !== 'retained' || result.purge || !result.responseContent) return null;
  return { scopeId: result.scopeId, invocationId: result.invocationId, reference: result.reference, installationId: context.installationId,
    companyId: context.config.company.id, descriptor: result.responseContent.descriptor };
}
