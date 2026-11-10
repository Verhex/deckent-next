import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { ledgerTransaction, openLedgerDatabase, openSqliteLedger, sqliteEngineMeetsFloor, assertSqliteEngineSupported, SQLITE_ENGINE_FLOOR } from '#adapters/core/sqlite-ledger/index.js';
import { openMemoryEvaluationSourceReader } from '#adapters/core/memory-journal-store/index.js';
import { AttemptStoreError } from '#engine/index.js';

// DEPS-P0: 3.51.3 fixed the WAL-reset corruption bug present in every SQLite release from 3.7.0 through 3.51.2
// (sqlite.org/releaselog/3_51_3.html, 2026-03-13). Node 24.15.0 is the first 24.x LTS bundling it.
describe('sqlite engine floor (DEPS-P0)', () => {
  it('exposes 3.51.3 as the floor constant', () => { expect(SQLITE_ENGINE_FLOOR).toBe('3.51.3'); });

  it('compares numerically per segment, not lexically', () => {
    // Lexical '9' > '5' would wrongly pass '3.9.0' against a '3.51.3' floor; numeric compare must refuse it.
    expect(sqliteEngineMeetsFloor('3.9.0')).toBe(false);
    expect(sqliteEngineMeetsFloor('3.51.2')).toBe(false);
    expect(sqliteEngineMeetsFloor('3.51.3')).toBe(true);
    expect(sqliteEngineMeetsFloor('3.51.4')).toBe(true);
    expect(sqliteEngineMeetsFloor('3.52.0')).toBe(true);
    expect(sqliteEngineMeetsFloor('4.0.0')).toBe(true);
    expect(sqliteEngineMeetsFloor('2.99.99')).toBe(false);
  });

  it('treats a missing or unparsable version as below floor rather than trusting an unidentified engine', () => {
    expect(sqliteEngineMeetsFloor(undefined)).toBe(false);
    expect(sqliteEngineMeetsFloor('')).toBe(false);
    expect(sqliteEngineMeetsFloor('not-a-version')).toBe(false);
  });

  it('assertSqliteEngineSupported throws a typed AttemptStoreError below floor and is silent at/above it', () => {
    expect(() => assertSqliteEngineSupported('3.51.2')).toThrow(AttemptStoreError);
    try { assertSqliteEngineSupported('3.51.2'); throw new Error('unreachable'); }
    catch (error) { expect(error).toBeInstanceOf(AttemptStoreError); expect((error as AttemptStoreError).code).toBe('ATTEMPT_STORE_SQLITE_UNSUPPORTED'); }
    expect(() => assertSqliteEngineSupported('3.51.3')).not.toThrow();
    expect(() => assertSqliteEngineSupported(process.versions.sqlite)).not.toThrow();
  });

  describe('wired at the single place the ledger opens node:sqlite', () => {
    const roots: string[] = [];
    afterEach(async () => {
      Object.defineProperty(process.versions, 'sqlite', { value: process.versions.sqlite, configurable: true, enumerable: true, writable: false });
      await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
    });

    it('refuses before touching the database file when the host engine predates the floor', async () => {
      const root = await mkdtemp(join(tmpdir(), 'dn-sqlite-floor-')); roots.push(root);
      const real = process.versions.sqlite;
      Object.defineProperty(process.versions, 'sqlite', { value: '3.51.2', configurable: true, enumerable: true, writable: false });
      try {
        expect(() => openSqliteLedger(join(root, 'ledger.db'), { busyTimeoutMs: 20, journalMode: 'delete', durability: 'full' }))
          .toThrow(AttemptStoreError);
        // The raw opener behind every other open (installer, inventory, backup copy and checkpoint, memory sources) refuses the same way.
        expect(() => openLedgerDatabase(join(root, 'ledger.db'))).toThrow(AttemptStoreError);
        await expect(openMemoryEvaluationSourceReader(join(root, 'ledger.db'), { busyTimeoutMs: 20 }, () => null, () => true))
          .rejects.toMatchObject({ code: 'ATTEMPT_STORE_SQLITE_UNSUPPORTED' });
        expect(existsSync(join(root, 'ledger.db'))).toBe(false);
      } finally { Object.defineProperty(process.versions, 'sqlite', { value: real, configurable: true, enumerable: true, writable: false }); }
    });

    it('opens normally once the injected version is at the floor', async () => {
      const root = await mkdtemp(join(tmpdir(), 'dn-sqlite-floor-ok-')); roots.push(root);
      const real = process.versions.sqlite;
      Object.defineProperty(process.versions, 'sqlite', { value: SQLITE_ENGINE_FLOOR, configurable: true, enumerable: true, writable: false });
      try {
        const db = openSqliteLedger(join(root, 'ledger.db'), { busyTimeoutMs: 20, journalMode: 'delete', durability: 'full' });
        try {
          db.exec('CREATE TABLE sql_m_pin(value TEXT)');
          expect(ledgerTransaction(db, () => {
            db.prepare('INSERT INTO sql_m_pin VALUES(?)').run('retained');
            return ledgerTransaction(db, () => db.prepare('SELECT value FROM sql_m_pin').get()?.value, { join: true, mode: 'read' });
          })).toBe('retained');
          const rejected = new Error('SQL_M_REJECTED');
          expect(() => ledgerTransaction(db, () => {
            db.prepare('INSERT INTO sql_m_pin VALUES(?)').run('rolled-back'); throw rejected;
          }, { failure: error => error })).toThrow(rejected);
          expect(db.prepare('SELECT value FROM sql_m_pin').all()).toEqual([{ value: 'retained' }]);
          expect(db.isTransaction).toBe(false);
          await expect(ledgerTransaction(db, async () => {
            await Promise.resolve(); expect(db.isTransaction).toBe(true);
            db.prepare('INSERT INTO sql_m_pin VALUES(?)').run('awaited'); return 'settled';
          })).resolves.toBe('settled');
          await expect(ledgerTransaction(db, async () => {
            db.prepare('INSERT INTO sql_m_pin VALUES(?)').run('async-rolled-back');
            await Promise.resolve(); throw rejected;
          }, { failure: error => error })).rejects.toBe(rejected);
          expect(db.prepare('SELECT value FROM sql_m_pin ORDER BY rowid').all()).toEqual([{ value: 'retained' }, { value: 'awaited' }]);
          const exec = db.exec.bind(db), unknown = new Error('SQL_M_OUTCOME_UNKNOWN');
          const fault = vi.spyOn(db, 'exec').mockImplementation(sql => { if (sql === 'COMMIT') throw rejected; exec(sql); });
          try {
            expect(() => ledgerTransaction(db, () => 'value', { unknown: () => unknown })).toThrow(unknown);
            await expect(ledgerTransaction(db, async () => { await Promise.resolve(); return 'value'; }, { unknown: () => unknown })).rejects.toBe(unknown);
            expect(db.isTransaction).toBe(false);
            fault.mockImplementation(sql => { if (sql === 'ROLLBACK') throw rejected; exec(sql); });
            expect(() => ledgerTransaction(db, () => { throw rejected; }, { unknown: () => unknown })).toThrow(unknown);
          } finally { fault.mockRestore(); if (db.isTransaction) exec('ROLLBACK'); }
        } finally { db.close(); }
      } finally { Object.defineProperty(process.versions, 'sqlite', { value: real, configurable: true, enumerable: true, writable: false }); }
    });
  });
});
