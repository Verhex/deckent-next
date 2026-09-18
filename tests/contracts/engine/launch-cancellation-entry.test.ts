import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { AttemptApplication, RunApplication } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyPrincipal, custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
const identity = { runId: 'r', scopeId: 's', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 };
const claim = { owner: 'worker', request: { protocolVersion: 1 as const, identity, workspace: '/workspace', argv: ['tool'] } };
const verifier = { async verify() { return custodyPrincipal; } };
const authorization = { async authorize() {} };

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-launch-cancel-entry-')); roots.push(root);
  const store = await openSqliteAttemptStore(join(root, 'ledger.db'),
    { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, 'allow', custodyProfiles);
  stores.push(store); await admitRunAttempts(store, [identity]); await store.claimDispatch(dispatchAdmission(claim));
  return store;
}

it.each(['RunApplication', 'AttemptApplication', 'dispatch store'] as const)('%s cancellation durably marks the Attempt and prevents launch', async source => {
  const store = await fixture();
  if (source === 'RunApplication') {
    const app = new RunApplication(store, verifier, authorization);
    await app.execute({ schemaVersion: 1, commandId: 'cancel-run', scopeId: 's', runId: 'r', action: 'cancel', expectedRevision: 1 });
  } else if (source === 'AttemptApplication') {
    const app = new AttemptApplication(store, authorization, verifier);
    await app.execute({ schemaVersion: 2, commandId: 'cancel-attempt', scopeId: 's', action: { kind: 'cancel', attemptId: 'a' } });
  } else {
    await store.requestDispatchCancellation(claim.request, custodyPrincipal);
  }
  expect((await store.load('s', 'a'))?.cancelRequested).toBe(true);
  const decision = await grantTestLaunch(store, claim, 42);
  expect(decision).toMatchObject({ kind: 'prevented', record: { launch: 'prevented-before-launch',
    cancellation: { id: custodyPrincipal.id, issuer: custodyPrincipal.issuer, subject: custodyPrincipal.subject },
    prevention: { reason: 'cancel-requested' } } });
});

it('replays AttemptApplication cancellation with its original attribution', async () => {
  const store = await fixture(); const app = new AttemptApplication(store, authorization, verifier);
  const command = { schemaVersion: 2 as const, commandId: 'cancel-attempt', scopeId: 's', action: { kind: 'cancel' as const, attemptId: 'a' } };
  const first = await app.execute(command); expect(await app.execute(command)).toEqual(first);
  expect((await store.readDispatch(claim.request))?.cancellation).toEqual({
    id: custodyPrincipal.id, issuer: custodyPrincipal.issuer, subject: custodyPrincipal.subject,
  });
});

it('rolls back Attempt and dispatch attribution when the cancellation receipt cannot be written', async () => {
  const store = await fixture(); const app = new AttemptApplication(store, authorization, verifier);
  const db = new DatabaseSync(join(roots.at(-1)!, 'ledger.db'));
  try {
    db.exec("CREATE TRIGGER reject_attempt_cancel BEFORE INSERT ON attempt_receipts WHEN NEW.command_id='cancel-attempt' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    await expect(app.execute({ schemaVersion: 2, commandId: 'cancel-attempt', scopeId: 's', action: { kind: 'cancel', attemptId: 'a' } })).rejects.toThrow();
    expect((await store.load('s', 'a'))?.cancelRequested).toBe(false);
    expect((await store.readDispatch(claim.request))?.cancellation).toBeUndefined();
  } finally { db.close(); }
});

it('rejects foreign dispatch identity and rolls the Attempt cancellation back', async () => {
  const store = await fixture(); const app = new AttemptApplication(store, authorization, verifier);
  const db = new DatabaseSync(join(roots.at(-1)!, 'ledger.db'));
  try {
    const row = db.prepare("SELECT record FROM dispatches WHERE scope_id='s' AND attempt_id='a'").get()!;
    const record = JSON.parse(String(row.record)); record.request.identity.generation = 2;
    db.prepare("UPDATE dispatches SET record=? WHERE scope_id='s' AND attempt_id='a'").run(JSON.stringify(record));
    await expect(app.execute({ schemaVersion: 2, commandId: 'cancel-attempt', scopeId: 's', action: { kind: 'cancel', attemptId: 'a' } }))
      .rejects.toThrow('ATTEMPT_STORE_CORRUPT');
    expect((await store.load('s', 'a'))?.cancelRequested).toBe(false);
    expect(await store.receipt('s', 'cancel-attempt')).toBeNull();
  } finally { db.close(); }
});

it('does not replace conflicting dispatch cancellation attribution', async () => {
  const store = await fixture();
  const first = { ...custodyPrincipal, id: 'first-canceller' };
  await store.requestDispatchCancellation(claim.request, first);
  const app = new AttemptApplication(store, authorization, verifier);
  await expect(app.execute({ schemaVersion: 2, commandId: 'cancel-attempt', scopeId: 's', action: { kind: 'cancel', attemptId: 'a' } }))
    .rejects.toThrow('ATTEMPT_COMMAND_CONFLICT');
  expect((await store.readDispatch(claim.request))?.cancellation?.id).toBe('first-canceller');
  expect(await store.receipt('s', 'cancel-attempt')).toBeNull();
});
