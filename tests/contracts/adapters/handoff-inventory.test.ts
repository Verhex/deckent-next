import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAttempt } from '#domain/index.js';
import { handoffEventCommandId, readAttemptHandoffEvents, recordAttemptHandoffStart } from '#engine/index.js';
import { inventoryReadsPerCall, openSqliteAttemptStore, openSqliteInventoryReader } from '#adapters/index.js';
const identity = { scopeId: 's', runId: 'r', taskId: 'b', attemptId: 'b-attempt', generation: 1, layoutRevision: 'l' };
it('the read-only inventory and per-call observation port read the durable exact attempt receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-handoff-inventory-')), path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 1000 });
  try {
    await store.commit({ commandId: 'create-attempt', command: 'create', snapshot: createAttempt(identity), expectedRevision: null });
    const events = [{ kind: 'handoff-received' as const, source: { ...identity, taskId: 'a', attemptId: 'a-attempt' }, digest: 'a'.repeat(64) }];
    await recordAttemptHandoffStart(store, identity, events);
    const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: 100 });
    try {
      expect(await readAttemptHandoffEvents(reader, identity)).toEqual({ schemaVersion: 1, identity, events });
      expect(await reader.receipt('foreign', handoffEventCommandId(identity))).toBeNull();
    } finally { reader.close(); }
    expect(await readAttemptHandoffEvents(inventoryReadsPerCall(async () => path, { busyTimeoutMs: 100 }), identity)).toEqual({ schemaVersion: 1, identity, events });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
