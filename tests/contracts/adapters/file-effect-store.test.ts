import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FileEffectStore } from '#adapters/core/file-effect-store/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { effectIntentSchema, effectRecordSchema, markEffectUnknown, refuseEffect, settleEffect, type EffectRecord } from '#domain/core/effect/index.js';
import type { EffectStore } from '#engine/index.js';
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
    await expect(store().assertUnclaimed()).rejects.toBeDefined();
    await store().initialize();
    await expect(store().assertUnclaimed()).resolves.toBeUndefined();
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
    await expect(store().assertUnclaimed()).rejects.toMatchObject({ code: 'EFFECT_TARGET_BUSY' });
    const unknown = await store().saveEffect(claim, markEffectUnknown(claim));
    await expect(store().assertUnclaimed()).rejects.toMatchObject({ code: 'EFFECT_TARGET_BUSY' });
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
    await expect(store().assertUnclaimed()).rejects.toMatchObject({ code: 'EFFECT_CORRUPT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('S3-e1: both EffectStores refuse the same transitions the domain refuses and keep the stored record; no effect_intents statement spells the open set', async () => {
  // Contract step (KG10 F1): only the domain set and the sqlite-ledger fragment name the states; versioned DDL and migrations are history.
  const sources = readdirSync('src', { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts') && !file.startsWith('domain/core/effect/')
    && file !== 'adapters/core/sqlite-ledger/internal/schema.ts' && !file.startsWith('adapters/core/sqlite-ledger-migrations/'));
  const statements: string[] = [];
  for (const file of sources) {
    const text = readFileSync(join('src', file), 'utf8');
    if (!text.includes('effect_intents')) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) { if (node.getText().includes('effect_intents')) statements.push(`${file}: ${node.getText()}`); return; }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  }
  expect(statements.length).toBeGreaterThan(5);
  expect(statements.filter(text => /'(claimed|unknown)'|'settled'\s*,\s*'refused'/.test(text))).toEqual([]);
  if (process.platform !== 'linux') { console.info('verify-not-run: file-effect-store positive requires Linux kernel custody'); return; }
  const root = await mkdtemp(join(tmpdir(), 'deckent-effect-transitions-'));
  const sqlite = await openSqliteAttemptStore(join(root, 'ledger.db'), { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }, { now: () => 1, timeoutMs: 1000 }, 'allow');
  try {
    const file = new FileEffectStore(join(root, 'effects'), createHmacIntegrity('fixture', new Uint8Array(32).fill(7)), { maxBytes: 262144, maxRecords: 16 });
    await file.initialize();
    const descriptor = { schemaVersion: 1, operation: { id: 'record.write', version: 1 }, targetKind: 'record', effectClass: 'write', approval: 'policy', precondition: 'none', compensation: null, inputMaxBytes: 4096 };
    const evidence = { kind: 'fence', version: null, observedAt: 2 } as const;
    const to = (record: EffectRecord, state: EffectRecord['state']) => effectRecordSchema.parse({ ...record, state, evidence: state === 'settled' ? evidence : null, refusal: state === 'refused' ? 'EFFECT_REJECTED' : null });
    const cases = [['settled', 'unknown'], ['refused', 'settled'], ['unknown', 'refused'], ['claimed', 'claimed']] as const;
    for (const [name, store] of [['file', file], ['sqlite', sqlite]] as [string, EffectStore][]) {
      for (const [index, [from, next]] of cases.entries()) {
        const id = `${name}-${index}`, claimed = await store.claimEffect(effectIntentSchema.parse({ schemaVersion: 1, descriptor, actor: { id: 'author', issuer: 'fixture', subject: 'person' },
          command: { schemaVersion: 1, commandId: id, scopeId: 's', operation: descriptor.operation, target: { kind: 'record', id }, idempotencyKey: id, input: null, expectedVersion: null },
          idempotencyKeyHash: String(index).repeat(64), inputDigest: 'b'.repeat(64), producer: { kind: 'principal' } }));
        const source = from === 'claimed' ? claimed : await store.saveEffect(claimed, from === 'settled' ? settleEffect(claimed, evidence) : from === 'refused' ? refuseEffect(claimed, 'EFFECT_REJECTED') : markEffectUnknown(claimed));
        await expect(store.saveEffect(source, to(source, next)), `${name} ${from}->${next}`).rejects.toMatchObject({ code: 'EFFECT_CONFLICT' });
        expect(await store.loadEffect('s', id)).toEqual(source);
      }
    }
  } finally { sqlite.close(); await rm(root, { recursive: true, force: true }); }
});
