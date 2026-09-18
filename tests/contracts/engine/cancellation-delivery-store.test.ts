import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { CancellationDeliveryError, type CancellationDeliveryLimits } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles, dispatchAdmission } from '../support/custody.js';

const roots: string[] = [];
const identity = Object.freeze({ runId: 'r', scopeId: 's', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 });
const limits: CancellationDeliveryLimits = Object.freeze({ maxAttempts: 2, retryDelayMs: 4, claimTtlMs: 10 });
const options = Object.freeze({ busyTimeoutMs: 100, journalMode: 'wal' as const, durability: 'full' as const });

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-cancellation-delivery-store-')); roots.push(root);
  const path = join(root, 'ledger.db');
  const seed = await openSqliteAttemptStore(path, options, 'allow', custodyProfiles);
  try {
    await admitRunAttempts(seed, [identity]);
    const claim = { owner: 'fixture', request: { protocolVersion: 1 as const, identity, workspace: '/recorded/workspace', argv: ['recorded-tool'] } };
    await seed.claimDispatch(dispatchAdmission(claim));
    await seed.cancelRun({ commandId: 'cancel', actor: { id: 'canceller', issuer: 'test', subject: 'fixture' }, scopeId: 's', runId: 'r', expectedRevision: 1 });
  } finally { seed.close(); }
  const one = await openSqliteAttemptStore(path, options, 'allow', custodyProfiles);
  const two = await openSqliteAttemptStore(path, options, 'allow', custodyProfiles);
  return { path, one, two };
}

function claim(token: string, now: number) { return { identity, token, now, limits }; }
function close(...stores: Awaited<ReturnType<typeof openSqliteAttemptStore>>[]) { for (const store of stores) store.close(); }

it('allows exactly one durable claim across two SQLite connections', async () => {
  const f = await fixture();
  try {
    const [first, second] = await Promise.all([f.one.claimCancellationDelivery(claim('first', 1)), f.two.claimCancellationDelivery(claim('second', 1))]);
    expect([first, second].filter(value => value.acquired)).toHaveLength(1);
    expect([first, second].find(value => value.acquired)?.record.token).toMatch(/first|second/);
  } finally { close(f.one, f.two); }
});

it('reclaims an expired lease and rejects the stale finisher', async () => {
  const f = await fixture();
  try {
    expect((await f.one.claimCancellationDelivery(claim('first', 1))).acquired).toBe(true);
    const retry = await f.two.claimCancellationDelivery(claim('second', 11));
    expect(retry).toMatchObject({ acquired: true, record: { token: 'second', attempts: 2 } });
    await expect(f.one.finishCancellationDelivery({ ...claim('first', 12), outcome: 'terminal' }))
      .rejects.toMatchObject({ code: 'CANCELLATION_DELIVERY_CONFLICT' } satisfies Partial<CancellationDeliveryError>);
    expect(await f.two.finishCancellationDelivery({ ...claim('second', 12), outcome: 'terminal' })).toMatchObject({ state: 'terminal' });
  } finally { close(f.one, f.two); }
});

it('persists exhaustion at the retry cap and never requeues terminal delivery', async () => {
  const f = await fixture();
  try {
    await f.one.claimCancellationDelivery(claim('first', 1));
    expect(await f.one.finishCancellationDelivery({ ...claim('first', 2), outcome: 'unresolved' })).toMatchObject({ state: 'queued' });
    await f.one.claimCancellationDelivery(claim('second', 6));
    expect(await f.one.finishCancellationDelivery({ ...claim('second', 7), outcome: 'unresolved' })).toMatchObject({ state: 'exhausted', attempts: 2 });
    expect(await f.two.claimCancellationDelivery(claim('third', 100))).toMatchObject({ acquired: false, record: { state: 'exhausted' } });
  } finally { close(f.one, f.two); }
});

it('never requeues a terminal delivery', async () => {
  const f = await fixture();
  try {
    await f.one.claimCancellationDelivery(claim('first', 1));
    expect(await f.one.finishCancellationDelivery({ ...claim('first', 2), outcome: 'terminal' })).toMatchObject({ state: 'terminal' });
    expect(await f.two.claimCancellationDelivery(claim('second', 100))).toMatchObject({ acquired: false, record: { state: 'terminal', token: 'first' } });
  } finally { close(f.one, f.two); }
});

it('rolls back a rejected journal write', async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.path);
  try {
    db.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON cancellation_deliveries BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    await expect(f.one.claimCancellationDelivery(claim('first', 1))).rejects.toThrow('fixture');
    expect(db.prepare('SELECT record FROM cancellation_deliveries WHERE scope_id=? AND attempt_id=?').get('s', 'a')).toBeUndefined();
  } finally { db.close(); close(f.one, f.two); }
});

it('refuses a journal claim without durable dispatch cancellation attribution', async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.path);
  try {
    const row = db.prepare('SELECT record FROM dispatches WHERE scope_id=? AND attempt_id=?').get('s', 'a')!;
    const dispatch = JSON.parse(String(row.record)); delete dispatch.cancellation;
    db.prepare('UPDATE dispatches SET record=? WHERE scope_id=? AND attempt_id=?').run(JSON.stringify(dispatch), 's', 'a');
    await expect(f.one.claimCancellationDelivery(claim('first', 1))).rejects.toMatchObject({ code: 'CANCELLATION_DELIVERY_CONFLICT' });
    expect(db.prepare('SELECT record FROM cancellation_deliveries WHERE scope_id=? AND attempt_id=?').get('s', 'a')).toBeUndefined();
  } finally { db.close(); close(f.one, f.two); }
});
