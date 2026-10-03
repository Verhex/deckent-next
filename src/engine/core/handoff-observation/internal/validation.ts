import { createHash } from 'node:crypto';
import { readWorkerFinalReport, sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';
import type { verifyRetainedOutputEnvelope } from '#engine/core/dispatch/index.js';
export class HandoffError extends Error {
  constructor(readonly code: 'HANDOFF_SOURCE_NOT_ACCEPTED' | 'HANDOFF_ARTIFACT_MISMATCH' | 'HANDOFF_PATCH_UNAPPLICABLE' | 'HANDOFF_INVALID' | 'HANDOFF_LIMIT_EXCEEDED') { super(code); this.name = 'HandoffError'; }
}
export function verifyAcceptedHandoffSource(expected: AttemptIdentity, recorded: AttemptIdentity, phase: string | undefined) {
  if (phase !== 'accepted' || !sameAttemptIdentity(expected, recorded)) throw new HandoffError('HANDOFF_SOURCE_NOT_ACCEPTED');
}
/** Pure claim validation against the host-recorded output. This never decides task acceptance. */
export function evaluateHandoff(output: ReturnType<typeof verifyRetainedOutputEnvelope>) {
  const reported = readWorkerFinalReport(output.stdout);
  if (reported.status !== 'reported') return reported.reason === 'invalid' || reported.reason === 'oversized'
    ? { status: 'invalid' as const, code: 'HANDOFF_INVALID' as const } : undefined;
  const note = reported.report.handoff;
  if (!note) return undefined;
  if (new Set(note.artifacts.map(item => item.name)).size !== note.artifacts.length || note.artifacts.some(item => {
    const file = output.files?.find(file => file.name === item.name);
    return !file || file.status !== 'collected' || file.receipt.digest !== item.digest || file.receipt.scopeId !== output.identity.scopeId;
  })) return { status: 'invalid' as const, code: 'HANDOFF_ARTIFACT_MISMATCH' as const };
  return { status: 'valid' as const, digest: createHash('sha256').update(JSON.stringify(note)).digest('hex') };
}
