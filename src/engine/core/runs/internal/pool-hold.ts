import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AUDIT_EVENT_SCHEMA_VERSION, counterSchema, identitySchema, type AuditEvent } from '#domain/index.js';
import type { AuditStore } from '#engine/core/audit/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { assertPoolControlAllowed, type PoolControlAuthorization, type PoolControlDecision } from '#engine/core/policy/index.js';
import { RunStoreError } from './store.js';

/**
 * K5 typed execution pool hold (owner 2026-09-30 option A; lane Jev 2e7be700). While a pool is held the ledger refuses every new task
 * reservation on it (`RUN_POOL_HELD`, inside the reservation transaction); Run admission still accepts Runs, already reserved attempts
 * still launch, run and are evaluated, and an immediate stop stays the explicit Run cancel. `resume` restarts reservations. The pool is
 * installation-wide, so the hold is too (one row per pool, ledger v44); `drained` is the typed "held and nothing left" status the
 * dev-release switch (U2) waits on.
 */
const reasonSchema = z.string().min(1).max(256).regex(/^[^\p{Cc}]+$/u);
const actorSchema = z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly();
const poolStateSchema = z.enum(['held', 'open']);
/** `poolId` defaults to the installation's configured admission pool. `reason` is the operator's short note, kept in the hold record. */
export const poolHoldCommandSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, commandId: identitySchema,
  action: z.enum(['hold', 'resume']), poolId: identitySchema.optional(), reason: reasonSchema.optional() }).strict();
export const poolHoldQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, poolId: identitySchema.optional() }).strict();
/** The durable hold row: the last state change of one pool (no row = open, never held). */
export const poolHoldRecordSchema = z.object({ schemaVersion: z.literal(1), poolId: identitySchema, state: poolStateSchema,
  revision: counterSchema.positive(), changedBy: actorSchema, changedAtMs: counterSchema, scopeId: identitySchema, commandId: identitySchema,
  reason: reasonSchema.nullable() }).strict().readonly();
export const poolOccupancySchema = z.object({ execution: counterSchema, inFlight: counterSchema }).strict().readonly();
/** One applied command; a replay of the same (scope, command) returns it unchanged. `changed` false = idempotent no-op. */
export const poolHoldReceiptSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, commandId: identitySchema,
  poolId: identitySchema, action: z.enum(['hold', 'resume']), changed: z.boolean(), state: poolStateSchema, hold: poolHoldRecordSchema.nullable() }).strict().readonly();
export type PoolHoldCommand = z.infer<typeof poolHoldCommandSchema>;
export type PoolHoldQuery = z.infer<typeof poolHoldQuerySchema>;
export type PoolHoldRecord = z.infer<typeof poolHoldRecordSchema>;
export type PoolOccupancy = z.infer<typeof poolOccupancySchema>;
export type PoolHoldReceipt = z.infer<typeof poolHoldReceiptSchema>;
/** The resolved command the store writes (pool chosen, reason null when absent) and who/when; also the replay fingerprint. */
export interface PoolHoldWrite {
  readonly command: Readonly<{ scopeId: string; commandId: string; poolId: string; action: 'hold' | 'resume'; reason: string | null }>;
  readonly actor: Readonly<{ issuer: string; subject: string }>; readonly atMs: number;
}
export type PoolHoldTransition = Readonly<{ previous: 'held' | 'open'; next: 'held' | 'open' }>;
/** Ledger port. `applyPoolHold` runs replay, {@link decidePoolHold}, the row write, the receipt and `audit` in one transaction. */
export interface PoolHoldStore {
  readPoolHold(poolId: string): Promise<Readonly<{ hold: PoolHoldRecord | null; occupancy: PoolOccupancy }>>;
  applyPoolHold(write: PoolHoldWrite, audit: (store: AuditStore, transition: PoolHoldTransition) => void): Promise<PoolHoldReceipt>;
  recordPoolHoldRefusal(audit: (store: AuditStore) => void): Promise<void>;
}
export type PoolHoldAuditRecorder = (store: AuditStore) => { record(event: unknown): unknown };

/** Pure transition (the single owner of hold state): hold-while-held and resume-while-open change nothing. */
export function decidePoolHold(current: PoolHoldRecord | null, write: PoolHoldWrite) {
  const previous = current?.state ?? 'open', next = write.command.action === 'hold' ? 'held' as const : 'open' as const;
  const record = previous === next ? current : poolHoldRecordSchema.parse({ schemaVersion: 1, poolId: write.command.poolId, state: next,
    revision: (current?.revision ?? 0) + 1, changedBy: write.actor, changedAtMs: write.atMs, scopeId: write.command.scopeId,
    commandId: write.command.commandId, reason: write.command.reason });
  const receipt = poolHoldReceiptSchema.parse({ schemaVersion: 1, scopeId: write.command.scopeId, commandId: write.command.commandId,
    poolId: write.command.poolId, action: write.command.action, changed: previous !== next, state: next, hold: record });
  return Object.freeze({ transition: Object.freeze({ previous, next }), record, receipt });
}
/** Typed status: `drained` = held and no reserved, running, uncertain or evaluating task left on the pool (Jev 2e7be700 drain check). */
export function poolHoldView(poolId: string, hold: PoolHoldRecord | null, occupancy: PoolOccupancy) {
  const state = hold?.state ?? 'open';
  return Object.freeze({ schemaVersion: 1 as const, poolId, state, hold, occupancy,
    drained: state === 'held' && occupancy.execution === 0 && occupancy.inFlight === 0 });
}
export type PoolHoldView = ReturnType<typeof poolHoldView>;

/** One application for CLI, MCP and SDK: authenticate → decide on the `pool` cell → record (refusals too) → ledger transition. */
export class ExecutionPoolHoldApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: PoolControlAuthorization,
    private readonly store: PoolHoldStore, private readonly recorder: PoolHoldAuditRecorder, private readonly now: () => number,
    private readonly defaultPoolId: string | null) {}
  private pool(poolId: string | undefined) {
    const selected = poolId ?? this.defaultPoolId;
    if (!selected) throw new RunStoreError('RUN_POOL_REQUIRED');
    return selected;
  }
  async apply(input: unknown, credential?: unknown): Promise<PoolHoldReceipt> {
    const command = poolHoldCommandSchema.parse(input), poolId = this.pool(command.poolId);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    const decision = await this.authorization.decide(command.action, poolId, command.scopeId, principal);
    const actor = { issuer: principal.issuer, subject: principal.subject }, atMs = counterSchema.parse(this.now());
    const event = (state: PoolHoldTransition | null) => poolHoldAuditEvent(command, poolId, actor, atMs, decision, state);
    if (decision.effect !== 'allow') await this.store.recordPoolHoldRefusal(store => { this.recorder(store).record(event(null)); });
    assertPoolControlAllowed(decision);
    return this.store.applyPoolHold({ command: { scopeId: command.scopeId, commandId: command.commandId, poolId, action: command.action,
      reason: command.reason ?? null }, actor, atMs }, (store, transition) => { this.recorder(store).record(event(transition)); });
  }
  async inspect(input: unknown, credential?: unknown): Promise<PoolHoldView> {
    const query = poolHoldQuerySchema.parse(input), poolId = this.pool(query.poolId);
    const principal = await authenticate(this.verifier, credential, query.scopeId);
    assertPoolControlAllowed(await this.authorization.decide('inspect', poolId, query.scopeId, principal));
    const { hold, occupancy } = await this.store.readPoolHold(poolId);
    return poolHoldView(poolId, hold, occupancy);
  }
}
function poolHoldAuditEvent(command: PoolHoldCommand, poolId: string, principal: Readonly<{ issuer: string; subject: string }>, atMs: number,
  decision: PoolControlDecision, state: PoolHoldTransition | null): AuditEvent {
  return { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: command.scopeId, principal, policyRevision: decision.revision, atMs,
    subject: { kind: 'pool-hold', action: command.action, poolId, commandId: command.commandId,
      decision: { effect: decision.effect, ruleId: decision.ruleId }, state: state && { previous: state.previous, next: state.next } } };
}
