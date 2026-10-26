import { z } from 'zod';
const text = z.string().min(1).max(4096).refine(value => Array.from(value).every(char => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127));
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const uninstallPlanQuerySchema = z.object({ schemaVersion: z.literal(1), purge: z.boolean() }).strict();
export const uninstallApplySchema = z.object({ schemaVersion: z.literal(1), commandId: text, planDigest: digest }).strict();
export const uninstallInstallationSchema = z.object({ id: text, root: text }).strict().readonly();
export const uninstallResourceSchema = z.object({
  resourceId: text, contribution: text, locator: text, members: z.array(text).min(1).optional(), version: text.nullable(), owner: text.nullable(),
  ownership: z.enum(['exclusive', 'shared', 'foreign', 'unknown']), ownershipEvidence: digest.nullable(),
  present: z.boolean().nullable(), protected: z.boolean(), capability: z.boolean(),
  backup: z.enum(['covered', 'missing', 'protected-session', 'non-exportable']),
}).strict().readonly();
export type UninstallResource = z.infer<typeof uninstallResourceSchema>;
export type UninstallInstallation = z.infer<typeof uninstallInstallationSchema>;
export interface UninstallItem extends UninstallResource {
  readonly action: 'remove' | 'keep' | 'manual' | 'blocked'; readonly reason: string;
  readonly operation: { readonly id: string; readonly version: number };
  readonly dependencies: readonly string[];
}
export interface UninstallPlan {
  readonly schemaVersion: 1; readonly installation: UninstallInstallation; readonly purge: boolean;
  readonly scopeSummary: readonly string[]; readonly layoutRevision: string; readonly policyRevision: string;
  readonly inventoryRevision: string; readonly registryDigest: string; readonly planDigest: string;
  readonly items: readonly UninstallItem[]; readonly blockers: readonly string[];
  readonly backup: { readonly destination: string | null; readonly required: boolean };
  readonly packageRemoval: { readonly command: string | null; readonly shared: boolean };
  /** Planning alone never supplies lifecycle admission, a witness or durable approval. */
  readonly canApply: false;
}
export interface UninstallResult {
  readonly schemaVersion: 1; readonly planDigest: string;
  readonly status: 'completed' | 'partial' | 'cancelled' | 'unknown' | 'noop';
  readonly items: readonly { readonly resourceId: string; readonly state: 'claimed' | 'settled' | 'unknown' | 'refused' | null }[];
  readonly recoveryLocation: string | null; readonly backup: UninstallPlan['backup'];
  readonly packageRemoval: UninstallPlan['packageRemoval'];
  readonly failureCode?: string;
}
export class UninstallError extends Error {
  constructor(readonly code: 'UNINSTALL_INVALID' | 'UNINSTALL_PLAN_CHANGED' | 'UNINSTALL_UNSUPPORTED' | 'UNINSTALL_BACKUP_COVERAGE'
    | 'UNINSTALL_OWNERSHIP' | 'UNINSTALL_PATH_UNSAFE') { super(code); this.name = 'UninstallError'; }
}
