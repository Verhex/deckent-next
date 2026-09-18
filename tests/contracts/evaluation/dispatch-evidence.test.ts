import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, FileArtifactStore, type SqliteAttemptStore } from '#adapters/index.js';
import { verifyDispatchEvaluationEvidence } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const s of stores.splice(0)) s.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 };
const request = { protocolVersion: 1 as const, identity, workspace: '/private/workspace', argv: ['task'] };
const evaluation = { schemaVersion: 1, evaluationId: 'e', identity, graphRevision: 1, attemptRevision: 1, criteria: [{ criterionId: 'verified', verdict: 'pass', evidenceIds: ['proof'] }] };
const limits = { maxEvidenceItems: 2, maxTotalBytes: 1024 };
const envelope = (changes: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ schemaVersion: 1, identity,
  completeness: 'complete', stdout: 'observed output', stderr: '', ...changes }));
async function fixture(bytes = envelope()) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-task-evidence-')); roots.push(root);
  const db = join(root, 'ledger.db'); const options = { busyTimeoutMs: 20, journalMode: 'wal' as const, durability: 'full' as const };
  const store = await openSqliteAttemptStore(db, options, 'allow', custodyProfiles); stores.push(store); await admitRunAttempts(store, [identity]);
  await mkdir(join(root, 'artifacts'), { mode: 0o700 });
  const artifacts = new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 1024 });
  const receipt = await artifacts.put('s', bytes); const claim = { request, owner: 'supervisor' };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim); await store.retainDispatchOutput(claim, receipt);
  return { store, artifacts, receipt, claim, db, options };
}
it.skipIf(process.platform === 'win32')('binds real reopened ledger output and artifact bytes without mutating Run or Attempt', async () => {
  const f = await fixture(); await f.store.finishDispatch(f.claim, { handle: 'h', exitCode: 7, interrupted: false });
  const reopened = await openSqliteAttemptStore(f.db, f.options, 'allow', custodyProfiles); stores.push(reopened);
  const runBefore = await reopened.loadRun('s', 'r'); const attemptBefore = await reopened.load('s', 'a');
  const before = await reopened.readDispatch(request); const manifest = [{ evidenceId: 'proof', receipt: f.receipt }];
  expect(await verifyDispatchEvaluationEvidence(evaluation, request, manifest, reopened, f.artifacts, limits)).toEqual(manifest);
  expect(await reopened.readDispatch(request)).toEqual(before);
  expect(await reopened.loadRun('s', 'r')).toEqual(runBefore); expect(await reopened.load('s', 'a')).toEqual(attemptBefore);
});
it.skipIf(process.platform === 'win32').each([
  ['foreign identity', () => envelope({ identity: { ...identity, generation: 2 } })],
  ['partial output', () => envelope({ completeness: 'partial' })],
  ['unavailable output', () => envelope({ completeness: 'unavailable' })],
  ['malformed UTF-8', () => Buffer.from([0xc3, 0x28])],
  ['malformed JSON', () => Buffer.from('{"schemaVersion":1')],
] as const)('rejects retained %s after one bounded artifact read', async (_name, content) => {
  const f = await fixture(content()); await f.store.finishDispatch(f.claim, { handle: 'h', exitCode: 0, interrupted: false });
  const manifest = [{ evidenceId: 'proof', receipt: f.receipt }]; let reads = 0;
  await expect(verifyDispatchEvaluationEvidence(evaluation, request, manifest, f.store, {
    async read(scopeId, receipt) { reads++; return f.artifacts.read(scopeId, receipt); },
  }, limits)).rejects.toThrow('TASK_EVIDENCE_UNLINKED');
  expect(reads).toBe(1);
});
it.skipIf(process.platform === 'win32').each([
  ['oversized bytes', () => Buffer.alloc(2048, 1)],
  ['malformed tampered bytes', () => Buffer.from('{not-json')],
] as const)('preserves artifact corruption precedence for %s returned against a valid receipt', async (_name, content) => {
  const f = await fixture(); await f.store.finishDispatch(f.claim, { handle: 'h', exitCode: 0, interrupted: false });
  const manifest = [{ evidenceId: 'proof', receipt: f.receipt }]; let reads = 0;
  await expect(verifyDispatchEvaluationEvidence(evaluation, request, manifest, f.store, {
    async read() { reads++; return content(); },
  }, limits)).rejects.toMatchObject({ code: 'EVALUATION_EVIDENCE_CORRUPT' });
  expect(reads).toBe(1);
});
it.skipIf(process.platform === 'win32')('rejects manifest byte budget before reading retained output', async () => {
  const f = await fixture(); await f.store.finishDispatch(f.claim, { handle: 'h', exitCode: 0, interrupted: false }); let reads = 0;
  await expect(verifyDispatchEvaluationEvidence(evaluation, request, [{ evidenceId: 'proof', receipt: f.receipt }], f.store, {
    async read() { reads++; return envelope(); },
  }, { ...limits, maxTotalBytes: 1 })).rejects.toMatchObject({ code: 'EVALUATION_EVIDENCE_LIMIT' });
  expect(reads).toBe(0);
});
it.skipIf(process.platform === 'win32')('rejects unresolved execution and an existing same-scope artifact not retained by this attempt', async () => {
  const f = await fixture(); const manifest = [{ evidenceId: 'proof', receipt: f.receipt }];
  await expect(verifyDispatchEvaluationEvidence(evaluation, request, manifest, f.store, f.artifacts, limits)).rejects.toThrow('TASK_EVIDENCE_UNLINKED');
  await f.store.finishDispatch(f.claim, { handle: 'h', exitCode: 0, interrupted: false });
  const foreign = await f.artifacts.put('s', Buffer.from('unrelated output')); let reads = 0;
  await expect(verifyDispatchEvaluationEvidence(evaluation, request, [{ evidenceId: 'proof', receipt: foreign }], f.store, { async read() { reads++; return new Uint8Array(); } }, limits)).rejects.toThrow('TASK_EVIDENCE_UNLINKED');
  expect(reads).toBe(0);
});
it.skipIf(process.platform === 'win32')('rejects substituted identity or ledger records and sanitizes ledger failures', async () => {
  const f = await fixture(); await f.store.finishDispatch(f.claim, { handle: 'h', exitCode: 0, interrupted: false });
  const manifest = [{ evidenceId: 'proof', receipt: f.receipt }]; const record = (await f.store.readDispatch(request))!;
  await expect(verifyDispatchEvaluationEvidence({ ...evaluation, identity: { ...identity, generation: 2 } }, request, manifest, f.store, f.artifacts, limits)).rejects.toThrow('TASK_EVIDENCE_UNLINKED');
  await expect(verifyDispatchEvaluationEvidence(evaluation, request, manifest, { async readDispatch() { return { ...record, request: { ...request, argv: ['other'] } }; } }, f.artifacts, limits)).rejects.toThrow('TASK_EVIDENCE_UNLINKED');
  for (const missing of [null, { ...record, output: undefined }, { ...record, request: { ...request, identity: { ...identity, scopeId: 'foreign' } } }]) {
    await expect(verifyDispatchEvaluationEvidence(evaluation, request, manifest, { async readDispatch() { return missing; } }, f.artifacts, limits)).rejects.toThrow('TASK_EVIDENCE_UNLINKED');
  }
  await expect(verifyDispatchEvaluationEvidence(evaluation, request, manifest, { async readDispatch() { throw new Error('/secret/db'); } }, f.artifacts, limits)).rejects.toMatchObject({ message: 'TASK_EVIDENCE_UNAVAILABLE' });
});
