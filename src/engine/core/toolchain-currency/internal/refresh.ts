import { z } from 'zod';
import { identitySchema, executionRegistrySchema, type ExecutionRegistry, type JsonValue } from '#domain/index.js';
import type { ProfileRevisionProposal } from './update.js';
import type { ToolchainCurrencyReport } from './contract.js';

/**
 * WORKER-AUTO-REFRESH (owner 2026-10-06 K2): pure policy of the autonomous worker image refresh. The composition owns the clock, the
 * build and the files; this module decides when a refresh may start, whether one is still in flight, how it is shown, and what exact new
 * profile versions a built image yields. Nothing here names a vendor: providers come from the proposal, which comes from the registry.
 */
export type ToolchainRefreshTrigger = 'startup' | 'interval';
export type ToolchainRefreshPolicy = Readonly<{ mode: 'off' | 'propose' | 'auto'; atStartup: boolean; intervalMs: number }>;
/** A build is started only in `auto` mode; a start trigger also needs `atStartup`, an interval trigger a positive `intervalMs` (0 = off). */
export function refreshTriggerAllowed(policy: ToolchainRefreshPolicy, trigger: ToolchainRefreshTrigger): boolean {
  if (policy.mode !== 'auto') return false;
  return trigger === 'startup' ? policy.atStartup : policy.intervalMs > 0;
}

/** A manual `toolchains update` (CLI, MCP, SDK) builds only with an explicit apply flag, whatever the mode; the service's autonomous refresh passes it itself and is gated by `mode=auto`. */
export const toolchainUpdateApplies = (flag?: boolean): boolean => flag === true;
/** The interval the service's periodic check sleeps, 0 when the policy does not allow an interval refresh. */
export const refreshIntervalMs = (policy: ToolchainRefreshPolicy): number => refreshTriggerAllowed(policy, 'interval') ? policy.intervalMs : 0;
/** Audit record file name of one refresh attempt (one file per start instant and trigger; written exclusively). */
export const refreshAuditName = (startedAt: string, trigger: ToolchainRefreshTrigger): string => `${startedAt.replace(/[:.]/g, '-')}-${trigger}.json`;

const FAILED_CONTEXT = /^r[1-9][0-9]*-\d{8}\.failed-(\d+)$/;
/** Failed build contexts to remove: everything but the newest `keep` (at least one is always kept); other names are never touched. */
export function failedContextsToPrune(names: readonly string[], keep: number): string[] {
  const failed = names.flatMap(name => { const match = FAILED_CONTEXT.exec(name); return match ? [{ name, at: Number(match[1]) }] : []; })
    .sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  return failed.slice(Math.max(1, keep)).map(entry => entry.name);
}

export type WorkerLineage = Readonly<{ recipe: unknown; dockerfile: string }>;
const counterOf = (recipe: unknown): number => { const id = (recipe as { imageVersion?: unknown } | null)?.imageVersion; const match = typeof id === 'string' ? /^r([1-9][0-9]*)-/.exec(id) : null; return match ? Number(match[1]) : 0; };
const stripVersions = (recipe: unknown) => JSON.stringify({ ...(recipe as object), imageVersion: null, previousVersion: null });
const stripHistory = (dockerfile: string) => dockerfile.split('\n').filter(line => !line.startsWith('# version ')).join('\n');
/**
 * Where the next image version is planned from. The packaged recipe never advances by itself, so the newest verified build of this
 * installation (its own recipe and Dockerfile, confirmed by a receipt) continues the lineage: without it every later refresh would
 * plan the same counter and the builder's counter guard would refuse it for good. The built lineage is used only when it is ahead and
 * still the same sources as the package (recipe and Dockerfile bodies equal apart from version and history lines); otherwise the
 * package decides and the builder's guard stays the authority.
 */
export function selectWorkerLineage(packaged: WorkerLineage, built: WorkerLineage | null): WorkerLineage {
  if (!built || counterOf(built.recipe) <= counterOf(packaged.recipe)) return packaged;
  if (stripVersions(built.recipe) !== stripVersions(packaged.recipe) || stripHistory(built.dockerfile) !== stripHistory(packaged.dockerfile)) return packaged;
  return built;
}

const isoTime = z.string().datetime();
const imageDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** The durable refresh marker. `expiresAt` bounds an `updating` marker (build timeout plus a grace): a crashed process never masks a refusal for good. */
export const toolchainRefreshStateSchema = z.object({ schemaVersion: z.literal(1), phase: z.enum(['updating', 'current', 'failed', 'unverified']),
  trigger: z.enum(['startup', 'interval']), startedAt: isoTime, finishedAt: isoTime.nullable(), expiresAt: isoTime,
  imageVersion: z.string().nullable(), imageId: imageDigest.nullable(), staleProviders: z.array(identitySchema).readonly(),
  appliedProfiles: z.number().int().min(0).safe(), reason: z.string().max(128).nullable() }).strict().readonly();
export type ToolchainRefreshState = z.infer<typeof toolchainRefreshStateSchema>;
export type ToolchainRefreshStatus = 'updating' | 'current' | 'failed' | 'unknown';

/** True while a refresh is in flight and still inside its own bound: admission then carries a warning instead of refusing a stale pin. */
export function refreshInProgress(state: ToolchainRefreshState | null, nowMs: number): boolean {
  return state !== null && state.phase === 'updating' && Date.parse(state.expiresAt) > nowMs;
}
/** Operator-facing status; an `updating` marker past its bound is reported as failed (`REFRESH_EXPIRED`), never as still running. */
export function refreshStatus(state: ToolchainRefreshState | null, nowMs: number): Readonly<{ status: ToolchainRefreshStatus; reason: string | null }> {
  if (state === null) return Object.freeze({ status: 'unknown', reason: null });
  if (state.phase === 'updating') return refreshInProgress(state, nowMs) ? Object.freeze({ status: 'updating', reason: null }) : Object.freeze({ status: 'failed', reason: 'REFRESH_EXPIRED' });
  return state.phase === 'unverified' ? Object.freeze({ status: 'unknown', reason: state.reason }) : Object.freeze({ status: state.phase, reason: state.reason });
}

/** `current` is claimed only when every admitted provider could be compared; otherwise the check is `unverified` with the first typed reason. */
export function unverifiedReason(report: ToolchainCurrencyReport): string | null {
  for (const entry of report.providers) {
    if (!entry.admitted.length) continue;
    if (entry.status === 'unknown-offline') return entry.reason ?? 'CURRENCY_UNKNOWN_OFFLINE';
    if (entry.status === 'unparsed') return 'CURRENCY_UNPARSED';
    if (entry.status === 'disabled') return 'CURRENCY_DISABLED';
  }
  return null;
}
const baseRevision = (revision: string) => revision.split('@')[0]!;
const asRecord = (value: unknown): Record<string, JsonValue> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : null;
/** Rewrites the image id and CLI pin of one profile in place of a clone: a prepared native profile (`parameters.imageId`, preflight pin) or a coding template (`docker.imageId`, invocation pin). */
function repinParameters(parameters: Record<string, JsonValue>, to: { cliVersion: string; imageId: string }): boolean {
  const view = parameters as { docker?: JsonValue; invocation?: JsonValue; imageId?: JsonValue; nativeSubscription?: JsonValue };
  const docker = asRecord(view.docker ?? null), invocation = asRecord(view.invocation ?? null);
  if (docker && invocation) { docker['imageId'] = to.imageId; invocation['cliVersion'] = to.cliVersion; return true; }
  const preflight = asRecord(asRecord(view.nativeSubscription ?? null)?.['preflight']);
  if (preflight && typeof view.imageId === 'string') { view.imageId = to.imageId; preflight['cliVersion'] = to.cliVersion; return true; }
  return false;
}
export type RegistryRevision = Readonly<{ registry: ExecutionRegistry; applied: readonly Readonly<{ profile: string; from: number; to: number }>[] }>;
/**
 * The exact new execution registry for a built image: every proposed profile gets a NEW version (highest existing + 1) carrying the new
 * image id and CLI pin, and the task kinds that used the old version point at the new one. Old versions stay registered, so Runs already
 * admitted (which froze their profile) are untouched and rollback is a pointer edit. Returns null when nothing changes (already at the
 * proposed image, or no proposed profile is present), so a repeated refresh is idempotent.
 */
export function reviseRegistryForProposal(registryInput: unknown, proposal: ProfileRevisionProposal): RegistryRevision | null {
  const registry = executionRegistrySchema.parse(registryInput);
  const profiles: Record<string, JsonValue>[] = structuredClone(registry.profiles) as unknown as Record<string, JsonValue>[];
  const kinds = structuredClone(registry.kinds) as unknown as { kind: string; profile: { id: string; version: number } }[];
  const applied: { profile: string; from: number; to: number }[] = [];
  for (const entry of proposal.profiles) {
    // Only a version a task kind still points at is revised: a superseded version kept for rollback is never revised again.
    if (!kinds.some(kind => kind.profile.id === entry.profile.id && kind.profile.version === entry.profile.version)) continue;
    const current = profiles.find(profile => profile['id'] === entry.profile.id && profile['version'] === entry.profile.version);
    if (!current) continue;
    const parameters = asRecord(current['parameters']); if (!parameters) continue;
    const next = structuredClone(current); const nextParameters = asRecord(next['parameters'])!;
    if (!repinParameters(nextParameters, { cliVersion: entry.changes.cliVersion.to, imageId: entry.changes.imageId.to })) continue;
    if (JSON.stringify(nextParameters) === JSON.stringify(parameters)) continue;
    const version = Math.max(...profiles.filter(profile => profile['id'] === entry.profile.id).map(profile => profile['version'] as number)) + 1;
    next['version'] = version; profiles.push(next);
    for (const kind of kinds) if (kind.profile.id === entry.profile.id && kind.profile.version === entry.profile.version) kind.profile = { id: entry.profile.id, version };
    applied.push({ profile: entry.profile.id, from: entry.profile.version, to: version });
  }
  if (!applied.length) return null;
  return Object.freeze({ registry: executionRegistrySchema.parse({ ...registry, revision: `${baseRevision(registry.revision)}@${proposal.imageVersion}`, profiles, kinds }), applied: Object.freeze(applied) });
}
