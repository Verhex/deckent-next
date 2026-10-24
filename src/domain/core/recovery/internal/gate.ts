import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import { sameAttemptIdentity, type AttemptIdentity } from '#domain/core/attempt/index.js';
import { effectRecordSchema, effectStateSchema, effectTargetRefSchema, operationRefSchema, type EffectRecord } from '#domain/core/effect/index.js';
import type { RunRecoveryPolicy } from './policy.js';

export const RECOVERY_ERROR_CODES = ['RECOVERY_INVALID', 'RECOVERY_OFF', 'RECOVERY_NOT_FOUND', 'RECOVERY_NOT_READY', 'RECOVERY_RUN_CLOSED', 'RECOVERY_EFFECTS_OPEN',
  'RECOVERY_SETTLED_NOT_IDEMPOTENT', 'RECOVERY_SETTLED_OVER_BOUND', 'RECOVERY_CONTINUATION_BOUND', 'RECOVERY_ATTEMPT_CEILING', 'RECOVERY_RUN_BOUND', 'RECOVERY_SAME_EVIDENCE',
  'RECOVERY_STALE', 'RECOVERY_CONFLICT', 'RECOVERY_PRINCIPAL_REQUIRED', 'RECOVERY_NOT_APPROVED', 'RECOVERY_CORRUPT', 'RECOVERY_UNAVAILABLE'] as const;
export type RecoveryErrorCode = typeof RECOVERY_ERROR_CODES[number];
export class RecoveryError extends Error {
  constructor(readonly code: RecoveryErrorCode, options?: ErrorOptions) { super(code, options); this.name = 'RecoveryError'; }
}
/**
 * S6R-DESIGN §7 step 4/4b: what the mandatory effect gate saw. `intents`: the gate set — every intent the lost Attempt produced, plus (fail-closed
 * window rule) every intent written before S6R-1 (no producer) that is still open in the Run's scope. `result`: `clear` (none), `reconciled` (all
 * settled or refused) or `open` (any claimed/unknown, or more than the registry lets one gate weigh). `settled`: `none`, `task-idempotent` (every
 * settled intent's operation declares `idempotencyScope: 'task'`), `not-declared` (one does not: a person decides) or `over-bound` (the fact list
 * would exceed the registry bound). `facts`: what a new Attempt may learn of the settled work; it is never re-executed.
 */
export const recoveryEffectGateSchema = z.object({ schemaVersion: z.literal(1), result: z.enum(['clear', 'reconciled', 'open']), complete: z.boolean(),
  settled: z.enum(['none', 'task-idempotent', 'not-declared', 'over-bound']),
  intents: z.array(z.object({ commandId: identitySchema, state: effectStateSchema, producer: z.enum(['attempt', 'legacy']) }).strict().readonly()).max(1024).readonly(),
  facts: z.array(z.object({ commandId: identitySchema, operation: operationRefSchema, target: effectTargetRefSchema, version: z.string().min(1).max(256).nullable(),
    observedAt: counterSchema }).strict().readonly()).max(256).readonly() }).strict().readonly();
export type RecoveryEffectGate = z.infer<typeof recoveryEffectGateSchema>;
const OPEN = new Set(['claimed', 'unknown']);

/** Pure: the gate over the records a store read for one lost Attempt (its own, plus older producer-less rows of the scope). Another scope's record is refused. */
export function assessRecoveryEffectGate(identity: AttemptIdentity, input: readonly unknown[], policy: Pick<RunRecoveryPolicy, 'maxGateIntents' | 'settledFacts'>): RecoveryEffectGate {
  const records: EffectRecord[] = input.map(value => { const parsed = effectRecordSchema.safeParse(value); if (!parsed.success) throw new RecoveryError('RECOVERY_INVALID'); return parsed.data; });
  if (records.some(record => record.intent.command.scopeId !== identity.scopeId)) throw new RecoveryError('RECOVERY_INVALID');
  // Fail-closed window rule without a claim time (S6R-DESIGN §7 step 4): a producer-less row can only predate S6R-1, so it joins while still open.
  const members = records.filter(record => record.intent.producer ? record.intent.producer.kind === 'attempt' && sameAttemptIdentity(record.intent.producer.identity, identity)
    : OPEN.has(record.state));
  const complete = members.length <= policy.maxGateIntents, kept = members.slice(0, policy.maxGateIntents);
  const result = !complete || kept.some(record => OPEN.has(record.state)) ? 'open' : kept.length ? 'reconciled' : 'clear';
  const settledRows = kept.filter(record => record.state === 'settled');
  const facts = settledRows.map(record => ({ commandId: record.intent.command.commandId, operation: record.intent.command.operation, target: record.intent.command.target,
    version: record.evidence?.version ?? null, observedAt: record.evidence?.observedAt ?? 0 }));
  const settled = !settledRows.length ? 'none' : settledRows.some(record => record.intent.descriptor.idempotencyScope !== 'task') ? 'not-declared'
    : facts.length > policy.settledFacts.maxCount || JSON.stringify(facts).length > policy.settledFacts.maxBytes ? 'over-bound' : 'task-idempotent';
  return recoveryEffectGateSchema.parse({ schemaVersion: 1, result, complete, settled,
    intents: kept.map(record => ({ commandId: record.intent.command.commandId, state: record.state, producer: record.intent.producer ? 'attempt' : 'legacy' })),
    facts: settled === 'task-idempotent' ? facts : [] });
}
/** The typed refusal a gate result carries (null: it passes — nothing open, settled work only where the catalog declares task-scoped idempotency). */
export function recoveryGateRefusal(gate: RecoveryEffectGate): RecoveryErrorCode | null {
  if (gate.result === 'open') return 'RECOVERY_EFFECTS_OPEN';
  if (gate.settled === 'not-declared') return 'RECOVERY_SETTLED_NOT_IDEMPOTENT';
  if (gate.settled === 'over-bound') return 'RECOVERY_SETTLED_OVER_BOUND';
  return null;
}
export const recoveryEffectGatePasses = (gate: RecoveryEffectGate) => recoveryGateRefusal(gate) === null;
