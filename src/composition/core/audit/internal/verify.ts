import { auditCheckpointVerifyCommandSchema, AuditError, type AuditCheckpointVerifyCommand } from '#domain/index.js';
import { AuditApplication } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteAuditReader } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
/** Read membership/policy is checked before ledger/key access. No key creation or migrations. */
export async function verifyConfiguredAuditCheckpoints(root: string, input: AuditCheckpointVerifyCommand, options: ConfigLoadOptions = {}) {
  try {
    const parsed = auditCheckpointVerifyCommandSchema.safeParse(input);
    if (!parsed.success) throw new AuditError('AUDIT_INVALID');
    const context = await loadConfiguredScopeContext(root, parsed.data.scopeId, options, 'read');
    const authority = await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, false);
    const reader = await openSqliteAuditReader(await context.path(), context.config.storage.sqlite);
    try { return new AuditApplication(reader, authority, context.config['audit_checkpoints']).verifyCheckpoints(parsed.data); }
    finally { reader.close(); }
  } catch (error) { throw queryFailure(error); }
}
