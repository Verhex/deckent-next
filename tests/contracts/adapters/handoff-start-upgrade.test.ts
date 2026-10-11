import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createAttempt } from '#domain/index.js';
import { handoffEventCommandId, readAttemptHandoffEvents, recordAttemptHandoffStart } from '#engine/index.js';
import { openSqliteAttemptStore, openSqliteInventoryReader } from '#adapters/index.js';
const target = { scopeId: 's', runId: 'r', taskId: 'b', attemptId: 'b1', generation: 1, layoutRevision: 'l' };
const source = { ...target, taskId: 'a', attemptId: 'a1' };
const note = { kind: 'handoff-received' as const, source, digest: 'a'.repeat(64) };
const patch = { kind: 'workspace-started-from-patch' as const, source, digest: 'b'.repeat(64) };
const pair = { bindingDigest: 'c'.repeat(64), snapshotDigest: 'd'.repeat(64) };
const sqlite = { busyTimeoutMs: 100, journalMode: 'wal' as const, durability: 'full' as const };

it('replays literal alpha.28 receipt bytes on upgrade without commit, backfill or changed Attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-upgrade-')), path = join(root, 'ledger.db');
  // Literal historical wire shape: no new schema helper manufactures the legacy command.
  const command = '{"schemaVersion":1,"identity":{"runId":"r","taskId":"b","attemptId":"b1","scopeId":"s","layoutRevision":"l","generation":1},"events":[{"kind":"handoff-received","source":{"runId":"r","taskId":"a","attemptId":"a1","scopeId":"s","layoutRevision":"l","generation":1},"digest":"' + note.digest + '"},{"kind":"workspace-started-from-patch","source":{"runId":"r","taskId":"a","attemptId":"a1","scopeId":"s","layoutRevision":"l","generation":1},"digest":"' + patch.digest + '"}]}';
  let store = await openSqliteAttemptStore(path, sqlite, { now: Date.now, timeoutMs: 1000 });
  try {
    const snapshot = createAttempt(target);
    await store.commit({ commandId: 'create', command: 'create', snapshot, expectedRevision: null });
    await store.commit({ commandId: handoffEventCommandId(target), command, snapshot, expectedRevision: snapshot.revision });
    store.close(); store = await openSqliteAttemptStore(path, sqlite, { now: Date.now, timeoutMs: 1000 }, 'forbid');
    const commit = vi.spyOn(store, 'commit'), before = await store.load('s', 'b1');
    await recordAttemptHandoffStart(store, target, [note, patch], { ...pair, receipts: [{ source, digest: patch.digest }] });
    await recordAttemptHandoffStart(store, target, [note, { ...patch, ...pair }]);
    expect(commit).not.toHaveBeenCalled();
    expect((await store.receipt('s', handoffEventCommandId(target)))!.command).toBe(command);
    expect(await store.load('s', 'b1')).toEqual(before);
    const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: 100 });
    try { expect((await readAttemptHandoffEvents(reader, target))!.events).toEqual([note, patch]); }
    finally { reader.close(); }
    for (const events of [
      [note, { ...patch, ...pair, digest: note.digest }],
      [note, { ...patch, ...pair, source: { ...source, generation: 2 } }],
      [note, { ...patch, ...pair, source: { ...source, attemptId: 'a0' } }],
      [{ ...patch, ...pair }, note], [{ ...patch, ...pair }],
      [{ ...note, digest: patch.digest }, { ...patch, ...pair }],
    ]) await expect(recordAttemptHandoffStart(store, target, events)).rejects.toMatchObject({ code: 'ATTEMPT_COMMAND_CONFLICT' });
    expect(commit).not.toHaveBeenCalled();
    expect((await store.receipt('s', handoffEventCommandId(target)))!.command).toBe(command);
  } finally { vi.restoreAllMocks(); store.close(); await rm(root, { recursive: true, force: true }); }
});

it('new G2 receipt persists across reopen; changed G2 and stripped downgrade replay conflict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-g2-')), path = join(root, 'ledger.db');
  let store = await openSqliteAttemptStore(path, sqlite, { now: Date.now, timeoutMs: 1000 });
  try {
    await store.commit({ commandId: 'create', command: 'create', snapshot: createAttempt(target), expectedRevision: null });
    const events = [note, { ...patch, ...pair }];
    await recordAttemptHandoffStart(store, target, events);
    const command = (await store.receipt('s', handoffEventCommandId(target)))!.command;
    store.close(); store = await openSqliteAttemptStore(path, sqlite, { now: Date.now, timeoutMs: 1000 }, 'forbid');
    const commit = vi.spyOn(store, 'commit');
    await recordAttemptHandoffStart(store, target, events);
    expect((await readAttemptHandoffEvents(store, target))!.events).toEqual(events);
    for (const field of ['bindingDigest', 'snapshotDigest'] as const)
      await expect(recordAttemptHandoffStart(store, target, [note, { ...patch, ...pair, [field]: 'e'.repeat(64) }]))
        .rejects.toMatchObject({ code: 'ATTEMPT_COMMAND_CONFLICT' });
    await expect(recordAttemptHandoffStart(store, target, [note, patch])).rejects.toMatchObject({ code: 'ATTEMPT_COMMAND_CONFLICT' });
    expect(commit).not.toHaveBeenCalled();
    expect((await store.receipt('s', handoffEventCommandId(target)))!.command).toBe(command);
    const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: 100 });
    try { expect((await readAttemptHandoffEvents(reader, target))!.events).toEqual(events); }
    finally { reader.close(); }
  } finally { vi.restoreAllMocks(); store.close(); await rm(root, { recursive: true, force: true }); }
});
