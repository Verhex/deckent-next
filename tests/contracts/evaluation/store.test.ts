import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 };
const request = { protocolVersion: 1 as const, identity, workspace: '/workspace', argv: ['task'] };
const claim = { request, owner: 'worker' }; const actor = { id: 'evaluator', issuer: 'test', subject: 'service' };
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-evaluation-store-')); roots.push(root); const path = join(root, 'ledger.db');
  const open = async () => { const store = await openSqliteAttemptStore(path, options, 'allow', custodyProfiles); stores.push(store); return store; };
  const store = await open(); await admitRunAttempts(store, [identity]); await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  await store.retainDispatchOutput(claim, { schemaVersion: 1, scopeId: 's', digest: 'a'.repeat(64), byteLength: 10 });
  await store.finishDispatch(claim, { handle: 'h', exitCode: 0, interrupted: false });
  return { root, path, store, open };
}
async function commit(store: SqliteAttemptStore, evaluationId = 'evaluation', verdict: 'pass' | 'fail' = 'pass') {
  const dispatch = (await store.readDispatch(request))!;
  return { commandId: evaluationId, actor, expectedRevision: 2, dispatch, evaluation: { schemaVersion: 1 as const, evaluationId,
    identity, graphRevision: 1, attemptRevision: 1, criteria: [{ criterionId: 'verified', verdict, evidenceIds: ['proof'] }] } };
}

it('atomically accepts, reopens and exactly replays normalized criterion evidence', async () => {
  const f = await fixture(); const input = await commit(f.store); input.evaluation.criteria[0]!.evidenceIds = ['z', 'proof'];
  const first = await f.store.commitTaskEvaluation(input); expect(first.snapshot.progress[0]!.phase).toBe('accepted');
  f.store.close(); stores.splice(stores.indexOf(f.store), 1); const reopened = await f.open();
  const replay = await commit(reopened); replay.evaluation.criteria[0]!.evidenceIds = ['proof', 'z'];
  expect(await reopened.commitTaskEvaluation(replay)).toEqual(first);
});

it('rejects command/evaluation mismatch, changed actor and conflicting verdict', async () => {
  const f = await fixture(); const input = await commit(f.store);
  await expect(f.store.commitTaskEvaluation({ ...input, commandId: 'other' })).rejects.toThrow();
  await f.store.commitTaskEvaluation(input);
  await expect(f.store.commitTaskEvaluation({ ...input, actor: { ...actor, subject: 'other' } })).rejects.toThrow('RUN_COMMAND_CONFLICT');
  await expect(f.store.commitTaskEvaluation(await commit(f.store, 'evaluation', 'fail'))).rejects.toThrow('RUN_COMMAND_CONFLICT');
});

it('rejects stale Attempt, cancellation and a dispatch changed after application verification', async () => {
  const stale = await fixture(); const staleInput = await commit(stale.store);
  staleInput.evaluation.attemptRevision = 2;
  await expect(stale.store.commitTaskEvaluation(staleInput)).rejects.toThrow('TASK_EVALUATION_STALE');

  const cancelled = await fixture(); const db = new DatabaseSync(cancelled.path);
  try {
    const row = db.prepare("SELECT snapshot FROM attempts WHERE scope_id='s' AND attempt_id='a'").get()!;
    const snapshot = JSON.parse(String(row.snapshot)); snapshot.cancelRequested = true;
    db.prepare("UPDATE attempts SET snapshot=? WHERE scope_id='s' AND attempt_id='a'").run(JSON.stringify(snapshot));
  } finally { db.close(); }
  await expect(cancelled.store.commitTaskEvaluation(await commit(cancelled.store))).rejects.toThrow('TASK_EVALUATION_NOT_READY');

  const changed = await fixture(); const changedInput = await commit(changed.store);
  const changedDb = new DatabaseSync(changed.path);
  try {
    const row = changedDb.prepare("SELECT record FROM dispatches WHERE scope_id='s' AND attempt_id='a'").get()!;
    const record = JSON.parse(String(row.record)); record.owner = 'changed-after-verification';
    changedDb.prepare("UPDATE dispatches SET record=? WHERE scope_id='s' AND attempt_id='a'").run(JSON.stringify(record));
  } finally { changedDb.close(); }
  await expect(changed.store.commitTaskEvaluation(changedInput)).rejects.toThrow('TASK_EVALUATION_STALE');
});

it('rolls the Run transition back when receipt insertion fails', async () => {
  const f = await fixture(); const before = await f.store.loadRun('s', 'r'); const db = new DatabaseSync(f.path);
  try {
    db.exec("CREATE TRIGGER reject_evaluation BEFORE INSERT ON run_receipts WHEN NEW.command_id='evaluation' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    await expect(f.store.commitTaskEvaluation(await commit(f.store))).rejects.toThrow();
    expect(await f.store.loadRun('s', 'r')).toEqual(before); expect(await f.store.loadRunReceipt('s', 'evaluation')).toBeNull();
  } finally { db.close(); }
});

it('allows only one of two independent evaluation commands at the same Run revision', async () => {
  const f = await fixture(); const other = await f.open();
  const outcomes = await Promise.allSettled([f.store.commitTaskEvaluation(await commit(f.store, 'evaluation-a')),
    other.commitTaskEvaluation(await commit(other, 'evaluation-b'))]);
  expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1);
  expect((await f.store.loadRun('s', 'r'))!.revision).toBe(3);
});
