import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { RunApplication } from '#engine/index.js';
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

it.each(['RunApplication', 'dispatch store'] as const)('%s cancellation durably marks the Attempt and prevents launch', async source => {
  const store = await fixture();
  if (source === 'RunApplication') {
    const app = new RunApplication(store, verifier, authorization);
    await app.execute({ schemaVersion: 1, commandId: 'cancel-run', scopeId: 's', runId: 'r', action: 'cancel', expectedRevision: 1 });
  } else {
    await store.requestDispatchCancellation(claim.request, custodyPrincipal);
  }
  expect((await store.load('s', 'a'))?.cancelRequested).toBe(true);
  const decision = await grantTestLaunch(store, claim, 42);
  expect(decision).toMatchObject({ kind: 'prevented', record: { launch: 'prevented-before-launch',
    cancellation: { id: custodyPrincipal.id, issuer: custodyPrincipal.issuer, subject: custodyPrincipal.subject },
    prevention: { reason: 'cancel-requested' } } });
});
