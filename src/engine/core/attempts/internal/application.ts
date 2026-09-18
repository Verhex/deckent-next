import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { z } from 'zod';
import { attemptIdentitySchema, attemptObservationSchema, createAttempt, applyAttemptObservation,
  requestAttemptCancellation, identitySchema, type VerifiedPrincipal } from '#domain/index.js';
import { AttemptStoreError, type AttemptReceipt, type AttemptStore } from './port.js';

const id = identitySchema;
export const ATTEMPT_COMMAND_SCHEMA_VERSION = 2;
export const attemptCommandSchema = z.object({
  schemaVersion: z.literal(ATTEMPT_COMMAND_SCHEMA_VERSION), commandId: id, scopeId: id,
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create'), identity: attemptIdentitySchema }).strict(),
    z.object({ kind: z.literal('observe'), observation: attemptObservationSchema }).strict(),
    z.object({ kind: z.literal('cancel'), attemptId: id }).strict(),
  ]),
}).strict();
export type AttemptCommand = z.infer<typeof attemptCommandSchema>;
export interface AttemptAuthorization {
  /** Trusted ingress supplies principal; implementations must enforce scope and action authority. */
  authorize(command: AttemptCommand, principal: VerifiedPrincipal): Promise<void>;
}
export class AttemptApplication {
  constructor(private readonly store: AttemptStore, private readonly authorization: AttemptAuthorization, private readonly verifier: PrincipalVerifier) {}
  async execute(input: unknown, credential?: unknown): Promise<AttemptReceipt> {
    const command = attemptCommandSchema.parse(input);
    const { action, scopeId, commandId } = command;
    const identity = action.kind === 'create' ? action.identity : action.kind === 'observe' ? action.observation.identity : null;
    if (identity && identity.scopeId !== scopeId) throw new AttemptStoreError('ATTEMPT_COMMAND_CONFLICT');
    const principal = await authenticate(this.verifier, credential, scopeId);
    await this.authorization.authorize(command, principal);
    const canonical = JSON.stringify({ command, actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject } });
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
    return this.store.commit({ commandId, command: canonical, expectedRevision: current.revision, snapshot: next,
      ...(action.kind === 'cancel' ? { cancellationActor: principal } : {}) });
  }
}
