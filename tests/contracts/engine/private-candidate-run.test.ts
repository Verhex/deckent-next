import { describe, expect, it } from 'vitest';
import { candidateBindingSchema } from '#domain/index.js';
import { pinRunToCandidate } from '#engine/index.js';
const candidate = candidateBindingSchema.parse({ schemaVersion: 1, target: { schemaVersion: 1, installationId: 'i', adapter: { id: 'adapter', version: 1 },
  resourceBinding: 'a'.repeat(64), target: { kind: 'record', id: 'entity' } },
  identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' },
  sourceBinding: 'b'.repeat(64), outputDigest: 'c'.repeat(64), observedVersion: 'V7', effectiveVersion: 'V8', candidateVersion: 'V9',
  candidateDigest: 'd'.repeat(64), custodyReceipt: 'e'.repeat(64), criteria: ['f'.repeat(64)], profileFingerprint: 'a'.repeat(64), replacesCommandId: null });
const source = { schemaVersion: 1 as const, adapter: { id: 'adapter', version: 1 }, sourceFingerprint: candidate.sourceBinding };
const request = { scopeId: 's', runId: 'verify-run', candidateCommandId: 'candidate-command' };
describe('service-only private candidate Run custody', () => {
  it('pins the exact unpublished candidate and checks output authorization before capture', async () => {
    const calls: string[] = [];
    const custody = await pinRunToCandidate({ async loadCandidate(scopeId, commandId) { expect([scopeId, commandId]).toEqual(['s', 'candidate-command']); return candidate; } },
      { async capture(value) { expect(value).toEqual(candidate); calls.push('capture'); return { source, baseRevision: 'V9' }; } },
      async identity => { expect(identity).toEqual(candidate.identity); calls.push('authorize'); }, request);
    expect(calls).toEqual(['authorize', 'capture']); expect(custody).toEqual({ schemaVersion: 1, scopeId: 's', runId: 'verify-run', source, baseRevision: 'V9' });
  });
  it.each(['foreign-scope', 'foreign-source', 'foreign-version', 'missing'] as const)('refuses %s custody', async kind => {
    await expect(pinRunToCandidate({ async loadCandidate() { return kind === 'missing' ? null : kind === 'foreign-scope' ? { ...candidate, identity: { ...candidate.identity, scopeId: 'other' } } : candidate; } },
      { async capture() { return { source: kind === 'foreign-source' ? { ...source, sourceFingerprint: '0'.repeat(64) } : source,
        baseRevision: kind === 'foreign-version' ? 'V10' : 'V9' }; } }, async () => {}, request)).rejects.toThrow('CANDIDATE_MISMATCH');
  });
  it('does not touch the candidate on output permission refusal', async () => {
    let captured = false;
    await expect(pinRunToCandidate({ async loadCandidate() { return candidate; } }, { async capture() { captured = true; return { source, baseRevision: 'V9' }; } },
      async () => { throw new Error('permission-denied'); }, request)).rejects.toThrow('permission-denied');
    expect(captured).toBe(false);
  });
});
