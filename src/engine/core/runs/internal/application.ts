import { z } from 'zod';
import { identitySchema, counterSchema, type VerifiedPrincipal } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { RunStore } from './store.js';
export const runQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, runId: identitySchema }).strict();
export const runCommandSchema = runQuerySchema.extend({ commandId: identitySchema, action: z.literal('cancel'), expectedRevision: counterSchema }).strict();
export type RunQuery = z.infer<typeof runQuerySchema>;
export type RunCommand = z.infer<typeof runCommandSchema>;
export interface RunAuthorization { authorize(action: 'inspect' | 'cancel', query: RunQuery, principal: VerifiedPrincipal): Promise<void> }
/** Shared authenticated ingress. Cancellation records intent; it never fabricates worker termination. */
export class RunInspectionApplication {
  constructor(private readonly readStore: Pick<RunStore, 'loadRun'>, protected readonly verifier: PrincipalVerifier,
    protected readonly authorization: RunAuthorization) {}
  async inspect(input: unknown, credential?: unknown) {
    const query = runQuerySchema.parse(input);
    const principal = await authenticate(this.verifier, credential, query.scopeId);
    await this.authorization.authorize('inspect', query, principal);
    return this.readStore.loadRun(query.scopeId, query.runId);
  }
}
export class RunApplication extends RunInspectionApplication {
  constructor(private readonly store: Pick<RunStore, 'loadRun' | 'cancelRun'>, verifier: PrincipalVerifier, authorization: RunAuthorization) {
    super(store, verifier, authorization);
  }
  async execute(input: unknown, credential?: unknown) {
    const command = runCommandSchema.parse(input);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    await this.authorization.authorize(command.action, command, principal);
    return this.store.cancelRun({ commandId: command.commandId, scopeId: command.scopeId, runId: command.runId,
      expectedRevision: command.expectedRevision, actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject } });
  }
}
