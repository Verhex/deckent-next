import { createHash } from 'node:crypto';
import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/index.js';
import { AUTONOMY_HOLD_REASONS, autonomyFacts, canonical, evaluateAutonomy } from './rule.js';
import type { DeliverySummary } from './contract.js';

/**
 * Autonomy shadow record v1 (OTONOM-TESLIM D1-lite shadow, alpha.53 law-audit folds 1-2). The queue service evaluates rule `autonomy@1` as
 * actor `system` once per ticket revision that reaches awaiting-confirmation and keeps the advice in its own bounded append-only store,
 * OUTSIDE the audit chain. Nothing reads it as authority: deliver/adopt, consent digests and queue state never depend on it. A later
 * comparison joins it to the `target-batch-decision` audit by commandId.
 */
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const autonomyShadowId = (commandId: string, revision: number) => `autonomy-shadow:${commandId}:${revision}`;
export const autonomyShadowRecordSchema = z.object({ schemaVersion: z.literal(1), id: z.string().min(1), at: counterSchema, actor: z.literal('system'),
  scopeId: identitySchema, commandId: identitySchema, revision: counterSchema,
  rule: z.object({ id: identitySchema, version: z.number().int().positive().safe(), digest }).strict(),
  verdict: z.enum(['would-deliver', 'would-hold']), reasons: z.array(z.enum(AUTONOMY_HOLD_REASONS)).max(AUTONOMY_HOLD_REASONS.length), summaryDigest: digest }).strict()
  .refine(value => value.id === autonomyShadowId(value.commandId, value.revision) && new Set(value.reasons).size === value.reasons.length
    && (value.verdict === 'would-deliver') === (value.reasons.length === 0)).readonly();
export type AutonomyShadowRecord = z.infer<typeof autonomyShadowRecordSchema>;

const sha256 = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
/** Digest of the exact (redacted, bounded) envelope the rule evaluated; the record carries it instead of any card text. */
export const deliverySummaryDigest = (summary: DeliverySummary) => sha256(summary);
/** Per-line integrity digest of one stored record (sorted-key JSON), so an altered or torn line is detected on read. */
export const autonomyShadowDigest = (record: AutonomyShadowRecord) => sha256(record);

/** Pure: the record of one ticket revision. Same ticket, summary and time give the same record; the id never depends on time. */
export function autonomyShadowRecord(ticket: Readonly<{ scopeId: string; commandId: string; revision: number }>, summary: DeliverySummary, at: number): AutonomyShadowRecord {
  const evaluation = evaluateAutonomy(autonomyFacts(summary));
  return autonomyShadowRecordSchema.parse({ schemaVersion: 1, id: autonomyShadowId(ticket.commandId, ticket.revision), at, actor: 'system', scopeId: ticket.scopeId,
    commandId: ticket.commandId, revision: ticket.revision, rule: { ...evaluation.rule }, verdict: evaluation.verdict, reasons: [...evaluation.reasons],
    summaryDigest: deliverySummaryDigest(summary) });
}

/** Bounded append-only store port. `append` is idempotent by id (a record id is written once); `latest` answers the highest revision of a ticket. */
export interface AutonomyShadowStore {
  append(record: AutonomyShadowRecord): Promise<'written' | 'exists'>;
  latest(scopeId: string, commandId: string): Promise<AutonomyShadowRecord | null>;
}
