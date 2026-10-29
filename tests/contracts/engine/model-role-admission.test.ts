import { describe, expect, it } from 'vitest';
import { CORE_MODEL_ROLES, decideRoleModel, mergeModelRoleRegistries, modelRoleConfigSchema, roleModelKey } from '#domain/index.js';
import { ModelRoleAdmissionApplication, modelRoleCoverage, catalogRoleFacts, planModelRoleAssignment, type ModelCatalogInspection,
  type ModelRoleAdmissionPorts } from '#engine/index.js';

// M2 (owner 2026-10-23: a new model works through a data update, never a release or a model literal; fail-closed until a person assigns
// its role). The person's card writes ONE `model_roles` row into one installation overlay by compare-and-set; the merge validates it first.
const DIGEST = 'a'.repeat(64);
const priced = (vendorId: string, displayName: string) => ({ vendorId, displayName, pricing: { kind: 'per-token', asOf: '2026-10-23', inputPerMTok: '4', outputPerMTok: '20',
  source: { sourceUrl: 'https://example.test/pricing', fetchedOn: '2026-10-23' } } });
/** A registered catalog as the scope sees it: one known Core model and one model the Core seed has never heard of. */
const catalog = (extra: readonly { channelId: string; modelId: string }[] = []): ModelCatalogInspection => ({ schemaVersion: 1, scopeId: 's', channels: [
  { channelId: 'anthropic-api', access: 'allowed', revision: 1, providerVersion: 1, catalogRevision: 'c1', channel: {} as never, activation: null,
    models: [{ modelId: 'claude-sonnet-5-5', revision: 1, model: priced('anthropic', 'Claude Sonnet 5.5') as never, activation: null },
      { modelId: 'claude-next-1', revision: 1, model: priced('anthropic', 'Claude Next 1') as never, activation: null },
      ...extra.filter(row => row.channelId === 'anthropic-api').map(row => ({ modelId: row.modelId, revision: 1, model: {} as never, activation: null }))] },
  { channelId: 'hidden', access: 'denied' },
] });
function ports(section: unknown, digest: string | null = DIGEST, inspection = catalog()) {
  const submitted: { value: unknown; expect: string | null; commandId: string }[] = [];
  const value: ModelRoleAdmissionPorts = {
    section: async () => ({ digest, value: section }),
    catalog: async () => inspection,
    submit: async input => { submitted.push(input); return { status: 'applied', approvalId: null, result: { keyPath: 'model_roles', layer: 'global', beforeDigest: digest, afterDigest: 'b'.repeat(64), backupPath: null, overridden: false } }; },
  };
  return { value, submitted };
}
const command = (extra: object) => ({ schemaVersion: 1, commandId: 'c1', scopeId: 's', channelId: 'anthropic-api', modelId: 'claude-next-1', tier: 'frontier',
  roles: ['brain', 'worker'], expect: DIGEST, ...extra });
const next = { channelId: 'anthropic-api', modelId: 'claude-next-1' };

describe('model role admission (M2)', () => {
  it('a catalog model with no role row is pending and fails closed until a person assigns it', async () => {
    const policy = mergeModelRoleRegistries(CORE_MODEL_ROLES, []);
    const coverage = modelRoleCoverage(policy, catalogRoleFacts(catalog()));
    expect(coverage.find(row => row.modelId === 'claude-next-1')).toMatchObject({ state: 'pending', tier: null, roles: [], catalog: { maker: 'anthropic', displayName: 'Claude Next 1' } });
    expect(coverage.find(row => row.modelId === 'claude-sonnet-5-5')).toMatchObject({ state: 'assigned', tier: 'worker', roles: ['worker'], version: 1 });
    expect(decideRoleModel(policy, 'brain', next, { today: '2026-10-23', active: new Set([roleModelKey(next)]) })).toEqual({ state: 'refused', reason: 'model-unknown' });
    const view = await new ModelRoleAdmissionApplication(ports(undefined).value).inspect({ schemaVersion: 1, scopeId: 's' });
    expect(view).toMatchObject({ digest: DIGEST, revision: CORE_MODEL_ROLES.revision, pending: 1 });
    expect(view.models.map(row => row.modelId)).toEqual(['claude-sonnet-5-5', 'claude-next-1']);
    expect(view.roles.map(row => row.id)).toEqual(['brain', 'worker', 'recovery-decision', 'memory-evaluator', 'beuser-walker', 'beuser-evaluator']);
  });

  it('refuses a worker-tier Brain, an unregistered role, a model outside the catalog and a stale card before any write', async () => {
    for (const [input, code, catalogRows] of [
      [command({ tier: 'worker', roles: ['brain'] }), 'MODEL_ROLE_TIER_INVALID', catalog()],
      [command({ roles: ['auditor'] }), 'MODEL_ROLE_NOT_REGISTERED', catalog()],
      [command({ modelId: 'claude-unlisted-9' }), 'MODEL_ROLE_CATALOG_UNKNOWN', catalog()],
      [command({ channelId: 'hidden', modelId: 'claude-next-1' }), 'MODEL_ROLE_CATALOG_UNKNOWN', catalog()],
      [command({ expect: 'c'.repeat(64) }), 'MODEL_ROLE_STALE', catalog()],
      [command({ roles: ['brain', 'brain'] }), 'MODEL_ROLE_COMMAND_INVALID', catalog()],
    ] as const) {
      const fake = ports(undefined, DIGEST, catalogRows);
      await expect(new ModelRoleAdmissionApplication(fake.value).assign(input)).rejects.toMatchObject({ code });
      expect(fake.submitted).toEqual([]);
    }
  });

  it('a new model gets its row in one installation overlay (no override); the merged policy then serves the role once active', async () => {
    const fake = ports(undefined);
    expect(await new ModelRoleAdmissionApplication(fake.value).assign(command({}))).toMatchObject({ status: 'applied', row: { ...next, tier: 'frontier', roles: ['brain', 'worker'], version: 1 } });
    expect(fake.submitted).toHaveLength(1); expect(fake.submitted[0]).toMatchObject({ expect: DIGEST, commandId: 'c1' });
    const section = modelRoleConfigSchema.parse(fake.submitted[0]!.value);
    expect(section.overlays).toHaveLength(1);
    expect(section.overlays[0]!.models).toEqual([{ ...next, version: 1, tier: 'frontier', roles: ['brain', 'worker'] }]);
    const policy = mergeModelRoleRegistries(CORE_MODEL_ROLES, section.overlays);
    expect(decideRoleModel(policy, 'brain', next, { today: '2026-10-23', active: new Set([roleModelKey(next)]) })).toMatchObject({ state: 'eligible', basis: 'tier', tier: 'frontier' });
    expect(decideRoleModel(policy, 'brain', next, { today: '2026-10-23', active: new Set() })).toEqual({ state: 'refused', reason: 'not-active' });
  });

  it('changing a Core row twice keeps the compare-and-set on the Core version and changes the overlay revision each time', () => {
    const sonnet = { channelId: 'anthropic-api', modelId: 'claude-sonnet-5-5' };
    const first = planModelRoleAssignment(undefined, { ...sonnet, tier: 'worker', roles: [] });
    expect(first.changed).toBe(true);
    expect(first.row).toEqual({ ...sonnet, version: 2, tier: 'worker', roles: [], override: { previousVersion: 1 } });
    const second = planModelRoleAssignment(first.section, { ...sonnet, tier: 'worker', roles: ['worker'] });
    expect(second.section.overlays).toHaveLength(1);
    expect(second.row).toEqual({ ...sonnet, version: 3, tier: 'worker', roles: ['worker'], override: { previousVersion: 1 } });
    expect(second.section.overlays[0]!.revision).not.toBe(first.section.overlays[0]!.revision);
    expect(() => mergeModelRoleRegistries(CORE_MODEL_ROLES, second.section.overlays)).not.toThrow();
    // The same tier and roles again: nothing to write.
    expect(planModelRoleAssignment(second.section, { ...sonnet, tier: 'worker', roles: ['worker'] }).changed).toBe(false);
  });

  it('never edits an overlay it does not own: an Enterprise overlay stays byte-identical and the person row compares-and-sets against it', () => {
    const acme = { schemaVersion: 1, revision: 'acme-1', roles: [], models: [{ ...next, version: 4, tier: 'worker', roles: ['worker'] }], exceptions: [] };
    const plan = planModelRoleAssignment({ schemaVersion: 1, overlays: [acme] }, { ...next, tier: 'frontier', roles: ['brain'] });
    expect(plan.section.overlays[0]).toEqual(acme);
    expect(plan.section.overlays).toHaveLength(2);
    expect(plan.row).toEqual({ ...next, version: 5, tier: 'frontier', roles: ['brain'], override: { previousVersion: 4 } });
  });

  it('refuses a new overlay past the registry bound, typed, and forwards a pending approval without claiming a write', async () => {
    const full = { schemaVersion: 1, overlays: Array.from({ length: 16 }, (_, index) => ({ schemaVersion: 1, revision: `e-${index}`, roles: [], models: [], exceptions: [] })) };
    expect(() => planModelRoleAssignment(full, { ...next, tier: 'frontier', roles: ['brain'] })).toThrow(expect.objectContaining({ code: 'MODEL_ROLE_REGISTRY_LIMIT' }));
    const fake = ports(undefined);
    fake.value.submit = async input => ({ status: 'approval-pending', commandId: input.commandId, expect: input.expect, keyPath: 'model_roles', layer: 'global',
      approval: { approvalId: 'ap-1', revision: 1, expiresAt: 9, summary: 'Setting will change' } });
    expect(await new ModelRoleAdmissionApplication(fake.value).assign(command({}))).toMatchObject({ status: 'approval-pending', approvalId: 'ap-1' });
    const unchanged = ports({ schemaVersion: 1, overlays: [] });
    expect(await new ModelRoleAdmissionApplication(unchanged.value).assign(command({ modelId: 'claude-sonnet-5-5', tier: 'worker', roles: ['worker'] }))).toMatchObject({ status: 'unchanged' });
    expect(unchanged.submitted).toEqual([]);
  });
});
