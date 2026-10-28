import { z } from 'zod';
const text = z.string().min(1).max(4096).refine(value => Array.from(value).every(char => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127));
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
/** Owner 2026-10-27 (K1–K7): keep-data is the default; keep-work keeps work records; all deletes backed-up data after a verified backup. */
export const UNINSTALL_TIERS = ['keep-data', 'keep-work', 'all'] as const;
export type UninstallTier = typeof UNINSTALL_TIERS[number];
/** `force` and `disableUnit` are part of the plan, so the one confirmation (D0) covers them; neither derives from another flag or `--yes`. */
export const uninstallPlanQuerySchema = z.object({ schemaVersion: z.literal(2), tier: z.enum(UNINSTALL_TIERS), force: z.boolean(), disableUnit: z.boolean() }).strict();
export type UninstallQuery = z.infer<typeof uninstallPlanQuerySchema>;
export const uninstallApplySchema = z.object({ schemaVersion: z.literal(2), commandId: text, planDigest: digest }).strict();
export const uninstallInstallationSchema = z.object({ id: text, root: text }).strict().readonly();
export const uninstallResourceSchema = z.object({
  resourceId: text, contribution: text, locator: text, members: z.array(text).min(1).optional(), version: text.nullable(), owner: text.nullable(),
  ownership: z.enum(['exclusive', 'shared', 'foreign', 'unknown']), ownershipEvidence: digest.nullable(),
  present: z.boolean().nullable(), protected: z.boolean(), capability: z.boolean(),
  backup: z.enum(['covered', 'missing', 'protected-session', 'non-exportable']),
  /** A kept resource's exact removal step for the person, produced by its owner; never run by uninstall. */
  manualCommand: text.optional(),
  /** Why an observed resource stays when no generic reason says it: tracked (or possibly tracked) by the project's VCS, or outside the backup set. */
  keep: z.enum(['vcs-tracked', 'vcs-unverified', 'not-backed-up', 'unrecorded', 'workspace-pending']).optional(),
  /** The tiers this observation applies to (absent: every tier); a project's archived files are one resource per data tier. */
  tiers: z.array(z.enum(UNINSTALL_TIERS)).min(1).optional(),
}).strict().readonly();
const ref = z.object({ scopeId: text, id: text, revision: z.number().int().nonnegative().safe() }).strict().readonly();
/** Itemized ledger work, read-only: running and parked runs, pending approvals, open deliveries and every unreconciled effect, call or held money. */
export const uninstallWorkSchema = z.object({ running: z.array(ref), parked: z.array(ref), approvals: z.array(ref), deliveries: z.array(ref),
  uncertain: z.array(z.object({ kind: z.enum(['effect', 'invocation', 'reservation']), scopeId: text, id: text, target: text.nullable() }).strict().readonly()),
  /** False when a category exceeded its bound or the ledger could not be read: unknown work is never zero work. */
  complete: z.boolean(),
  /** F7: worker workspaces the ledger does not prove idle (possibly undelivered work); kept by keep-work, removed by delete-everything only under --force. */
  workspaces: z.number().int().positive().safe().optional() }).strict().readonly();
/** The runtime service as observed: running is a describe answer; `unit` is the user unit whose main process it is (null: none proven). */
export const uninstallServiceSchema = z.object({ running: z.boolean(), unit: text.nullable(),
  /** K4: `eligible` only when every condition holds (user unit, main process = this installation's service, nothing else in its group, no Also=/Alias=). */
  unitDisable: z.enum(['eligible', 'command-only', 'none']), command: text.nullable(),
  /** K4 (i): the unit's exact enablement links (`<link> -> <target>`), bound into the confirmed plan; disable refuses when they changed. */
  links: z.array(text).max(64).readonly().optional(),
  /** R3: the digest of the unit file (path and bytes) `disable` acts on, read again right before it; a change refuses. */
  unitFile: digest.nullable().optional() }).strict().readonly();
export type UninstallResource = z.infer<typeof uninstallResourceSchema>;
export type UninstallInstallation = z.infer<typeof uninstallInstallationSchema>;
export type UninstallWork = z.infer<typeof uninstallWorkSchema>;
export type UninstallService = z.infer<typeof uninstallServiceSchema>;
export interface UninstallItem extends UninstallResource {
  readonly action: 'remove' | 'keep' | 'manual' | 'blocked'; readonly reason: string;
  readonly operation: { readonly id: string; readonly version: number };
  readonly dependencies: readonly string[];
}
export interface UninstallPlan {
  readonly schemaVersion: 2; readonly installation: UninstallInstallation; readonly tier: UninstallTier; readonly force: boolean; readonly disableUnit: boolean;
  /** Tier `all`: the installation itself goes (tombstone). Any tier that deletes data (`backup.required`) archives it first (K7). */
  readonly purge: boolean;
  readonly scopeSummary: readonly string[]; readonly layoutRevision: string; readonly policyRevision: string;
  readonly inventoryRevision: string; readonly registryDigest: string; readonly planDigest: string;
  readonly items: readonly UninstallItem[]; readonly blockers: readonly string[];
  readonly work: UninstallWork; readonly service: UninstallService;
  /** What applying does before any removal: governed service stop, K4 unit disable, and force's own cancellations and rejections. */
  readonly steps: { readonly stopService: boolean; readonly disableUnit: boolean; readonly cancelRuns: UninstallWork['running']; readonly rejectApprovals: UninstallWork['approvals'];
    readonly withdrawDeliveries: UninstallWork['deliveries'] };
  /** Nothing would be removed, stopped, cancelled or rejected: no confirmation is asked. */
  readonly nothingToRemove: boolean;
  /** Every tier from the same observation, for the menu: how many resources it removes and its first blocker. */
  readonly tiers: Readonly<Record<UninstallTier, { readonly removes: number; readonly blocker: string | null }>>;
  readonly backup: { readonly destination: string | null; readonly required: boolean };
  readonly packageRemoval: { readonly command: string | null; readonly shared: boolean };
  /** Planning alone never supplies lifecycle admission, a witness or durable approval. */
  readonly canApply: false;
}
export interface UninstallResult {
  readonly schemaVersion: 2; readonly planDigest: string;
  readonly status: 'completed' | 'partial' | 'cancelled' | 'unknown' | 'noop';
  readonly items: readonly { readonly resourceId: string; readonly state: 'claimed' | 'settled' | 'unknown' | 'refused' | null }[];
  readonly recoveryLocation: string | null; readonly backup: UninstallPlan['backup'];
  readonly packageRemoval: UninstallPlan['packageRemoval'];
  /** K3: unreconciled items are never closed; they are named here (and stay in the backed-up ledger) as unknown. */
  readonly uncertain: UninstallWork['uncertain'];
  /** K4 (d): the user unit this run disabled, its previous state and the exact undo command. */
  readonly unit?: { readonly unit: string; readonly previous: string; readonly undo: string; readonly links?: readonly string[] };
  readonly failureCode?: string;
}
export class UninstallError extends Error {
  constructor(readonly code: 'UNINSTALL_INVALID' | 'UNINSTALL_PLAN_CHANGED' | 'UNINSTALL_UNSUPPORTED' | 'UNINSTALL_BACKUP_COVERAGE'
    | 'UNINSTALL_OWNERSHIP' | 'UNINSTALL_PATH_UNSAFE') { super(code); this.name = 'UninstallError'; }
}
