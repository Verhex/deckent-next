import { z } from 'zod';
import { ErrorRegistry } from '#platform/index.js';
import { queueRollbackSchema, queueEnqueueSchema, queueQuerySchema, queueListSchema, queueChallengeSchema, queueAnswerSchema, queueExecuteSchema,
  queueConsentSchema, queueExecutionSchema, queueInspectionSchema, queuePageSchema, targetQueueViewSchema, type QueueReadClient,
  type QueueSubmitClient, type QueueChallenge, type QueueAnswer, type QueueExecute, type QueueQuery, type QueueConsent } from '#engine/core/effect/index.js';
import type { RuntimeValidationCall, RuntimeFailureMapper } from './client-validation.js';
/** Human CLI/Terminal submission only (DESIGN §6): the SDK runtime client below never carries it, and the service refuses MCP submission. */
export function runtimeTargetQueueSubmission(call: RuntimeValidationCall, mapFailure: RuntimeFailureMapper): QueueSubmitClient {
  return { ...runtimeTargetQueueMethods(call, mapFailure),
    async enqueueTargetQueueRollback(input) {
      try { const command = queueRollbackSchema.parse(input), result = targetQueueViewSchema.parse(await call('enqueueTargetQueueRollback', command));
        if (result.commandId !== command.commandId || result.identity.scopeId !== command.scopeId || result.operation !== 'rollback') throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT'); return result;
      } catch (error) { throw mapFailure(error); }
    },
    async enqueueTargetQueue(input) {
      try { const command = queueEnqueueSchema.parse(input), result = targetQueueViewSchema.parse(await call('enqueueTargetQueue', command));
        if (result.commandId !== command.commandId || JSON.stringify(result.identity) !== JSON.stringify(command.identity)) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT'); return result;
      } catch (error) { throw mapFailure(error); }
    },
  };
}
/** Normal SDK/MCP methods: inspect and list only, with no submission and no answer producer. The trusted terminal host owns those. */
export function runtimeTargetQueueMethods(call: RuntimeValidationCall, mapFailure: RuntimeFailureMapper): QueueReadClient {
  return {
    async inspectTargetQueue(input) {
      try { const query = queueQuerySchema.parse(input), result = queueInspectionSchema.parse(await call('inspectTargetQueue', query));
        if (result.record && (result.record.commandId !== query.commandId || result.record.identity.scopeId !== query.scopeId)) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT'); return result;
      } catch (error) { throw mapFailure(error); }
    },
    async listTargetQueue(input) {
      try { const query = queueListSchema.parse(input), result = queuePageSchema.parse(await call('listTargetQueue', query));
        if (result.records.length > query.limit || result.records.some(row => row.identity.scopeId !== query.scopeId || row.commandId <= (query.after ?? ''))) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT'); return result;
      } catch (error) { throw mapFailure(error); }
    },
  };
}
/** Only CLI/Terminal composition installs this capability. Wire fields cannot inject an answer callback. */
export function runtimeTargetQueueTerminal(call: RuntimeValidationCall, interactive: () => Promise<void>) {
  const challenge = async (input: QueueChallenge) => {
    const command = queueChallengeSchema.parse(input), result = queueConsentSchema.parse(await call('challengeTargetQueue', command));
    if (result.operation !== command.operation || result.items[0]?.commandId !== command.commandId) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
    return result;
  };
  const answer = async (input: QueueAnswer) => {
    const command = queueAnswerSchema.parse(input), result = z.object({ schemaVersion: z.literal(1), digest: z.literal(command.digest), allowed: z.literal(true) }).strict().parse(await call('answerTargetQueue', command)); return result;
  };
  const execute = async (input: QueueExecute) => queueExecutionSchema.parse(await call('executeTargetQueue', queueExecuteSchema.parse(input)));
  return async (input: QueueQuery, ask: (view: Omit<QueueConsent, 'capability'>) => Promise<boolean>) => {
    await interactive(); // a human at a verified terminal, never the MCP channel, before any challenge is requested
    const query = queueQuerySchema.parse(input), inspection = queueInspectionSchema.parse(await call('inspectTargetQueue', query));
    if (inspection.record?.operation === 'rollback') {
      const rollback = await challenge({ ...query, operation: 'rollback' }), { capability, ...view } = rollback;
      await answer({ schemaVersion: 1, scopeId: query.scopeId, digest: view.digest, capability, answer: await ask(view) ? 'allow' : 'decline' });
      return execute({ ...query, rollbackDigest: rollback.digest });
    }
    const publish = await challenge({ ...query, operation: 'publish' });
    for (const item of [publish]) { const { capability, ...view } = item; await answer({ schemaVersion: 1, scopeId: query.scopeId, digest: view.digest, capability, answer: await ask(view) ? 'allow' : 'decline' }); }
    const adopt = await challenge({ ...query, operation: 'adopt', publishDigest: publish.digest }), { capability, ...view } = adopt;
    await answer({ schemaVersion: 1, scopeId: query.scopeId, digest: view.digest, capability, answer: await ask(view) ? 'allow' : 'decline' });
    return execute({ ...query, publishDigest: publish.digest, adoptDigest: adopt.digest });
  };
}
