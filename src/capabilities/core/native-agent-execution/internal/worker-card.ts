import { z } from 'zod';
import { sha256 } from '#platform/index.js';
import { approvalSubject, isAiPrincipal, attemptIdentitySchema, type ApprovalRecord, type VerifiedPrincipal } from '#domain/index.js';

/** Producer-owned metadata inside the sealed request. No arguments, login material or caller-supplied approval authority. */
const workerCardSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('worker-tool-call'), identity: attemptIdentitySchema,
  tool: z.string().min(1), resource: z.string(), resourceDigest: z.string().regex(/^[a-f0-9]{64}$/u), argsDigest: z.string().regex(/^[a-f0-9]{64}$/u), turnId: z.string().min(1) });
export type WorkerToolCard = z.infer<typeof workerCardSchema>;
export const workerToolCardSummary = (input: Omit<WorkerToolCard, 'schemaVersion' | 'kind' | 'resourceDigest'> & { resourceDigest?: string }): string =>
  JSON.stringify(workerCardSchema.parse({ schemaVersion: 1, kind: 'worker-tool-call', ...input, resourceDigest: input.resourceDigest ?? sha256(input.resource) }));
/** Display copies only. Authority consumers must additionally use the verified record and compare its subject below. */
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
