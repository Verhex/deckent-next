import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AUDIT_EVENT_SCHEMA_VERSION, counterSchema, identitySchema, type AuditEvent } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { assertPoolControlAllowed, type PoolControlAuthorization, type PoolControlDecision } from '#engine/core/policy/index.js';
import type { AuditStore } from '#engine/core/audit/index.js';
import { RunStoreError } from './store.js';
import { poolHoldQuerySchema, poolOccupancySchema, type PoolHoldAuditRecorder, type PoolHoldStore } from './pool-hold.js';

// The pool's existing counter bound is Number.MAX_SAFE_INTEGER; no new product ceiling.
export const poolCapacitySchema = z.object({ executionSlots: counterSchema.positive(), inFlightSlots: counterSchema.positive() }).strict().readonly();
export const poolCapacityCommandSchema = poolHoldQuerySchema.extend({ commandId: identitySchema, capacity: poolCapacitySchema }).strict();
export const poolCapacityReceiptSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, commandId: identitySchema, poolId: identitySchema,
  actor: z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly(), atMs: counterSchema, changed: z.boolean(),
  previous: poolCapacitySchema.unwrap().extend({ executionSlots: counterSchema, inFlightSlots: counterSchema }).readonly(), next: poolCapacitySchema }).strict().readonly();
export type PoolCapacity = z.infer<typeof poolCapacitySchema>;
export type PoolCapacityCommand = z.infer<typeof poolCapacityCommandSchema>;
export type PoolCapacityReceipt = z.infer<typeof poolCapacityReceiptSchema>;
export interface PoolCapacityWrite { readonly command: PoolCapacityCommand & { readonly poolId: string }; readonly actor: PoolCapacityReceipt['actor']; readonly atMs: number }
export interface PoolCapacityView { readonly schemaVersion: 1; readonly poolId: string; readonly capacity: PoolCapacity; readonly occupancy: z.infer<typeof poolOccupancySchema>; readonly receipt: PoolCapacityReceipt | null }
export interface PoolCapacityStore extends Pick<PoolHoldStore, 'recordPoolHoldRefusal'> {
  readPoolCapacity(poolId: string): Promise<PoolCapacityView>;
  applyPoolCapacity(write: PoolCapacityWrite, audit: (store: AuditStore, receipt: PoolCapacityReceipt) => void): Promise<PoolCapacityReceipt>;
}
/** Single pure transition. Refuse under-occupancy shrink: live and uncertain work retain custody. */
export function decidePoolCapacity(previous: PoolCapacity, occupancy: PoolCapacityView['occupancy'], write: PoolCapacityWrite): PoolCapacityReceipt {
  const next = poolCapacitySchema.parse(write.command.capacity);
  if (next.executionSlots < occupancy.execution || next.inFlightSlots < occupancy.inFlight) throw new RunStoreError('RUN_POOL_CAPACITY_OCCUPIED');
  return poolCapacityReceiptSchema.parse({ schemaVersion: 1, scopeId: write.command.scopeId, commandId: write.command.commandId, poolId: write.command.poolId,
    actor: write.actor, atMs: write.atMs, previous, next, changed: previous.executionSlots !== next.executionSlots || previous.inFlightSlots !== next.inFlightSlots });
}
/** The same installation-wide authorization bound as hold/resume. No runtime-service control-path step. */
export class ExecutionPoolCapacityApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: PoolControlAuthorization, private readonly store: PoolCapacityStore,
    private readonly recorder: PoolHoldAuditRecorder, private readonly now: () => number, private readonly defaultPoolId: string | null) {}
  private pool(id?: string) { const pool = id ?? this.defaultPoolId; if (!pool) throw new RunStoreError('RUN_POOL_REQUIRED'); return pool; }
  async apply(input: unknown, credential?: unknown): Promise<PoolCapacityReceipt> {
    const command = poolCapacityCommandSchema.parse(input), poolId = this.pool(command.poolId);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    const decision = await this.authorization.decide('set-capacity', poolId, command.scopeId, principal);
    const actor = { issuer: principal.issuer, subject: principal.subject }, atMs = counterSchema.parse(this.now());
    const event = (receipt: PoolCapacityReceipt | null): AuditEvent => capacityAudit(command, poolId, actor, atMs, decision, receipt);
    if (decision.effect !== 'allow') await this.store.recordPoolHoldRefusal(store => { this.recorder(store).record(event(null)); });
    assertPoolControlAllowed(decision);
    return this.store.applyPoolCapacity({ command: { schemaVersion: 1, scopeId: command.scopeId, commandId: command.commandId, poolId, capacity: command.capacity }, actor, atMs }, (store, receipt) => { this.recorder(store).record(event(receipt)); });
  }
  async inspect(input: unknown, credential?: unknown): Promise<PoolCapacityView> {
    const query = poolHoldQuerySchema.parse(input), poolId = this.pool(query.poolId);
    const principal = await authenticate(this.verifier, credential, query.scopeId);
    assertPoolControlAllowed(await this.authorization.decide('inspect', poolId, query.scopeId, principal));
    return this.store.readPoolCapacity(poolId);
  }
}
function capacityAudit(command: PoolCapacityCommand, poolId: string, principal: PoolCapacityReceipt['actor'], atMs: number,
  decision: PoolControlDecision, receipt: PoolCapacityReceipt | null): AuditEvent {
  return { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: command.scopeId, principal, policyRevision: decision.revision, atMs,
    subject: { kind: 'pool-capacity', poolId, commandId: command.commandId, decision: { effect: decision.effect, ruleId: decision.ruleId },
      capacity: receipt ? { previous: receipt.previous, next: receipt.next } : null } };
}
