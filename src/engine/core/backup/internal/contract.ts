import { z } from 'zod';
import type { AuditEvent, VerifiedPrincipal } from '#domain/index.js';
import type { IntegrityAuthority } from '#platform/index.js';
const path = z.string().min(1).max(4096).refine(value => Array.from(value).every(char => char.charCodeAt(0) > 31));
const common = { schemaVersion: z.literal(1), scopeId: z.string().min(1).max(256), set: path };
/** Passphrases are a separate credential argument, never part of a command, decision, receipt or audit event. */
export const backupCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('create') }).strict(),
  z.object({ ...common, action: z.literal('verify') }).strict(),
  z.object({ ...common, action: z.literal('restore'), target: path, confirmTarget: path.optional() }).strict(),
]);
export type BackupCommand = z.infer<typeof backupCommandSchema>;
export interface BackupResult {
  readonly schemaVersion: 1; readonly action: BackupCommand['action']; readonly set: string;
  readonly ledgerDigest: string; readonly files: number; readonly createdAt: string;
  readonly relocation: { readonly required: boolean; readonly target: string; readonly changedPaths: readonly string[] } | null;
  /** Restore only (S1 D1): the per-user global layer. `added` = archived sections written there (it lacked them); `kept` = archived sections
   * the present global layer already holds with another value (the present one stays: the layer is shared by this user's installations). */
  readonly globalConfig: { readonly path: string; readonly added: readonly string[]; readonly kept: readonly string[] } | null;
  readonly preserved: readonly string[];
}
export interface BackupDecision { readonly policyRevision: string; readonly effect: 'allow' | 'deny' | 'require-approval'; readonly ruleId: string | null }
/** One installation-wide recovery authority, verified by the composition before use; never accepted from a request body. */
export interface BackupAuthority { readonly principal: VerifiedPrincipal; readonly installationId: string; readonly integrity: IntegrityAuthority }
export interface BackupStoragePort {
  execute(command: BackupCommand, passphrase: string): Promise<BackupResult>;
}
export type BackupAuthorization = (command: BackupCommand, authority: BackupAuthority) => Promise<BackupDecision>;
/** No persisted intent, no storage effect. Outcome errors are typed and leave an intent that must be reconciled. */
export type BackupAudit = (event: AuditEvent, authority: IntegrityAuthority) => Promise<void>;

export interface BackupScheduleEvent { readonly trigger: 'daily' | 'before-upgrade'; readonly status: 'created' | 'failed'; readonly code: string | null }
export interface BackupScheduleObserver { onBackup?(event: BackupScheduleEvent): void | Promise<void> }
