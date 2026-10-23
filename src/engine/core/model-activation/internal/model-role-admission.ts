import { z } from 'zod';
import { CORE_MODEL_ROLES, MODEL_ROLE_LIMITS as limits, MODEL_TIERS, ModelRoleError, canonicalModelMaker, clientCommandIdSchema, exactModelIdSchema, identitySchema, mergeModelRoleRegistries,
  modelRoleConfigSchema, roleModelKey, type ModelRoleErrorCode, type ModelRolePolicy, type ModelRoleRegistry, type ModelTier, type RoleModelTarget } from '#domain/index.js';
import type { ModelCatalogInspection } from './catalog.js';
import settings from './model-role-admission.json' with { type: 'json' };

/**
 * M2 typed role admission (owner 2026-10-23: a new model works through a data update, with no release and no model literal; it is fail-closed
 * until a person assigns its role). `inspect` is the one read view (CLI `models roles`, MCP `inspect_model_roles`, doctor): every registered
 * catalog model the scope sees, each with its tier/role row or `pending`. `assign` writes ONE row into the one installation overlay this
 * command owns (revision `<prefix><n>`, prefix in `model-role-admission.json`), through the governed config write of the global layer: the layer digest the
 * card showed is the compare-and-set, the merge (`mergeModelRoleRegistries`) validates the whole section before anything is submitted, and the
 * config application audits it as a sealed `config-change`. Overlays it does not own are never edited.
 */
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const modelRoleQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, channelId: identitySchema.optional(), modelId: exactModelIdSchema.optional() })
  .strict().readonly();
export type ModelRoleQuery = z.infer<typeof modelRoleQuerySchema>;
export const modelRoleAssignCommandSchema = z.object({ schemaVersion: z.literal(1), commandId: clientCommandIdSchema, scopeId: identitySchema, channelId: identitySchema,
  modelId: exactModelIdSchema, tier: z.enum(MODEL_TIERS), roles: z.array(identitySchema).max(limits.rolesPerModel).refine(roles => new Set(roles).size === roles.length).readonly(),
  /** The global layer digest the card showed (null: no global configuration file yet). */
  expect: digestSchema.nullable() }).strict().readonly();
export type ModelRoleAssignCommand = z.infer<typeof modelRoleAssignCommandSchema>;

/** What the catalog row says of a model: its name, canonical maker and price evidence (never a tier or role). */
export type ModelRoleCatalogFacts = Readonly<{ channelId: string; modelId: string; displayName: string | null; maker: string | null;
  pricing: Readonly<{ kind: string; asOf: string | null; inputPerMTok: string | null; outputPerMTok: string | null }> | null }>;
export type ModelRoleEntry = Readonly<{ channelId: string; modelId: string; catalog: ModelRoleCatalogFacts | null;
  /** `pending`: no row and no exception names it, so every role refuses it (`model-unknown`) until a person assigns one. */
  state: 'assigned' | 'exception' | 'pending'; tier: ModelTier | null; roles: readonly string[]; version: number | null; measured: boolean;
  exceptions: readonly string[] }>;
export type ModelRoleInspection = Readonly<{ schemaVersion: 1; scopeId: string; revision: string; digest: string | null;
  roles: readonly Readonly<{ id: string; minimumTier: ModelTier }>[]; models: readonly ModelRoleEntry[]; pending: number }>;
export type ModelRoleRow = ModelRoleRegistry['models'][number];
export type ModelRoleAssignResult = Readonly<{ status: 'applied'; row: ModelRoleRow; revision: string; approvalId: string | null }>
  | Readonly<{ status: 'approval-pending'; row: ModelRoleRow; approvalId: string; expiresAt: number; summary: string; commandId: string }>
  | Readonly<{ status: 'unchanged'; row: ModelRoleRow }>;
export type ModelRoleWriteOutcome = Readonly<{ status: 'applied'; approvalId: string | null }>
  | Readonly<{ status: 'approval-pending'; commandId: string; approval: Readonly<{ approvalId: string; expiresAt: number; summary: string }> }>;
export interface ModelRoleAdmissionPorts {
  /** The global layer's authored `model_roles` section and that layer's digest, from one read. */
  section(): Promise<Readonly<{ digest: string | null; value: unknown }>>;
  /** The registered catalog as the scope sees it (its own `inspect` decision per channel). */
  catalog(scopeId: string): Promise<ModelCatalogInspection>;
  /** The governed config write of `model_roles` on the global layer, compare-and-set on `expect` (policy, approval, sealed audit): the config
   * application's `submit` outcome. */
  submit(input: Readonly<{ scopeId: string; commandId: string; value: unknown; expect: string | null }>): Promise<ModelRoleWriteOutcome>;
}

const text = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : null;
/** Name, maker and price of every model row the scope may inspect; a denied channel contributes nothing. */
export function catalogRoleFacts(inspection: ModelCatalogInspection): readonly ModelRoleCatalogFacts[] {
  return Object.freeze(inspection.channels.flatMap(channel => channel.access !== 'allowed' ? [] : channel.models.map(entry => {
    const model = entry.model as { displayName?: unknown; pricing?: { kind?: unknown; asOf?: unknown; inputPerMTok?: unknown; outputPerMTok?: unknown } };
    const pricing = model.pricing && text(model.pricing.kind) ? Object.freeze({ kind: text(model.pricing.kind)!, asOf: text(model.pricing.asOf),
      inputPerMTok: text(model.pricing.inputPerMTok), outputPerMTok: text(model.pricing.outputPerMTok) }) : null;
    return Object.freeze({ channelId: channel.channelId, modelId: entry.modelId, displayName: text(model.displayName), maker: canonicalModelMaker(entry.model), pricing });
  })));
}
/** Every catalog model with its row (registry order is not imposed: catalog order is kept), `exception` or `pending`. Pure. */
export function modelRoleCoverage(policy: ModelRolePolicy, catalog: readonly ModelRoleCatalogFacts[]): readonly ModelRoleEntry[] {
  const rows = new Map(policy.models.map(row => [roleModelKey(row), row]));
  return Object.freeze(catalog.map(facts => {
    const row = rows.get(roleModelKey(facts)), exceptions = policy.exceptions.filter(entry => roleModelKey(entry) === roleModelKey(facts)).map(entry => entry.id);
    return Object.freeze({ channelId: facts.channelId, modelId: facts.modelId, catalog: facts, state: row ? 'assigned' as const : exceptions.length ? 'exception' as const : 'pending' as const,
      tier: row?.tier ?? null, roles: Object.freeze([...row?.roles ?? []]), version: row?.version ?? null, measured: row?.measured !== undefined, exceptions: Object.freeze(exceptions) });
  }));
}

/** The owned overlay's write counter (`<prefix><n>`), or null for an overlay this command does not own. */
const counter = (overlay: Readonly<{ revision: string }>) => {
  const rest = overlay.revision.startsWith(settings.ownedOverlayRevisionPrefix) ? overlay.revision.slice(settings.ownedOverlayRevisionPrefix.length) : '';
  return /^[1-9]\d*$/.test(rest) && Number.isSafeInteger(Number(rest)) ? Number(rest) : null;
};
const fail = (code: ModelRoleErrorCode): never => { throw new ModelRoleError(code); };
const sameRoles = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
/** The Core seed with these overlays; a refusal is the merge's own typed code. */
const merged = (overlays: readonly unknown[]): ModelRolePolicy => mergeModelRoleRegistries(CORE_MODEL_ROLES, overlays);
/**
 * One row for one exact (channel, model) in the owned overlay — created last when absent. The row's compare-and-set names the version of the
 * row as it stands before the owned overlay (Core or an earlier overlay); its version rises past both that row and the owned one it replaces.
 * The owned overlay's revision counter rises on every write. The whole section is merged before it is returned. Pure.
 */
export function planModelRoleAssignment(section: unknown, request: Readonly<RoleModelTarget & { tier: ModelTier; roles: readonly string[] }>) {
  let config: Readonly<{ schemaVersion: 1; overlays: readonly ModelRoleRegistry[] }>;
  try { config = section === undefined ? { schemaVersion: 1, overlays: [] } : modelRoleConfigSchema.parse(section); }
  catch { return fail('MODEL_ROLE_COMMAND_INVALID'); }
  const overlays: ModelRoleRegistry[] = [...config.overlays], key = roleModelKey(request);
  const index = overlays.map(overlay => counter(overlay) !== null).lastIndexOf(true), mine = index < 0 ? null : overlays[index]!;
  const effective = merged(overlays).models.find(row => roleModelKey(row) === key);
  const previous = merged(index < 0 ? overlays : overlays.slice(0, index)).models.find(row => roleModelKey(row) === key);
  const existing = mine?.models.find(row => roleModelKey(row) === key);
  const version = Math.max(previous?.version ?? 0, existing?.version ?? 0) + 1;
  const row: ModelRoleRow = Object.freeze({ channelId: request.channelId, modelId: request.modelId, version, tier: request.tier, roles: Object.freeze([...request.roles]),
    ...(effective?.measured ? { measured: effective.measured } : {}), ...(previous ? { override: Object.freeze({ previousVersion: previous.version }) } : {}) });
  if (effective && effective.tier === request.tier && sameRoles(effective.roles, request.roles)) return { changed: false as const, row: effective, section: config };
  const body = { roles: mine?.roles ?? [], models: [...(mine?.models ?? []).filter(entry => roleModelKey(entry) !== key), row], exceptions: mine?.exceptions ?? [] };
  const revision = `${settings.ownedOverlayRevisionPrefix}${(mine ? counter(mine)! : 0) + 1}`;
  const overlay = { schemaVersion: 1 as const, revision, ...body };
  if (index < 0) overlays.push(overlay); else overlays[index] = overlay;
  if (overlays.length > limits.overlays) fail('MODEL_ROLE_REGISTRY_LIMIT');
  const next = { schemaVersion: 1 as const, overlays };
  const policy = merged(next.overlays);
  return { changed: true as const, row, section: modelRoleConfigSchema.parse(next), revision: policy.revision };
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  try { return schema.parse(input); } catch { return fail('MODEL_ROLE_COMMAND_INVALID'); }
}
export class ModelRoleAdmissionApplication {
  constructor(private readonly ports: ModelRoleAdmissionPorts) {}
  async inspect(input: unknown): Promise<ModelRoleInspection> {
    const query = parse(modelRoleQuerySchema, input), current = await this.ports.section();
    const policy = merged(current.value === undefined ? [] : parse(modelRoleConfigSchema, current.value).overlays);
    const facts = catalogRoleFacts(await this.ports.catalog(query.scopeId)).filter(row => (query.channelId === undefined || row.channelId === query.channelId)
      && (query.modelId === undefined || row.modelId === query.modelId));
    const models = modelRoleCoverage(policy, facts);
    return Object.freeze({ schemaVersion: 1, scopeId: query.scopeId, revision: policy.revision, digest: current.digest,
      roles: Object.freeze(policy.roles.map(role => Object.freeze({ id: role.id, minimumTier: role.minimumTier }))), models, pending: models.filter(row => row.state === 'pending').length });
  }
  async assign(input: unknown): Promise<ModelRoleAssignResult> {
    const command = parse(modelRoleAssignCommandSchema, input), current = await this.ports.section();
    // The card's compare-and-set, checked before the catalog read; the config write checks it again under the layer lock.
    if (current.digest !== command.expect) fail('MODEL_ROLE_STALE');
    const key = roleModelKey(command);
    if (!catalogRoleFacts(await this.ports.catalog(command.scopeId)).some(row => roleModelKey(row) === key)) fail('MODEL_ROLE_CATALOG_UNKNOWN');
    const plan = planModelRoleAssignment(current.value, command);
    if (!plan.changed) return Object.freeze({ status: 'unchanged', row: plan.row });
    const outcome = await this.ports.submit({ scopeId: command.scopeId, commandId: command.commandId, value: plan.section, expect: command.expect });
    if (outcome.status === 'approval-pending') return Object.freeze({ status: 'approval-pending', row: plan.row, approvalId: outcome.approval.approvalId,
      expiresAt: outcome.approval.expiresAt, summary: outcome.approval.summary, commandId: outcome.commandId });
    return Object.freeze({ status: 'applied', row: plan.row, revision: plan.revision, approvalId: outcome.approvalId });
  }
}
