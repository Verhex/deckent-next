import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AUDIT_EVENT_SCHEMA_VERSION, clientCommandIdSchema, counterSchema, identitySchema, type AuditEvent } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { assertPoolControlAllowed, type PoolControlAuthorization, type PoolControlDecision } from '#engine/core/policy/index.js';
import type { AuditStore } from '#engine/core/audit/index.js';
import type { PoolHoldAuditRecorder } from './pool-hold.js';
import { RunStoreError } from './store.js';

export const quotaReleaseCommandSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  commandId: clientCommandIdSchema, poolId: identitySchema.optional(), channelId: z.string().min(1).max(256) }).strict();
export const quotaReleaseReceiptSchema = quotaReleaseCommandSchema.extend({ poolId: identitySchema, poolIds: z.array(identitySchema).readonly(), released: counterSchema, atMs: counterSchema }).strict().readonly();
export type QuotaReleaseCommand = z.infer<typeof quotaReleaseCommandSchema>;
export type QuotaReleaseReceipt = z.infer<typeof quotaReleaseReceiptSchema>;
export interface QuotaReleaseWrite { readonly command: QuotaReleaseCommand & { readonly poolId: string };
  readonly actor: Readonly<{ issuer: string; subject: string }>; readonly atMs: number; readonly authorizedPoolIds: readonly string[] }
export interface QuotaReleaseStore {
  loadQuotaReleasePools(write: Omit<QuotaReleaseWrite, 'authorizedPoolIds'>): Promise<readonly string[]>;
  releaseQuota(write: QuotaReleaseWrite, audit: (store: AuditStore, released: number, poolIds: readonly string[]) => void): Promise<QuotaReleaseReceipt>;
  recordPoolHoldRefusal(audit: (store: AuditStore) => void): Promise<void>;
}
/** Installation-wide subscription recovery uses the separate pool/release-quota cell. No provider timestamp or pool hold is edited. */
export class QuotaReleaseApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: PoolControlAuthorization,
    private readonly store: QuotaReleaseStore, private readonly recorder: PoolHoldAuditRecorder, private readonly now: () => number,
    private readonly defaultPoolId: string | null) {}
  async apply(input: unknown, credential?: unknown): Promise<QuotaReleaseReceipt> {
    const command = quotaReleaseCommandSchema.parse(input), poolId = command.poolId ?? this.defaultPoolId;
    if (!poolId) throw new RunStoreError('RUN_POOL_REQUIRED');
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    const actor = { issuer: principal.issuer, subject: principal.subject }, atMs = counterSchema.parse(this.now());
    const write = { command: { ...command, poolId }, actor, atMs };
    const poolIds = await this.store.loadQuotaReleasePools(write), authorizedPoolIds = [...new Set([poolId, ...poolIds])];
    const event = (decision: PoolControlDecision, decisionPoolId: string, released: number | null, affected: readonly string[]): AuditEvent => ({
      schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: command.scopeId, principal: actor,
      policyRevision: decision.revision, atMs, subject: { kind: 'quota-release', poolId, poolIds: affected, decisionPoolId, channelId: command.channelId,
        commandId: command.commandId, decision: { effect: decision.effect, ruleId: decision.ruleId }, released } });
    let selected: PoolControlDecision | undefined;
    for (const target of authorizedPoolIds) {
      const decision = await this.authorization.decide('release-quota', target, command.scopeId, principal);
      if (decision.effect !== 'allow') await this.store.recordPoolHoldRefusal(store => { this.recorder(store).record(event(decision, target, null, poolIds)); });
      assertPoolControlAllowed(decision);
      if (selected && selected.revision !== decision.revision) throw new RunStoreError('RUN_STORE_CONFLICT');
      selected ??= decision;
    }
    const decision = selected!;
    return this.store.releaseQuota({ ...write, authorizedPoolIds }, (store, released, affected) => { this.recorder(store).record(event(decision, poolId, released, affected)); });
  }
}
