import { isAiPrincipal } from '#domain/core/principal/index.js';
import { MEMORY_LIMITS, MEMORY_SCHEMA_VERSION, MemoryError, memoryAudienceSchema, memoryContentSchema, memoryEntrySchema, memoryOriginSchema, memoryVerificationBasisSchema,
  type MemoryEntry, type MemoryResolvedEvaluation } from './contract.js';

interface Actor { readonly issuer: string; readonly subject: string; readonly assurance?: string }
const same = (a: { issuer: string; subject: string }, b: { issuer: string; subject: string }) => a.issuer === b.issuer && a.subject === b.subject;
const entry = (value: unknown): MemoryEntry => { const parsed = memoryEntrySchema.safeParse(value); if (!parsed.success) throw new MemoryError('MEMORY_ENTRY_INVALID'); return parsed.data; };
const who = (actor: Actor) => ({ issuer: actor.issuer, subject: actor.subject, ai: isAiPrincipal(actor) });
const bytes = (value: string) => new TextEncoder().encode(value).length;

/** A new candidate (revision 1, entry v2). `contentDigest` is the engine's keyed digest of the canonical content; the domain stays free of hashing.
 * `audience` (S4B-1) is the distiller's; a person's proposal is scope-wide (`null`). */
export function proposeMemoryEntry(input: { readonly scopeId: string; readonly entryId: string; readonly commandId: string; readonly content: unknown;
  readonly contentDigest: string; readonly author: Actor; readonly origin: unknown; readonly atMs: number; readonly audience?: unknown }): MemoryEntry {
  const content = memoryContentSchema.safeParse(input.content), origin = memoryOriginSchema.safeParse(input.origin), audience = memoryAudienceSchema.nullable().safeParse(input.audience ?? null);
  if (!content.success || !origin.success || !audience.success) throw new MemoryError('MEMORY_ENTRY_INVALID');
  return entry({ schemaVersion: MEMORY_SCHEMA_VERSION, audience: audience.data, scopeId: input.scopeId, entryId: input.entryId, revision: 1, state: 'candidate', content: content.data,
    contentDigest: input.contentDigest, provenance: { author: who(input.author), origin: origin.data, proposedAtMs: input.atMs, commandId: input.commandId },
    verification: null, retirement: null, updatedAtMs: input.atMs });
}

/**
 * candidate → verified. A human review needs a human principal (never the MCP actor or a workload: `isAiPrincipal`). An independent evaluation needs
 * the resolved record: passed, judging exactly this content digest, by an evaluator that is not the entry's author. No record resolved: fail closed.
 */
export function verifyMemoryEntry(previous: MemoryEntry, input: { readonly actor: Actor; readonly atMs: number; readonly basis: unknown;
  readonly evaluation?: MemoryResolvedEvaluation | null }): MemoryEntry {
  const basis = memoryVerificationBasisSchema.safeParse(input.basis);
  if (!basis.success) throw new MemoryError('MEMORY_ENTRY_INVALID');
  if (previous.state !== 'candidate') throw new MemoryError('MEMORY_TRANSITION_INVALID');
  let verification: MemoryEntry['verification'];
  if (basis.data.kind === 'human-review') {
    if (isAiPrincipal(input.actor)) throw new MemoryError('MEMORY_VERIFIER_NOT_HUMAN');
    verification = { basis: 'human-review', reviewer: { issuer: input.actor.issuer, subject: input.actor.subject }, note: basis.data.note, verifiedAtMs: input.atMs };
  } else {
    const evaluation = input.evaluation, record = basis.data.record;
    if (!evaluation) throw new MemoryError('MEMORY_EVALUATION_UNAVAILABLE');
    if (evaluation.record.kind !== record.kind || evaluation.record.id !== record.id || evaluation.record.digest !== record.digest
      || evaluation.subjectDigest !== previous.contentDigest) throw new MemoryError('MEMORY_EVALUATION_OTHER_CONTENT');
    if (same(evaluation.evaluator, previous.provenance.author)) throw new MemoryError('MEMORY_SELF_VERIFICATION');
    if (evaluation.verdict !== 'pass') throw new MemoryError('MEMORY_EVALUATION_NOT_PASSED');
    verification = { basis: 'independent-evaluation', evaluator: { issuer: evaluation.evaluator.issuer, subject: evaluation.evaluator.subject }, record, verifiedAtMs: input.atMs };
  }
  return entry({ ...previous, revision: previous.revision + 1, state: 'verified', verification, updatedAtMs: input.atMs });
}

/** candidate|verified → retired, kept with its history. The AI may withdraw a candidate; retiring verified knowledge needs a human. */
export function retireMemoryEntry(previous: MemoryEntry, input: { readonly actor: Actor; readonly atMs: number; readonly reason: string;
  readonly supersededBy: string | null }): MemoryEntry {
  if (previous.state === 'retired') throw new MemoryError('MEMORY_TRANSITION_INVALID');
  if (previous.state === 'verified' && isAiPrincipal(input.actor)) throw new MemoryError('MEMORY_VERIFIER_NOT_HUMAN');
  if (!input.reason.trim() || bytes(input.reason) > MEMORY_LIMITS.reasonMaxBytes) throw new MemoryError('MEMORY_ENTRY_INVALID');
  return entry({ ...previous, revision: previous.revision + 1, state: 'retired',
    retirement: { by: who(input.actor), reason: input.reason, supersededBy: input.supersededBy, retiredAtMs: input.atMs }, updatedAtMs: input.atMs });
}
