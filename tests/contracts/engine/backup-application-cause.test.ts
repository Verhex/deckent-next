import { expect, it } from 'vitest';
import { verifiedPrincipalSchema, type AuditEvent } from '#domain/index.js';
import { BackupApplication, type BackupAuthority, type BackupStoragePort } from '#engine/index.js';
import { DeckentError, ErrorRegistry } from '#platform/index.js';

// PLATFORM-TEMIZLIK: an untyped storage failure becomes BACKUP_IO for every caller, but the original error travels as `cause` so a
// failing run (macOS hosted verify) can name the real reason. The message, the code and the audit record stay exactly the registered ones.
const PRIVATE = '/private/var/folders/xx/synthetic-backup-root/.deckent/ledger.sqlite';
const authority: BackupAuthority = { installationId: 'installation-1', integrity: {} as BackupAuthority['integrity'],
  principal: verifiedPrincipalSchema.parse({ id: 'backup-owner', issuer: 'host', subject: 'backup-owner', assurance: 'os-user', scopeIds: ['s'] }) };
const command = { schemaVersion: 1, scopeId: 's', action: 'create', set: '/backups/set-1' } as const;

it('an untyped storage failure is BACKUP_IO with the original error as its cause; message and audit carry the code only', async () => {
  const thrown = new Error(`EPERM: operation not permitted, open '${PRIVATE}'`);
  const storage: BackupStoragePort = { execute: async () => { throw thrown; } };
  const events: AuditEvent[] = [];
  const app = new BackupApplication(storage, async () => ({ policyRevision: 'r1', effect: 'allow', ruleId: 'backup-all' }),
    async event => { events.push(event); }, authority);
  const error = await app.execute(command, 'synthetic-passphrase').catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DeckentError);
  const failure = error as DeckentError;
  expect(failure.code).toBe('BACKUP_IO');
  expect(failure.cause, String(failure.cause)).toBe(thrown);
  expect(failure.message).toBe(ErrorRegistry.createError('BACKUP_IO').message);
  expect(failure.message).not.toContain(PRIVATE);
  expect(JSON.stringify(failure)).not.toContain(PRIVATE);
  expect(failure.localize?.('en').message).not.toContain(PRIVATE);
  expect(failure.localize?.('tr').message).not.toContain(PRIVATE);
  expect(events.map(event => (event.subject as { phase: string; code: string | null }))).toMatchObject([{ phase: 'intent', code: null }, { phase: 'failed', code: 'BACKUP_IO' }]);
  expect(JSON.stringify(events)).not.toContain(PRIVATE);
  expect(JSON.stringify(events)).not.toContain('EPERM');
});

it('a typed backup failure passes through unchanged, without a wrapping cause', async () => {
  const typed = ErrorRegistry.createError('BACKUP_RESTORE_INCOMPLETE');
  const events: AuditEvent[] = [];
  const app = new BackupApplication({ execute: async () => { throw typed; } }, async () => ({ policyRevision: 'r1', effect: 'allow', ruleId: 'backup-all' }),
    async event => { events.push(event); }, authority);
  await expect(app.execute(command, 'synthetic-passphrase')).rejects.toBe(typed);
  expect(typed.cause).toBeUndefined();
  expect(events.map(event => (event.subject as { phase: string; code: string | null }))).toMatchObject([{ phase: 'intent', code: null }, { phase: 'uncertain', code: 'BACKUP_RESTORE_INCOMPLETE' }]);
});
