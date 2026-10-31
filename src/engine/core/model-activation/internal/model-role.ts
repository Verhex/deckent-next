import { CORE_MODEL_ROLES, decideRoleModel, eligibleRoleModels, mergeModelRoleRegistries, modelInvocationProfileSchema, modelRoleConfigSchema, parseProviderCatalog, roleModelKey, type ModelActivationRecord,
  type ModelReference, type ModelRolePolicy, type RoleModelDecision, type RoleModelRow, type RoleModelTarget } from '#domain/index.js';

/**
 * Permission of a role target (S2, owner A2): the scope's activation of a declared catalog reference serving that exact model (provider id =
 * channel id, native id = model id) — the activation model invocation itself enforces. Tier never stands in for it.
 */
export interface RoleModelActivationPorts {
  references(target: RoleModelTarget): readonly ModelReference[];
  activation(scopeId: string, reference: ModelReference): Promise<ModelActivationRecord | null>;
}
/** What a caller reads for a role decision: the `model_roles` config section, the declared `provider_catalog` and the activation store. */
export type RoleModelSources = Readonly<{ modelRoles: unknown; providerCatalog: unknown;
  activation(scopeId: string, reference: ModelReference): Promise<ModelActivationRecord | null> }>;
/** The Core tier/role seed with the installation's overlays, composed per call (never cached past the config that carried it). */
export const composeModelRolePolicy = (section: unknown) => mergeModelRoleRegistries(CORE_MODEL_ROLES, section === undefined ? [] : modelRoleConfigSchema.parse(section).overlays);
export function roleModelPorts(sources: RoleModelSources): RoleModelActivationPorts {
  const catalog = sources.providerCatalog === undefined ? null : parseProviderCatalog(sources.providerCatalog);
  return { activation: (scopeId, reference) => sources.activation(scopeId, reference),
    references: target => (catalog?.providers ?? []).filter(row => row.id === target.channelId).flatMap(provider => provider.models
      .filter(model => model.nativeId === target.modelId).map(model => ({ providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version }))) };
}
const utcDay = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10);
async function activeKeys(scopeId: string, targets: readonly RoleModelTarget[], ports: RoleModelActivationPorts) {
  const active = new Set<string>();
  for (const target of targets) {
    const key = roleModelKey(target);
    if (active.has(key)) continue;
    for (const reference of ports.references(target)) if ((await ports.activation(scopeId, reference))?.state === 'active') { active.add(key); break; }
  }
  return active;
}
/** One target's decision in a scope. `targetActive` (the exact selected reference's activation) replaces the lookup for the target itself. */
export async function decideRoleModelInScope(policy: ModelRolePolicy, roleId: string, scopeId: string, target: RoleModelTarget, ports: RoleModelActivationPorts,
  nowMs: number, targetActive?: boolean): Promise<RoleModelDecision> {
  // Only measured rows of the role can drop an exception, so only they are read besides the target.
  const measured = policy.models.filter(row => row.measured !== undefined && row.roles.includes(roleId) && roleModelKey(row) !== roleModelKey(target));
  const active = await activeKeys(scopeId, targetActive === undefined ? [target, ...measured] : measured, ports);
  if (targetActive) active.add(roleModelKey(target));
  // A `connected` role needs only to know whether the declared catalog serves the target.
  return decideRoleModel(policy, roleId, target, { today: utcDay(nowMs), active, catalog: ports.references(target).length ? [target] : [] });
}
/** Read port for later role consumers (S6R-5 recovery decision, S4B memory evaluator, BeUser setup): the role's models today, each with its permission. */
export async function inspectRoleModelsInScope(sources: RoleModelSources, roleId: string, scopeId: string, nowMs: number) {
  const policy = composeModelRolePolicy(sources.modelRoles), ports = roleModelPorts(sources);
  const catalog = sources.providerCatalog === undefined ? [] : parseProviderCatalog(sources.providerCatalog).providers
    .flatMap(provider => provider.models.map(model => ({ channelId: provider.id, modelId: model.nativeId })));
  const today = utcDay(nowMs), listed = eligibleRoleModels(policy, roleId, { today, active: new Set(), catalog });
  const measured = policy.models.filter(row => row.measured !== undefined && row.roles.includes(roleId));
  const models: readonly RoleModelRow[] = eligibleRoleModels(policy, roleId, { today, active: await activeKeys(scopeId, [...listed, ...measured], ports), catalog });
  return Object.freeze({ schemaVersion: 1 as const, scopeId, role: roleId, revision: policy.revision, models });
}
/** A role target's invocable path (S4B-3, S6R-5): the declared reference that has an invocation profile in the scope for this (channel, exact model); none: null. */
export function roleModelInvocationReference(sources: RoleModelSources, profiles: unknown, scopeId: string, target: { readonly channelId: string; readonly modelId: string }): ModelReference | null {
  const held = ((profiles as { profiles?: unknown[] } | undefined)?.profiles ?? []).map(value => modelInvocationProfileSchema.parse(value));
  const references = sources.providerCatalog === undefined ? [] : roleModelPorts(sources).references(target);
  return references.find(reference => held.some(profile => profile.scopeId === scopeId && JSON.stringify(profile.reference) === JSON.stringify(reference))) ?? null;
}
