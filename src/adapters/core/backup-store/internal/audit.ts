import { join } from 'node:path';
import { sealAuditRecord } from '#engine/index.js';
import type { AuditEvent } from '#domain/index.js';
import { ErrorRegistry, type IntegrityAuthority } from '#platform/index.js';
import { writePrivate } from './files.js';
/** Portable, sealed recovery receipts survive destruction/replacement of the ledger. Each immutable event is its own one-record stream. */
export async function recordBackupAudit(directory: string, event: AuditEvent, authority: IntegrityAuthority): Promise<void> {
  try { await writePrivate(join(directory, event.eventId), JSON.stringify(sealAuditRecord(event, 1, authority)) + '\n'); }
  catch { throw ErrorRegistry.createError('BACKUP_AUDIT_UNAVAILABLE'); }
}
