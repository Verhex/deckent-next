import { targetQueueKey } from '#engine/index.js';
import { describe, expect, it } from 'vitest';
import { assertCandidateEvidence, candidateBindingSchema, candidateEvidenceSchema, targetBindingSchema } from '#domain/index.js';
const target = targetBindingSchema.parse({ schemaVersion: 1, installationId: 'installation', adapter: { id: 'adapter', version: 1 },
  resourceBinding: 'a'.repeat(64), target: { kind: 'record', id: 'opaque-key' } });
const candidate = candidateBindingSchema.parse({ schemaVersion: 1, target,
  identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' },
  sourceBinding: 'b'.repeat(64), outputDigest: 'c'.repeat(64), observedVersion: 'V7', effectiveVersion: 'V8', candidateVersion: 'V9',
  candidateDigest: 'd'.repeat(64), custodyReceipt: 'e'.repeat(64), criteria: ['f'.repeat(64)], profileFingerprint: 'a'.repeat(64), replacesCommandId: null });
const evidence = candidateEvidenceSchema.parse({ ...Object.fromEntries(['identity', 'sourceBinding', 'candidateVersion', 'candidateDigest', 'custodyReceipt', 'criteria', 'profileFingerprint'].map(key => [key, candidate[key as keyof typeof candidate]])),
  schemaVersion: 1, evidenceReceipt: 'b'.repeat(64), phase: 'accepted' });
describe('opaque candidate custody', () => {
  it('supports non-code record versions and does not accept client paths as schema extensions', () => {
    expect(() => assertCandidateEvidence(candidate, evidence)).not.toThrow();
    expect(targetBindingSchema.safeParse({ ...target, path: '/some/repository' }).success).toBe(false);
    expect(candidateBindingSchema.safeParse({ ...candidate, commit: 'arbitrary' }).success).toBe(false);
    expect(targetQueueKey(target)).toBe(targetQueueKey({ ...target, target: { id: 'opaque-key', kind: 'record' } }));
    expect(targetQueueKey({ ...target, adapter: { ...target.adapter, version: 2 } })).toBe(targetQueueKey(target));
    expect(targetQueueKey({ ...target, resourceBinding: 'b'.repeat(64) })).not.toBe(targetQueueKey(target));
  });
  it.each(['sourceBinding', 'candidateVersion', 'candidateDigest', 'custodyReceipt', 'profileFingerprint', 'criteria', 'identity'] as const)('refuses foreign or weaker %s evidence', key => {
    const replacement = key === 'criteria' ? [] : key === 'identity' ? { ...evidence.identity, attemptId: 'other' } : key === 'candidateVersion' ? 'V10' : '0'.repeat(64);
    expect(() => assertCandidateEvidence(candidate, { ...evidence, [key]: replacement })).toThrow();
  });
  it.each(['failed', 'pending', 'cancelled', 'unknown'] as const)('does not promote %s to acceptance', phase => {
    expect(() => assertCandidateEvidence(candidate, { ...evidence, phase })).toThrow('CANDIDATE_NOT_ACCEPTED');
  });
});
