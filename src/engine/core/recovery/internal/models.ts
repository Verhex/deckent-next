import { RECOVERY_DECISION_SEED, delegatedUseOf, loadRecoveryDecisionRegistry, modelInvocationProfileSchema, recoveryPrincipal, type ModelReference } from '#domain/index.js';
import { inspectRoleModelsInScope, type RoleModelSources } from '#engine/core/model-activation/index.js';
import { memoryCatalogKey, memoryEvaluatorReference, type MemoryCatalogFact } from '#engine/core/memory/index.js';
import type { RecoveryModelRow } from './decide.js';

/** The S2 role a recovery decision model must hold (registry data; the role registry restricts the recovery principal's model grant to its rows). */
export const RECOVERY_DECISION_ROLE = 'recovery-decision';
/** The composition-root recovery principal acting for `owner` in one scope (S6R-4 identity; only the composition root issues it). */
export const recoveryDecisionPrincipal = (owner: Readonly<{ issuer: string; subject: string }>, scopeId: string) => recoveryPrincipal(owner, [scopeId]);
/** The current Core recovery-decision registry (versioned seed; provisional until measured). */
export const recoveryDecisionRegistry = () => loadRecoveryDecisionRegistry(RECOVERY_DECISION_SEED);
/** The declared reference that has an invocation profile in the scope for this (channel, exact model) — the only invocable path (none: null). */
export const recoveryModelReference = (sources: RoleModelSources, profiles: unknown, scopeId: string, target: Readonly<{ channelId: string; modelId: string }>): ModelReference | null =>
  memoryEvaluatorReference(sources, profiles, scopeId, target);
/**
 * S6R-5: the scope's active `recovery-decision` role rows (S2) in registry order, each with whether a profile serves it here, its channel's billing
 * axis (catalog data) and the delegated-use consent its profile's adapter definition carries (S3-3 writes it; Q-H3). No model id is a literal here.
 */
export async function recoveryModelRows(sources: RoleModelSources, profiles: unknown, scopeId: string, facts: ReadonlyMap<string, MemoryCatalogFact>, nowMs: number): Promise<readonly RecoveryModelRow[]> {
  const held = ((profiles as { profiles?: unknown[] } | undefined)?.profiles ?? []).map(value => modelInvocationProfileSchema.parse(value));
  const listed = await inspectRoleModelsInScope(sources, RECOVERY_DECISION_ROLE, scopeId, nowMs);
  return listed.models.filter(row => row.active).map(row => {
    const reference = recoveryModelReference(sources, profiles, scopeId, row);
    const profile = reference ? held.find(value => value.scopeId === scopeId && JSON.stringify(value.reference) === JSON.stringify(reference)) ?? null : null;
    return Object.freeze({ channelId: row.channelId, modelId: row.modelId, invocable: reference !== null, billing: facts.get(memoryCatalogKey(row.channelId, row.modelId))?.billing ?? null,
      consent: profile ? delegatedUseOf(profile.adapter.definition) : null });
  });
}
