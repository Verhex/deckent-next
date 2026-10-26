import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { SqliteRunProposals } from '#adapters/core/run-proposal-store/index.js';
import { migrateLedger } from '#adapters/core/sqlite-ledger/index.js';
import { RunIntentApplication, type SetupIntentFact } from '#engine/index.js';
import { ErrorRegistry } from '#platform/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
it('U4-1p: durable park/replay/conflict, fact once, release creates no Run, explicit witnessed start and terminal cancel', async () => {
  const db = new DatabaseSync(':memory:'); migrateLedger(db, 'allow');
  const store = new SqliteRunProposals(db), principal: VerifiedPrincipal = { id: 'person', issuer: 'os', subject: 'p', assurance: 'os-user', scopeIds: ['s'] };
  let fact: SetupIntentFact = { id: 'consent', revision: 1, basis: 'a'.repeat(64), ready: false, reason: 'WORKER_SETUP_PENDING', params: { phase: 'acquiring' } };
  let witnessed = true;
  const owner = new RunIntentApplication(store, { verify: async () => principal }, { authorize: async () => {} },
    { sample: () => ({ wallMs: 100, monotonicMs: 100 }) }, async () => fact,
    async () => { if (!witnessed) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED'); });
  const command = { schemaVersion: 1 as const, commandId: 'first', scopeId: 's', intent: 'Summarize the purchase process' };
  try {
    const waiting = await owner.preflight(command); expect(waiting?.intent.status).toBe('parked');
    expect(await owner.preflight(command)).toEqual(waiting);
    await expect(owner.preflight({ ...command, intent: 'changed' })).rejects.toMatchObject({ code: 'RUN_PROPOSAL_COMMAND_CONFLICT' });
    expect(db.prepare('SELECT count(*) AS n FROM runs').get()?.n).toBe(0);
    fact = { ...fact, revision: 2, basis: 'b'.repeat(64), ready: true, params: { phase: 'ready' } };
    const release = { command, commandId: 'ready', expectedRevision: 0, action: 'fact' as const };
    const released = await owner.transition(release); expect(released.intent.status).toBe('released');
    expect(await owner.transition(release)).toEqual(released);
    expect(db.prepare('SELECT count(*) AS n FROM run_proposal_receipts').get()?.n).toBe(2);
    expect(await owner.preflight(command)).toEqual(released);
    witnessed = false;
    const start = { command, commandId: 'start', expectedRevision: 1, action: 'start' as const };
    await expect(owner.transition(start)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    witnessed = true;
    const started = await owner.transition(start); expect(started.intent.status).toBe('starting');
    expect(await owner.transition(start)).toEqual(started);
    const other = { ...command, commandId: 'cancel-me' }; fact = { ...fact, ready: false };
    await owner.preflight(other);
    const cancelled = await owner.transition({ command: other, commandId: 'cancel', expectedRevision: 0, action: 'cancel' });
    expect((await owner.preflight(other))?.intent.status).toBe('cancelled');
    await expect(owner.transition({ command: other, commandId: 'late-release', expectedRevision: cancelled.intent.revision, action: 'release' }))
      .rejects.toMatchObject({ code: 'RUN_PROPOSAL_COMMAND_CONFLICT' });
    expect(db.prepare('SELECT count(*) AS n FROM runs').get()?.n).toBe(0);
    const nativeExec = db.exec.bind(db); let once = true;
    const commit = vi.spyOn(db, 'exec').mockImplementation(sql => { nativeExec(sql); if (sql === 'COMMIT' && once) { once = false; throw new Error('lost commit response'); } });
    const uncertain = { ...command, commandId: 'unknown-commit' };
    await expect(owner.preflight(uncertain)).rejects.toMatchObject({ code: 'RUN_PROPOSAL_OUTCOME_UNKNOWN' });
    commit.mockRestore();
    expect((await owner.preflight(uncertain))?.intent.status).toBe('parked');
    expect(db.prepare('SELECT count(*) AS n FROM runs').get()?.n).toBe(0);
  } finally { db.close(); }
});
