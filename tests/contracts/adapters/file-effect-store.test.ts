import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FileEffectStore } from '#adapters/core/file-effect-store/index.js';
import { effectIntentSchema, markEffectUnknown, settleEffect } from '#domain/core/effect/index.js';
import { createHmacIntegrity } from '#platform/core/integrity/index.js';
import { acquireLedgerLock } from '#adapters/core/local-runtime-socket/index.js';

it('keeps a generic unknown intent outside a deleted ledger, fences CAS/replay and corrupt evidence, and settles after target reconciliation once', async () => {
  if (process.platform !== 'linux') {
    expect(() => new FileEffectStore('/fixture/recovery', createHmacIntegrity('fixture', new Uint8Array(32)), { maxBytes: 65536, maxRecords: 10 })).toThrow(expect.objectContaining({ code: 'EFFECT_TARGET_UNAVAILABLE' }));
    console.info('verify-not-run: file-effect-store positive requires Linux kernel custody'); return;
  }
  const root = await mkdtemp(join(tmpdir(), 'deckent-file-effects-'));
  try {
    const ledger = join(root, 'ledger.db'); await writeFile(ledger, 'temporary-ledger');
    const integrity = createHmacIntegrity('fixture', new Uint8Array(32).fill(7)), directory = join(root, 'recovery');
    const store = () => new FileEffectStore(directory, integrity, { maxBytes: 65536, maxRecords: 10 });
    await store().initialize();
    const descriptor = { schemaVersion: 1, operation: { id: 'record.remove', version: 1 }, targetKind: 'record', effectClass: 'irreversible',
      approval: 'required', precondition: 'record-version', compensation: null, inputMaxBytes: 4096, surface: 'authority' };
    const input = effectIntentSchema.parse({ schemaVersion: 1, descriptor,
      command: { schemaVersion: 1, commandId: 'remove', scopeId: 's', operation: descriptor.operation, target: { kind: 'record', id: 'ledger' },
        idempotencyKey: 'key', input: null, expectedVersion: 'v1' }, actor: { id: 'author', issuer: 'fixture', subject: 'person' },
      idempotencyKeyHash: 'a'.repeat(64), inputDigest: 'b'.repeat(64), producer: { kind: 'principal' },
      approval: { approvalId: 'approved-card', actionDigest: 'c'.repeat(64) } });
    const claim = await store().claimEffect(input); let effects = 0;
    await rm(ledger); effects++;
    // Crash after the target effect and before settlement: a fresh instance sees the old claimed record.
    expect(await store().loadEffect('s', 'remove')).toEqual(claim);
    const unknown = await store().saveEffect(claim, markEffectUnknown(claim));
    expect(await store().claimEffect(input)).toEqual(unknown); expect(effects).toBe(1);
    await expect(store().claimEffect({ ...input, command: { ...input.command, commandId: 'other' }, idempotencyKeyHash: 'd'.repeat(64) })).rejects.toMatchObject({ code: 'EFFECT_TARGET_BUSY' });
    await expect(store().saveEffect(claim, settleEffect(claim, { kind: 'fence', version: null, observedAt: 2 }))).rejects.toMatchObject({ code: 'EFFECT_CONFLICT' });
    const settled = await store().saveEffect(unknown, settleEffect(unknown, { kind: 'fence', version: null, observedAt: 3 }));
    expect(await store().claimEffect(input)).toEqual(settled); expect(effects).toBe(1);
    await expect(store().saveEffect(settled, settled)).rejects.toMatchObject({ code: 'EFFECT_CONFLICT' });
    const lock = acquireLedgerLock(join(directory, 'effects.lock'));
    try { await expect(store().loadEffect('s', 'remove')).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_ALREADY_RUNNING' }); } finally { lock.release(); }
    const file = join(directory, 'effects.json'), text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('"state":"settled"', '"state":"unknown"'));
    await expect(store().loadEffect('s', 'remove')).rejects.toMatchObject({ code: 'EFFECT_CORRUPT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
