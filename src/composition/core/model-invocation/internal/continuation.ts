import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AUDIT_EVENT_SCHEMA_VERSION, policySchema, modelInvocationProfileSchema, type ModelInvocationCommand, type ModelReference } from '#domain/index.js';
import { subscriptionActor, readSubscriptionRejection, modelInvocationProfileDigest, ModelBindingApplication, modelInvocationBillingAxis, type ModelInvocationResult } from '#engine/index.js';
import { SIWC_USAGE_LIMIT_STATUS, SIWC_INFERENCE, siwcResponsesDefinitionSchema } from '#adapters/index.js';
import { ErrorRegistry, sha256, type ConfigLoadOptions } from '#platform/index.js';
import { withConfiguredSiwc } from '#composition/core/siwc/index.js';
import { withScopeAudit } from '#composition/core/scoped-request/index.js';
import { inspectionApplication } from './inspect.js';
import type { loadInvocationContext } from './context.js';
type Context = Awaited<ReturnType<typeof loadInvocationContext>>;
// A host-only capability follows the exact returned command. It is never serialized or selected by a wire field.
const continuationPins = new WeakMap<ModelInvocationCommand, (profile: import('#domain/index.js').ModelInvocationProfile) => Promise<void>>();
export const configuredContinuationPin = (command: ModelInvocationCommand) => continuationPins.get(command);
/** Astra R2: a command derived from a pinned continuation (Brain correction) keeps the same re-validating pin; an unpinned one stays unpinned. */
export const carryContinuationPin = (from: ModelInvocationCommand, to: ModelInvocationCommand) => { const pin = continuationPins.get(from); if (pin) continuationPins.set(to, pin); };
/** Only a complete, trusted SIWC 429 body can select the person's exact API reference. Transient/unknown/Claude never enter. */
export function siwcLimitContinuation(adapterId: string, httpStatus: number | null, data: string | null): boolean {
  if (adapterId !== SIWC_INFERENCE.adapter.id || httpStatus !== SIWC_USAGE_LIMIT_STATUS || !data) return false;
  const body = readSubscriptionRejection({ adapter: { id: adapterId }, body: { data } }, new Set([SIWC_INFERENCE.adapter.id]));
  return body?.schemaVersion === 1 && body.refusal === 'quota' && body.status === SIWC_USAGE_LIMIT_STATUS && body.resetsAtMs === null;
}
/** The next request remains a normal governed invocation, with its own receipt, tariff, budget and authority. No recursive API fallback. */
export async function prepareConfiguredSiwcContinuation(context: Context, options: ConfigLoadOptions, original: ModelInvocationCommand,
  result: ModelInvocationResult, preview: (command: ModelInvocationCommand) => Promise<unknown>,
  notice: (reference: ModelReference) => void | Promise<void>, signal?: AbortSignal): Promise<ModelInvocationCommand | null> {
  const outcome = result.receipt.outcome;
  if (outcome?.state !== 'rejected' || outcome.evidence.adapter.id !== SIWC_INFERENCE.adapter.id || outcome.evidence.httpStatus !== SIWC_USAGE_LIMIT_STATUS) return null;
  const source = result.receipt.profile;
  const sourceDefinition = siwcResponsesDefinitionSchema.parse(source.adapter.definition);
  if (sourceDefinition.schemaVersion !== 2 || !sourceDefinition.apiContinuation) return null;
  const inspected = await inspectionApplication(context).inspect({ schemaVersion: 2, scopeId: original.scopeId,
    invocationId: result.receipt.claim.invocationId, reference: original.reference, includeResponseContent: true });
  const content = inspected.responseContent;
  if (!siwcLimitContinuation(outcome.evidence.adapter.id, outcome.evidence.httpStatus, content?.kind === 'response-body' ? content.data : null)) return null;
  const readProfiles = async () => {
    const config = await context.freshConfig(), section = config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined;
    return (section?.profiles ?? []).map(value => modelInvocationProfileSchema.parse(value));
  };
  const profiles = await readProfiles(), current = profiles.find(row => row.scopeId === original.scopeId && isDeepStrictEqual(row.reference, original.reference));
  if (!isDeepStrictEqual(current, source)) throw ErrorRegistry.createError('MODEL_INVOCATION_PROFILE_CONFLICT');
  const target = profiles.find(row => row.scopeId === original.scopeId && isDeepStrictEqual(row.reference, sourceDefinition.apiContinuation!.reference));
  if (!target || modelInvocationProfileDigest(target) !== sourceDefinition.apiContinuation.profileDigest || modelInvocationBillingAxis(target) !== 'metered' || !isDeepStrictEqual(target.protocol, source.protocol))
    throw ErrorRegistry.createError('MODEL_INVOCATION_PROFILE_CONFLICT');
  const binding = await new ModelBindingApplication({ read: async () => (await context.freshConfig())['provider_catalog'] }).inspect(target.reference);
  if (binding.status !== 'declared') throw ErrorRegistry.createError('MODEL_INVOCATION_PROFILE_CONFLICT');
  const command: ModelInvocationCommand = { ...original, commandId: sha256(JSON.stringify(['siwc-api-continuation:1', original.scopeId, original.commandId, target.reference])),
    reference: target.reference, catalogRevision: binding.catalogRevision, expectedBinding: binding.binding,
    nativeRequest: { ...original.nativeRequest, model: binding.definition.model.nativeId } };
  await preview(command); // exact active target + authority + tariff + funded current budget, before the notice/audit
  if (signal?.aborted) throw ErrorRegistry.createError('OAUTH_CONNECTION_CANCELLED');
  if (!isDeepStrictEqual((await readProfiles()).find(row => row.scopeId === original.scopeId && isDeepStrictEqual(row.reference, original.reference)), source))
    throw ErrorRegistry.createError('MODEL_INVOCATION_PROFILE_CONFLICT');
  const auditOwner = await withConfiguredSiwc(context.config.projectRoot, original.scopeId, options, 'lease', async (app, caller) => { await app.inspectForLease(sourceDefinition.connectionId, caller); return subscriptionActor(context.principal).owner; }, {}, context.principal);
  await withScopeAudit(context, async audit => audit.record({
    schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: original.scopeId, principal: auditOwner,
    atMs: Date.now(), policyRevision: policySchema.parse(await context.policy.load()).revision,
    subject: { kind: 'subscription-api-continuation', schemaVersion: 1, actor: { issuer: context.principal.issuer, subject: context.principal.subject }, sourceInvocationId: result.receipt.claim.invocationId,
      connectionId: sourceDefinition.connectionId, profileDigest: sourceDefinition.apiContinuation!.profileDigest, reference: target.reference, commandId: command.commandId, phase: 'intent' } }), false);
  await notice(target.reference);
  if (signal?.aborted) throw ErrorRegistry.createError('OAUTH_CONNECTION_CANCELLED');
  continuationPins.set(command, async profile => {
    if (modelInvocationProfileDigest(profile) !== sourceDefinition.apiContinuation!.profileDigest
      || !isDeepStrictEqual((await readProfiles()).find(row => row.scopeId === original.scopeId && isDeepStrictEqual(row.reference, original.reference)), source))
      throw ErrorRegistry.createError('MODEL_INVOCATION_PROFILE_CONFLICT');
  });
  return command;
}
