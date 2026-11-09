import { z } from 'zod';
import { sha256 } from '#platform/index.js';
import { ApprovalError, approvalSubject, approvalSummarySchema, isAiPrincipal, attemptIdentitySchema, type ApprovalRecord, type VerifiedPrincipal } from '#domain/index.js';

/** Producer-owned metadata inside the sealed request. No arguments, login material or caller-supplied approval authority. */
const workerCardSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('worker-tool-call'), identity: attemptIdentitySchema,
  tool: z.string().min(1), resource: z.string(), resourceDigest: z.string().regex(/^[a-f0-9]{64}$/u), argsDigest: z.string().regex(/^[a-f0-9]{64}$/u), turnId: z.string().min(1) });
export type WorkerToolCard = z.infer<typeof workerCardSchema>;
export const workerToolCardSummary = (input: Omit<WorkerToolCard, 'schemaVersion' | 'kind' | 'resourceDigest'> & { resourceDigest?: string }): string => {
  const card = workerCardSchema.parse({ schemaVersion: 1, kind: 'worker-tool-call', ...input, resourceDigest: input.resourceDigest ?? sha256(input.resource) });
  // A6-2 (owner 2026-11-08, alpha.63.2): a summary over the contract bound was cut when stored, and a cut card no longer parsed, so its
  // interactive-human rule was skipped. The display resource is shortened instead (its digest still binds the full target); a card that cannot fit is refused.
  const fits = (text: string) => approvalSummarySchema.safeParse(text).success, full = JSON.stringify(card);
  if (fits(full)) return full;
  const points = Array.from(card.resource), shown = (count: number) => JSON.stringify({ ...card, resource: points.slice(0, count).join('') + '…' });
  if (!fits(shown(0))) throw new ApprovalError('APPROVAL_INVALID');
  let low = 0, high = points.length - 1; // the longest shown prefix that fits
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(shown(mid))) low = mid; else high = mid - 1; }
  return shown(low);
};
/** Sealed producer metadata also used by authority checks: verify the record and bind these fields to its subject before trusting them. */
export function readWorkerToolCard(summary: string): WorkerToolCard | null {
  try { const parsed = workerCardSchema.safeParse(JSON.parse(summary)); return parsed.success ? parsed.data : null; } catch { return null; }
}

type DecisionMinter = { mint(binding: { scopeId: string; approvalId: string; principal: Pick<VerifiedPrincipal, 'issuer' | 'subject'>;
  peerPid: number; expiresAt: number }, nowMs: number): string };
/** No full-text display receipt exists on stored cards: a cut (or legacy absent preview) cannot authorize an allow. */
export function workerToolPreviewComplete(record: ApprovalRecord): boolean {
  const preview = record.request.schemaVersion === 3 ? record.request.preview : undefined, subject = approvalSubject(record.request);
  return subject.kind === 'agent-tool-call' && !!preview && preview.argsDigest === subject.argsDigest && preview.text.length > 0 && !preview.cut;
}
/** Same single-use ring as a conversation card, minted only after the service witnessed this deciding peer's terminal. */
export function mintAttendedWorkerDecision(record: ApprovalRecord | null, principal: VerifiedPrincipal, peerPid: number,
  interactive: boolean, decisions: DecisionMinter, nowMs: number): string | null {
  if (!record || !interactive || isAiPrincipal(principal) || record.status !== 'pending' || nowMs >= record.request.expiresAt) return null;
  const worker = readWorkerToolCard(record.request.summary), subject = approvalSubject(record.request);
  if (!worker || subject.kind !== 'agent-tool-call' || worker.identity.scopeId !== record.request.scopeId || worker.turnId !== subject.turnId
    || worker.tool !== subject.tool || worker.resourceDigest !== sha256(subject.resource) || worker.argsDigest !== subject.argsDigest
    || !workerToolPreviewComplete(record)) return null;
  return decisions.mint({ scopeId: record.request.scopeId, approvalId: record.request.approvalId, principal, peerPid,
    expiresAt: record.request.expiresAt }, nowMs);
}
