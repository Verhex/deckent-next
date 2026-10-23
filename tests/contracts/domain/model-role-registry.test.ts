import { readdir, readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { CORE_MODEL_ROLES, eligibleRoleModels, decideRoleModel, mergeModelRoleRegistries, modelRoleConfigSchema, modelRoleRegistrySchema, parseProviderCatalogDocument,
  roleModelKey } from '#domain/index.js';

// S2 (owner A2, A3, BRAIN1): a separate versioned tier/role registry. Tier is eligibility; activation is permission; a role asks for both.
// The Brain role needs the frontier tier; the only way past it is a named, dated exception that drops once a measured frontier Brain is active.
const overlay = (extra: object) => modelRoleRegistrySchema.parse({ schemaVersion: 1, revision: 'acme-1', roles: [], models: [], exceptions: [], ...extra });
const qwen = { id: 'qwen-interim-brain', version: 1, role: 'brain', channelId: 'local-qwen', modelId: 'Qwen3.8-27B-Q4_K_M', source: 'owner-a3',
  declaredOn: '2026-10-20', expiresOn: '2026-11-10' };
const opus = { channelId: 'anthropic-api', modelId: 'claude-opus-5-5' };
const none = new Set<string>();

it('the Core seed names exactly the owner Brain list as frontier Brain rows, and declares the four roles', () => {
  const policy = mergeModelRoleRegistries(CORE_MODEL_ROLES, []);
  expect(Object.fromEntries(policy.roles.map(row => [row.id, row.minimumTier]))).toEqual({ brain: 'frontier', worker: 'worker', 'recovery-decision': 'frontier', 'memory-evaluator': 'frontier' });
  const brain = eligibleRoleModels(policy, 'brain', { today: '2026-10-23', active: none });
  expect(new Set(brain.map(row => row.modelId))).toEqual(new Set(['claude-opus-5-5', 'claude-fable-5-1', 'gpt-6.1-sol', 'anthropic/claude-opus-5.5',
    'anthropic/claude-fable-5.1', 'openai/gpt-6.1-sol']));
  expect(brain.every(row => row.tier === 'frontier' && row.basis === 'tier' && row.active === false)).toBe(true);
  // gpt-6-astra stays a reviewing worker by owner decision (ANALIZ-ATAMA-TIER :71): frontier tier, no Brain role.
  expect(policy.models.find(row => row.modelId === 'gpt-6-astra' && row.channelId === 'codex-cli-subscription')).toMatchObject({ tier: 'frontier', roles: ['worker'] });
  expect(CORE_MODEL_ROLES.exceptions).toEqual([]);
  expect(policy.models.some(row => row.measured !== undefined)).toBe(false);
});

it('every packaged catalog model has exactly one tier row, and the registry names no model outside the packaged catalogs', async () => {
  const dir = new URL('../../../assets/model-catalog/', import.meta.url), packaged = new Set<string>();
  for (const name of (await readdir(dir)).filter(file => file.endsWith('.json'))) {
    const document = parseProviderCatalogDocument(JSON.parse(await readFile(new URL(name, dir), 'utf8')));
    for (const provider of document.providers) for (const model of provider.models) packaged.add(roleModelKey({ channelId: provider.id, modelId: model.nativeId }));
  }
  expect(new Set(CORE_MODEL_ROLES.models.map(row => roleModelKey(row)))).toEqual(packaged);
  expect(CORE_MODEL_ROLES.models).toHaveLength(packaged.size);
});

it('refuses a worker-tier Brain, an unknown model, a frontier row without the role and an unregistered role, typed', () => {
  const policy = mergeModelRoleRegistries(CORE_MODEL_ROLES, []), today = '2026-10-23';
  expect(decideRoleModel(policy, 'brain', { channelId: 'anthropic-api', modelId: 'claude-sonnet-5-5' }, { today, active: new Set([roleModelKey({ channelId: 'anthropic-api', modelId: 'claude-sonnet-5-5' })]) }))
    .toEqual({ state: 'refused', reason: 'tier' });
  expect(decideRoleModel(policy, 'brain', { channelId: 'local-vllm', modelId: 'qwen3-8b' }, { today, active: none })).toEqual({ state: 'refused', reason: 'model-unknown' });
  expect(decideRoleModel(policy, 'brain', { channelId: 'codex-cli-subscription', modelId: 'gpt-6-astra' }, { today, active: none })).toEqual({ state: 'refused', reason: 'role-not-held' });
  expect(decideRoleModel(policy, 'auditor', opus, { today, active: none })).toEqual({ state: 'refused', reason: 'role-unknown' });
  expect(() => eligibleRoleModels(policy, 'auditor', { today, active: none })).toThrow(expect.objectContaining({ code: 'MODEL_ROLE_NOT_REGISTERED' }));
  // Eligible but not active: permission is the activation's, never assumed.
  expect(decideRoleModel(policy, 'brain', opus, { today, active: none })).toEqual({ state: 'refused', reason: 'not-active' });
  expect(decideRoleModel(policy, 'brain', opus, { today, active: new Set([roleModelKey(opus)]) })).toMatchObject({ state: 'eligible', basis: 'tier', tier: 'frontier' });
});

it('honours the interim Qwen exception only while it is declared and inside its dates, and drops it once a measured frontier Brain is active', () => {
  const target = { channelId: qwen.channelId, modelId: qwen.modelId }, key = roleModelKey(target);
  const declared = mergeModelRoleRegistries(CORE_MODEL_ROLES, [overlay({ exceptions: [qwen] })]);
  expect(decideRoleModel(declared, 'brain', target, { today: '2026-10-23', active: new Set([key]) })).toEqual({ state: 'eligible', basis: 'exception', tier: null, exceptionId: qwen.id, expiresOn: qwen.expiresOn });
  for (const today of ['2026-10-19', '2026-11-11']) expect(decideRoleModel(declared, 'brain', target, { today, active: new Set([key]) })).toEqual({ state: 'refused', reason: 'exception-not-current' });
  // Not declared: the same model is simply unknown.
  expect(decideRoleModel(mergeModelRoleRegistries(CORE_MODEL_ROLES, []), 'brain', target, { today: '2026-10-23', active: new Set([key]) })).toEqual({ state: 'refused', reason: 'model-unknown' });
  // An unmeasured active frontier Brain does not drop it; a measured one does (A3), and the read port then lists only the frontier row.
  const measured = { ...opus, version: 2, tier: 'frontier', roles: ['brain', 'worker', 'recovery-decision', 'memory-evaluator'], measured: { on: '2026-10-22', source: 'h5-measurement' },
    override: { previousVersion: 1 } };
  expect(decideRoleModel(declared, 'brain', target, { today: '2026-10-23', active: new Set([key, roleModelKey(opus)]) })).toMatchObject({ state: 'eligible', basis: 'exception' });
  const after = mergeModelRoleRegistries(CORE_MODEL_ROLES, [overlay({ models: [measured], exceptions: [qwen] })]);
  expect(decideRoleModel(after, 'brain', target, { today: '2026-10-23', active: new Set([key, roleModelKey(opus)]) })).toEqual({ state: 'refused', reason: 'exception-dropped' });
  expect(decideRoleModel(after, 'brain', target, { today: '2026-10-23', active: new Set([key]) })).toMatchObject({ state: 'eligible', basis: 'exception' });
  expect(eligibleRoleModels(after, 'brain', { today: '2026-10-23', active: new Set([key, roleModelKey(opus)]) }).filter(row => row.active).map(row => row.modelId)).toEqual(['claude-opus-5-5']);
  // An exception is always dated and time-boxed by the registry bound; it never grants a role the registry does not declare.
  expect(modelRoleRegistrySchema.safeParse({ ...overlay({}), exceptions: [{ ...qwen, expiresOn: undefined }] }).success).toBe(false);
  expect(modelRoleRegistrySchema.safeParse({ ...overlay({}), exceptions: [{ ...qwen, expiresOn: '2026-10-19' }] }).success).toBe(false);
  expect(modelRoleRegistrySchema.safeParse({ ...overlay({}), exceptions: [{ ...qwen, expiresOn: '2027-10-20' }] }).success).toBe(false);
  expect(() => mergeModelRoleRegistries(CORE_MODEL_ROLES, [overlay({ exceptions: [{ ...qwen, role: 'auditor' }] })])).toThrow(expect.objectContaining({ code: 'MODEL_ROLE_NOT_REGISTERED' }));
});

it('an overlay changes a Core row or exception only by compare-and-set; it never redefines a role or lets a worker tier hold a frontier role', () => {
  const sonnet = { channelId: 'anthropic-api', modelId: 'claude-sonnet-5-5', version: 2, tier: 'frontier', roles: ['brain'] };
  const denied = (extra: object) => expect(() => mergeModelRoleRegistries(CORE_MODEL_ROLES, [overlay(extra)])).toThrow(expect.objectContaining({ code: 'MODEL_ROLE_OVERRIDE_DENIED' }));
  denied({ models: [sonnet] });
  denied({ models: [{ ...sonnet, version: 3, override: { previousVersion: 2 } }] });
  denied({ models: [{ channelId: 'acme', modelId: 'acme-1', version: 2, tier: 'worker', roles: ['worker'], override: { previousVersion: 1 } }] });
  denied({ roles: [{ id: 'brain', minimumTier: 'worker' }] });
  const second = overlay({ revision: 'acme-2', exceptions: [{ ...qwen, version: 2 }] });
  expect(() => mergeModelRoleRegistries(CORE_MODEL_ROLES, [overlay({ exceptions: [qwen] }), second])).toThrow(expect.objectContaining({ code: 'MODEL_ROLE_OVERRIDE_DENIED' }));
  // The compare-and-set path is the only one that changes a Core row; it is visible as a revision tuple.
  const raised = mergeModelRoleRegistries(CORE_MODEL_ROLES, [overlay({ models: [{ ...sonnet, override: { previousVersion: 1 } }] })]);
  expect(raised.revision).toBe(JSON.stringify([CORE_MODEL_ROLES.revision, 'acme-1']));
  expect(decideRoleModel(raised, 'brain', sonnet, { today: '2026-10-23', active: new Set([roleModelKey(sonnet)]) })).toMatchObject({ state: 'eligible', basis: 'tier' });
  // Tier is checked against the role's minimum after the merge: a worker-tier row can never hold the Brain role.
  expect(() => mergeModelRoleRegistries(CORE_MODEL_ROLES, [overlay({ models: [{ channelId: 'acme', modelId: 'acme-1', version: 1, tier: 'worker', roles: ['brain'] }] })]))
    .toThrow(expect.objectContaining({ code: 'MODEL_ROLE_TIER_INVALID' }));
  expect(() => mergeModelRoleRegistries(CORE_MODEL_ROLES, [overlay({ models: [{ channelId: 'acme', modelId: 'acme-1', version: 1, tier: 'frontier', roles: ['auditor'] }] })]))
    .toThrow(expect.objectContaining({ code: 'MODEL_ROLE_NOT_REGISTERED' }));
  // A new role an Enterprise overlay adds is usable; the Core seed itself never claims an override.
  const added = mergeModelRoleRegistries(CORE_MODEL_ROLES, [overlay({ roles: [{ id: 'auditor', minimumTier: 'frontier' }],
    models: [{ channelId: 'acme', modelId: 'acme-1', version: 1, tier: 'frontier', roles: ['auditor'] }] })]);
  expect(eligibleRoleModels(added, 'auditor', { today: '2026-10-23', active: none }).map(row => row.modelId)).toEqual(['acme-1']);
  expect(() => mergeModelRoleRegistries({ ...CORE_MODEL_ROLES, models: [{ ...CORE_MODEL_ROLES.models[0]!, override: { previousVersion: 1 }, version: 2 }] }, []))
    .toThrow(expect.objectContaining({ code: 'MODEL_ROLE_OVERRIDE_DENIED' }));
  // Duplicate keys inside one document are refused before any merge; an empty object is not a section (never synthesized by defaults).
  expect(modelRoleRegistrySchema.safeParse({ ...overlay({}), models: [sonnet, sonnet] }).success).toBe(false);
  expect(modelRoleConfigSchema.safeParse({}).success).toBe(false);
  expect(modelRoleConfigSchema.parse({ schemaVersion: 1, overlays: [] })).toEqual({ schemaVersion: 1, overlays: [] });
});
