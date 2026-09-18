import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { FileArtifactStore } from '#adapters/index.js';
import { verifyEvaluationEvidence } from '#capabilities/index.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const evaluation = { schemaVersion: 1, evaluationId: 'e', identity: { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 }, graphRevision: 1, attemptRevision: 1,
  criteria: [{ criterionId: 'verified', verdict: 'pass', evidenceIds: ['proof'] }] };
const limits = { maxEvidenceItems: 2, maxTotalBytes: 1024 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-evidence-')); roots.push(root);
  const store = new FileArtifactStore({ root, maxBytes: 1024 }); const receipt = await store.put('s', Buffer.from('verified result'));
  return { root, store, manifest: [{ evidenceId: 'proof', receipt }] };
}
it.skipIf(process.platform === 'win32')('resolves real persisted scoped evidence across reopen and rejects changed content', async () => {
  const f = await fixture(); const store = new FileArtifactStore({ root: f.root, maxBytes: 1024 });
  expect(await verifyEvaluationEvidence(evaluation, f.manifest, store, limits)).toEqual(f.manifest);
  const path = join(f.root, createHash('sha256').update('s').digest('hex'), f.manifest[0]!.receipt.digest);
  await writeFile(path, 'tampered result');
  await expect(verifyEvaluationEvidence(evaluation, f.manifest, store, limits)).rejects.toThrow('EVALUATION_EVIDENCE_CORRUPT');
});
it.skipIf(process.platform === 'win32')('checks the entire manifest before reading and bounds total declared bytes', async () => {
  const f = await fixture(); let reads = 0; const reader = { async read() { reads++; return new Uint8Array(); } };
  await expect(verifyEvaluationEvidence(evaluation, [], reader, limits)).rejects.toThrow('EVALUATION_EVIDENCE_INCOMPLETE');
  await expect(verifyEvaluationEvidence(evaluation, [...f.manifest, ...f.manifest], reader, limits)).rejects.toThrow('EVALUATION_EVIDENCE_INCOMPLETE');
  await expect(verifyEvaluationEvidence(evaluation, [{ ...f.manifest[0], receipt: { ...f.manifest[0]!.receipt, scopeId: 'foreign' } }], reader, limits)).rejects.toThrow('EVALUATION_EVIDENCE_SCOPE');
  await expect(verifyEvaluationEvidence(evaluation, f.manifest, reader, { ...limits, maxTotalBytes: 1 })).rejects.toThrow('EVALUATION_EVIDENCE_LIMIT');
  await expect(verifyEvaluationEvidence(evaluation, [...f.manifest, ...f.manifest], reader, { ...limits, maxEvidenceItems: 1 })).rejects.toThrow('EVALUATION_EVIDENCE_LIMIT');
  expect(reads).toBe(0);
});
it.skipIf(process.platform === 'win32')('does not trust an adapter returning bytes that disagree with the receipt and redacts failures', async () => {
  const f = await fixture();
  await expect(verifyEvaluationEvidence(evaluation, f.manifest, { async read() { return Buffer.from('wrong contents!'); } }, limits)).rejects.toThrow('EVALUATION_EVIDENCE_CORRUPT');
  await expect(verifyEvaluationEvidence(evaluation, f.manifest, { async read() { throw new Error('/private/secret-path'); } }, limits)).rejects.toMatchObject({ code: 'EVALUATION_EVIDENCE_UNAVAILABLE', message: 'EVALUATION_EVIDENCE_UNAVAILABLE' });
});
it('permits empty evidence for unknown criteria without inventing a proof or reading storage', async () => {
  const reader = { async read(): Promise<Uint8Array> { throw new Error('must not read'); } };
  const unknown = { ...evaluation, criteria: [{ criterionId: 'verified', verdict: 'unknown', evidenceIds: [] }] };
  expect(await verifyEvaluationEvidence(unknown, [], reader, limits)).toEqual([]);
});
