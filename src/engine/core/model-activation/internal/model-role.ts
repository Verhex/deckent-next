import { CORE_MODEL_ROLES, decideRoleModel, eligibleRoleModels, mergeModelRoleRegistries, modelRoleConfigSchema, parseProviderCatalog, roleModelKey, type ModelActivationRecord,
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
  return decideRoleModel(policy, roleId, target, { today: utcDay(nowMs), active });
}
/** Read port for later role consumers (S6R-5 recovery decision, S4B memory evaluator): the role's models today, each with its permission. */
export async function inspectRoleModelsInScope(sources: RoleModelSources, roleId: string, scopeId: string, nowMs: number) {
  const policy = composeModelRolePolicy(sources.modelRoles), ports = roleModelPorts(sources);
  const today = utcDay(nowMs), listed = eligibleRoleModels(policy, roleId, { today, active: new Set() });
  const measured = policy.models.filter(row => row.measured !== undefined && row.roles.includes(roleId));
  const models: readonly RoleModelRow[] = eligibleRoleModels(policy, roleId, { today, active: await activeKeys(scopeId, [...listed, ...measured], ports) });
  return Object.freeze({ schemaVersion: 1 as const, scopeId, role: roleId, revision: policy.revision, models });
}
