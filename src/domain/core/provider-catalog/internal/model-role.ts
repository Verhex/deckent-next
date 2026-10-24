import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { exactModelIdSchema, daySchema } from './catalog-values.js';
import asset from '../../../../../assets/model-roles/model-roles.json' with { type: 'json' };
import limits from './model-role-limits.json' with { type: 'json' };

/**
 * Model tier/role registry (S2, owner A2, A3, BRAIN1): which exact catalog models may serve which role. Tier is eligibility, the scope's
 * activation is permission, and a role asks for both. Rows are keyed by (channel id, exact model id), the catalog row identity; aliases and
 * vendor links never match. Tiers are ordered; a role names the lowest tier it accepts. The only way past a role's tier is a named, dated
 * exception that drops once a measured row of the role's tier is active in the scope. An overlay adds rows and roles, and replaces a row or
 * exception only by a compare-and-set against its version; it never redefines a role.
 */
export const MODEL_TIERS = Object.freeze(['worker', 'frontier'] as const);
/** The registry's bounds (`model-role-limits.json`), read by the typed role admission too (M2). */
export const MODEL_ROLE_LIMITS = Object.freeze({ ...limits });
export type ModelTier = typeof MODEL_TIERS[number];
const rank = (tier: ModelTier) => MODEL_TIERS.indexOf(tier);
const tierSchema = z.enum(MODEL_TIERS);
const version = z.number().int().positive().safe();
const override = z.object({ previousVersion: version }).strict().readonly();
const unique = (values: readonly string[]) => new Set(values).size === values.length;
/** Days since 1970-01-01 of a validated UTC day (civil-calendar arithmetic; the domain reads no clock). */
const dayNumber = (day: string) => {
  const [y0, m, d] = day.split('-').map(Number) as [number, number, number], y = m <= 2 ? y0 - 1 : y0, era = Math.floor(y / 400), yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146_097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719_468;
};
const roleSchema = z.object({ id: identitySchema, minimumTier: tierSchema }).strict().readonly();
const modelRowSchema = z.object({ channelId: identitySchema, modelId: exactModelIdSchema, version, tier: tierSchema,
  roles: z.array(identitySchema).max(limits.rolesPerModel).readonly(),
  /** Evidence that this row was measured as the role's model (owner A3/H5): only a measured active row drops an exception. */
  measured: z.object({ on: daySchema, source: identitySchema }).strict().readonly().optional(),
  override: override.optional(),
}).strict().refine(row => unique(row.roles) && (row.override === undefined || row.override.previousVersion < row.version)).readonly();
const exceptionSchema = z.object({ id: identitySchema, version, role: identitySchema, channelId: identitySchema, modelId: exactModelIdSchema,
  source: identitySchema, declaredOn: daySchema, expiresOn: daySchema, override: override.optional(),
}).strict().refine(row => dayNumber(row.declaredOn) <= dayNumber(row.expiresOn) && dayNumber(row.expiresOn) - dayNumber(row.declaredOn) <= limits.exceptionMaxDays
  && (row.override === undefined || row.override.previousVersion < row.version)).readonly();
export const roleModelKey = (target: Readonly<{ channelId: string; modelId: string }>) => JSON.stringify([target.channelId, target.modelId]);
export const modelRoleRegistrySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema,
  roles: z.array(roleSchema).max(limits.roles).readonly(),
  models: z.array(modelRowSchema).max(limits.models).readonly(),
  exceptions: z.array(exceptionSchema).max(limits.exceptions).readonly(),
}).strict().refine(value => unique(value.roles.map(row => row.id)) && unique(value.models.map(roleModelKey)) && unique(value.exceptions.map(row => row.id))).readonly();
export type ModelRoleRegistry = z.infer<typeof modelRoleRegistrySchema>;
/** Config section `model_roles`: installation overlays over the Core seed, in precedence order. Absent = the Core seed alone; an empty object
 * is not a section, so a default-filled or healed configuration never synthesizes one (nor writes it into a project layer). */
export const modelRoleConfigSchema = z.object({ schemaVersion: z.literal(1), overlays: z.array(modelRoleRegistrySchema).max(limits.overlays) }).strict();
export const CORE_MODEL_ROLES: ModelRoleRegistry = modelRoleRegistrySchema.parse(asset);
export type ModelRoleErrorCode = 'MODEL_ROLE_OVERRIDE_DENIED' | 'MODEL_ROLE_NOT_REGISTERED' | 'MODEL_ROLE_TIER_INVALID' | 'MODEL_ROLE_REGISTRY_LIMIT' | 'MODEL_ROLE_REVISION_INVALID'
  /** M2 typed role admission: a model outside the scope's catalog, a malformed request or section, a card older than the registry. */
  | 'MODEL_ROLE_CATALOG_UNKNOWN' | 'MODEL_ROLE_COMMAND_INVALID' | 'MODEL_ROLE_STALE';
export class ModelRoleError extends Error {
  constructor(readonly code: ModelRoleErrorCode) { super(code); this.name = 'ModelRoleError'; }
}
export type ModelRolePolicy = Readonly<{ revision: string; roles: readonly ModelRoleRegistry['roles'][number][];
  models: readonly ModelRoleRegistry['models'][number][]; exceptions: readonly ModelRoleRegistry['exceptions'][number][] }>;
/** Caller order is precedence; the revision is the Core revision, or the ordered tuple of every revision when overlays apply. */
export function mergeModelRoleRegistries(coreInput: unknown, overlayInputs: readonly unknown[]): ModelRolePolicy {
  if (overlayInputs.length > limits.overlays) throw new ModelRoleError('MODEL_ROLE_REGISTRY_LIMIT');
  const core = modelRoleRegistrySchema.parse(coreInput), overlays = overlayInputs.map(input => modelRoleRegistrySchema.parse(input));
  if (core.models.some(row => row.override !== undefined) || core.exceptions.some(row => row.override !== undefined)) throw new ModelRoleError('MODEL_ROLE_OVERRIDE_DENIED');
  const roles = new Map(core.roles.map(row => [row.id, row])), models = new Map(core.models.map(row => [roleModelKey(row), row]));
  const exceptions = new Map(core.exceptions.map(row => [row.id, row]));
  const replace = <T extends { version: number; override?: { previousVersion: number } | undefined }>(map: Map<string, T>, key: string, row: T) => {
    const previous = map.get(key);
    if (previous ? row.override?.previousVersion !== previous.version : row.override !== undefined) throw new ModelRoleError('MODEL_ROLE_OVERRIDE_DENIED');
    map.set(key, row);
  };
  for (const overlay of overlays) {
    for (const row of overlay.roles) { if (roles.has(row.id)) throw new ModelRoleError('MODEL_ROLE_OVERRIDE_DENIED'); roles.set(row.id, row); }
    for (const row of overlay.models) replace(models, roleModelKey(row), row);
    for (const row of overlay.exceptions) replace(exceptions, row.id, row);
  }
  if (roles.size > limits.roles || models.size > limits.models || exceptions.size > limits.exceptions) throw new ModelRoleError('MODEL_ROLE_REGISTRY_LIMIT');
  for (const row of models.values()) for (const id of row.roles) {
    const role = roles.get(id);
    if (!role) throw new ModelRoleError('MODEL_ROLE_NOT_REGISTERED');
    if (rank(row.tier) < rank(role.minimumTier)) throw new ModelRoleError('MODEL_ROLE_TIER_INVALID');
  }
  if ([...exceptions.values()].some(row => !roles.has(row.role))) throw new ModelRoleError('MODEL_ROLE_NOT_REGISTERED');
  const revision = overlays.length === 0 ? core.revision : JSON.stringify([core.revision, ...overlays.map(row => row.revision)]);
  if (!identitySchema.safeParse(revision).success) throw new ModelRoleError('MODEL_ROLE_REVISION_INVALID');
  return Object.freeze({ revision, roles: Object.freeze([...roles.values()]), models: Object.freeze([...models.values()]), exceptions: Object.freeze([...exceptions.values()]) });
}
export type RoleModelTarget = Readonly<{ channelId: string; modelId: string }>;
/** `today` is the UTC day the caller observed; `active` holds the `roleModelKey` of every target the scope has active (permission). */
export type RoleModelFacts = Readonly<{ today: string; active: ReadonlySet<string> }>;
export type RoleModelRefusal = 'role-unknown' | 'model-unknown' | 'tier' | 'role-not-held' | 'exception-not-current' | 'exception-dropped' | 'not-active';
export type RoleModelDecision = Readonly<{ state: 'eligible'; basis: 'tier'; tier: ModelTier }>
  | Readonly<{ state: 'eligible'; basis: 'exception'; tier: ModelTier | null; exceptionId: string; expiresOn: string }>
  | Readonly<{ state: 'refused'; reason: RoleModelRefusal }>;
const holds = (row: ModelRolePolicy['models'][number], role: ModelRolePolicy['roles'][number]) => row.roles.includes(role.id) && rank(row.tier) >= rank(role.minimumTier);
const current = (row: ModelRolePolicy['exceptions'][number], today: string) => dayNumber(row.declaredOn) <= dayNumber(today) && dayNumber(today) <= dayNumber(row.expiresOn);
const measuredActive = (policy: ModelRolePolicy, role: ModelRolePolicy['roles'][number], active: ReadonlySet<string>) =>
  policy.models.some(row => row.measured !== undefined && holds(row, role) && active.has(roleModelKey(row)));
/** One role decision for one exact target, pure and deterministic; never names another model. */
export function decideRoleModel(policy: ModelRolePolicy, roleId: string, target: RoleModelTarget, facts: RoleModelFacts): RoleModelDecision {
  const role = policy.roles.find(row => row.id === roleId), key = roleModelKey(target);
  if (!role) return { state: 'refused', reason: 'role-unknown' };
  const row = policy.models.find(entry => roleModelKey(entry) === key);
  if (row && holds(row, role)) return facts.active.has(key) ? { state: 'eligible', basis: 'tier', tier: row.tier } : { state: 'refused', reason: 'not-active' };
  const exception = policy.exceptions.find(entry => entry.role === role.id && roleModelKey(entry) === key);
  if (!exception) return { state: 'refused', reason: !row ? 'model-unknown' : rank(row.tier) < rank(role.minimumTier) ? 'tier' : 'role-not-held' };
  if (!current(exception, facts.today)) return { state: 'refused', reason: 'exception-not-current' };
  if (measuredActive(policy, role, facts.active)) return { state: 'refused', reason: 'exception-dropped' };
  if (!facts.active.has(key)) return { state: 'refused', reason: 'not-active' };
  return { state: 'eligible', basis: 'exception', tier: row?.tier ?? null, exceptionId: exception.id, expiresOn: exception.expiresOn };
}
export type RoleModelRow = Readonly<{ channelId: string; modelId: string; tier: ModelTier; basis: 'tier'; measured: boolean; active: boolean }>
  | Readonly<{ channelId: string; modelId: string; tier: ModelTier | null; basis: 'exception'; exceptionId: string; expiresOn: string; active: boolean }>;
/** Read port (S6R-5 recovery decision, S4B memory evaluator): every model the role may use today, in registry order, with its permission. */
export function eligibleRoleModels(policy: ModelRolePolicy, roleId: string, facts: RoleModelFacts): readonly RoleModelRow[] {
  const role = policy.roles.find(row => row.id === roleId);
  if (!role) throw new ModelRoleError('MODEL_ROLE_NOT_REGISTERED');
  const rows: RoleModelRow[] = policy.models.filter(row => holds(row, role)).map(row => ({ channelId: row.channelId, modelId: row.modelId, tier: row.tier, basis: 'tier' as const,
    measured: row.measured !== undefined, active: facts.active.has(roleModelKey(row)) }));
  const listed = new Set(rows.map(roleModelKey));
  if (!measuredActive(policy, role, facts.active)) for (const entry of policy.exceptions) {
    if (entry.role !== role.id || !current(entry, facts.today) || listed.has(roleModelKey(entry))) continue;
    rows.push({ channelId: entry.channelId, modelId: entry.modelId, tier: policy.models.find(row => roleModelKey(row) === roleModelKey(entry))?.tier ?? null,
      basis: 'exception', exceptionId: entry.id, expiresOn: entry.expiresOn, active: facts.active.has(roleModelKey(entry)) });
  }
  return Object.freeze(rows);
}
