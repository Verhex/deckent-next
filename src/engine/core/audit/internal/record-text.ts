import { AUDIT_SHELL_HEAD_MAX_CHARS, type AuditEvent } from '#domain/index.js';
import { redactForRecord, type KnownSecretSnapshot } from '#platform/index.js';

type AuditSummary = Extract<AuditEvent['subject'], { kind: 'permission-mode' }>['summary'];
/** Derived record text only, before any schema/display cut. Digest and authority identities remain those of the original action. */
export function recordAuditSummary(summary: AuditSummary, known?: KnownSecretSnapshot): AuditSummary {
  const safe = (text: string, limit: number) => redactForRecord(text, known).slice(0, limit);
  switch (summary.kind) {
    case 'shell': return { ...summary, head: safe(summary.head, AUDIT_SHELL_HEAD_MAX_CHARS) };
    case 'mcp': return { ...summary, tool: safe(summary.tool, AUDIT_SHELL_HEAD_MAX_CHARS) };
    case 'edit': return { ...summary, path: safe(summary.path, 4096) };
    case 'fetch': return { ...summary, host: safe(summary.host, 253) };
  }
}
