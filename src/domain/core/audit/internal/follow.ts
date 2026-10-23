import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
import { auditEventSchema } from './contract.js';
import limits from './limits.json' with { type: 'json' };
/** The most records one follow page returns (equal to the audit application's page bound). */
const PAGE_MAX = limits.followPageMax;
/**
 * S5 D2 (AUDITOR-MODEL 2026-10-17): AuditFollow v1 — a resumable read of one scope's sealed audit stream. `after` is the last scope-local
 * sequence the reader has seen (0: from the start); the reader never needs or receives a key.
 */
export const auditFollowQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, after: counterSchema,
  limit: z.number().int().min(1).max(PAGE_MAX) }).strict().readonly();
/**
 * One page: events the service verified (seal, scope, ascending sequence), each with its sequence and nothing of its seal; `gaps` names every
 * missing sequence range between `after` and the last returned record (a deleted record is a gap, never silence); `after` is the next
 * query's `after`; `more` is true when the page was full. A missing tail is not visible here: the checkpoint verification owns that.
 */
export const auditFollowPageSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  records: z.array(z.object({ sequence: counterSchema.positive(), event: auditEventSchema }).strict().readonly()).max(PAGE_MAX).readonly(),
  gaps: z.array(z.object({ afterSequence: counterSchema, beforeSequence: counterSchema.positive() }).strict().readonly()).max(PAGE_MAX).readonly(),
  after: counterSchema, more: z.boolean() }).strict().readonly();
export type AuditFollowQuery = z.infer<typeof auditFollowQuerySchema>;
export type AuditFollowPage = z.infer<typeof auditFollowPageSchema>;
