import { z } from 'zod';
import { attemptIdentitySchema, attemptObservationSchema, createAttempt, applyAttemptObservation,
  requestAttemptCancellation } from '#domain/index.js';
import { AttemptStoreError, type AttemptReceipt, type AttemptStore } from './port.js';

const id = z.string().min(1);
export const attemptCommandSchema = z.object({
  schemaVersion: z.literal(1), commandId: id, principalId: id, scopeId: id,
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create'), identity: attemptIdentitySchema }).strict(),
    z.object({ kind: z.literal('observe'), observation: attemptObservationSchema }).strict(),
    z.object({ kind: z.literal('cancel'), attemptId: id }).strict(),
  ]),
}).strict();
export type AttemptCommand = z.infer<typeof attemptCommandSchema>;
export interface AttemptAuthorization {
  /** Trusted ingress supplies principal; implementations must enforce scope and action authority. */
  authorize(command: AttemptCommand): Promise<void>;
}
export class AttemptApplication {
  constructor(private readonly store: AttemptStore, private readonly authorization: AttemptAuthorization) {}
  async execute(input: unknown): Promise<AttemptReceipt> {
    const command = attemptCommandSchema.parse(input);
    const { action, scopeId, commandId } = command;
    const identity = action.kind === 'create' ? action.identity : action.kind === 'observe' ? action.observation.identity : null;
    if (identity && identity.scopeId !== scopeId) throw new AttemptStoreError('ATTEMPT_COMMAND_CONFLICT');
    await this.authorization.authorize(command);
    const canonical = JSON.stringify(command);
    const replay = await this.store.receipt(scopeId, commandId);
    if (replay) {
      if (replay.command !== canonical) throw new AttemptStoreError('ATTEMPT_COMMAND_CONFLICT');
      return replay;
    }
    if (action.kind === 'create') return this.store.commit({ commandId, command: canonical,
      expectedRevision: null, snapshot: createAttempt(action.identity) });
    const attemptId = action.kind === 'observe' ? action.observation.identity.attemptId : action.attemptId;
    const current = await this.store.load(scopeId, attemptId);
    if (!current) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
    const next = action.kind === 'observe' ? applyAttemptObservation(current, action.observation, current.revision)
      : requestAttemptCancellation(current, current.revision);
    return this.store.commit({ commandId, command: canonical, expectedRevision: current.revision, snapshot: next });
  }
}
