import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planRun } from '../../../src/index.js';
import { inspectConfiguredRoleModels } from '#composition/core/run-planner/index.js';
import { clearConfigCache, resolveGlobalConfigReadPath } from '#platform/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { brainOfferCommand, configCommand } from '#surfaces/core/config/index.js';
import { brainProposalCardLines, brainProposalLines } from '#surfaces/core/run-planning/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';

// S2 (owner A2, A3; owner 2026-11-06 replaces BRAIN1): with a written `model_roles` section the Brain model is checked against the tier/role registry where the planner takes it, before the budget read, the
// token count or the model POST. A refusal is typed and names the model; no other model is ever chosen in its place.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks(); });
const command = { schemaVersion: 1 as const, scopeId: 's', commandId: 'brain-tier', intent: 'Prepare a purchase and durable business readback' };
const channelId = 'test-operator', modelId = 'vendor/model';
const roles = (models: object[], exceptions: object[] = []) => ({ schemaVersion: 1, overlays: [{ schemaVersion: 1, revision: 'fixture-roles', roles: [], models, exceptions }] });
const shift = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
async function fixture(options: Parameters<typeof brainProviderFixture>[0]) { const f = await brainProviderFixture(options); cleanups.push(f.close); return f; }
function counts(path: string) { const db = new DatabaseSync(path, { readOnly: true }); try {
  return { runs: Number(db.prepare('SELECT count(*) AS n FROM runs').get()!.n), proposals: Number(db.prepare('SELECT count(*) AS n FROM run_proposals').get()!.n) };
} finally { db.close(); } }
describe.skipIf(process.platform === 'win32')('Brain tier gate in the planner composition', () => {
  it.each([
    ['tier', roles([{ channelId, modelId, version: 1, tier: 'worker', roles: ['worker'] }])],
    ['model-unknown', roles([])],
    ['role-not-held', roles([{ channelId, modelId, version: 1, tier: 'frontier', roles: ['worker'] }])],
    ['exception-not-current', roles([], [{ id: 'interim', version: 1, role: 'brain', channelId, modelId, source: 'owner-a3', declaredOn: shift(-20), expiresOn: shift(-1) }])],
  ] as const)('refuses a Brain whose registry decision is %s before any budget read, count or model POST', async (reason, modelRoles) => {
    const f = await fixture({ modelRoles, tokenCount: { count: 10, max_model_len: 1000 } });
    const error = await planRun(f.project, command, f.options).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'BRAIN_TIER_REFUSED', params: { channelId, modelId, reason } });
    for (const locale of ['en', 'tr'] as const) {
      const message = (error as { localize(locale: string): { message: string } }).localize(locale).message;
      expect(message).toContain(modelId); expect(message).toContain(channelId); expect(message).toContain('/model'); // R9b: the next step is named
    }
    expect(f.posts).toBe(0); expect(f.counterBodies).toHaveLength(0); expect(counts(f.path)).toEqual({ runs: 0, proposals: 0 });
  });
  it('owner 2026-11-06: with only the built-in role table or a person-owned role overlay a model below the recommended class plans with a note; an inactive one is still refused', async () => {
    const f = await fixture({ modelRoles: null });
    const result = await planRun(f.project, command, f.options);
    expect(result).toMatchObject({ brainBelowRecommended: true, proposal: { proposal: { source: { kind: 'model' } } } });
    expect(brainProposalLines(result, 'en')).toContain('A model below the recommended class made this plan; for a stronger model, use /model.');
    expect(brainProposalCardLines(result, 'tr')).toContain('Bu plan önerilen sınıfın altındaki bir modelle yapıldı; daha güçlü bir model için /model.');
    expect(f.posts).toBe(1);
    const inactive = await fixture({ model: 'inactive', modelRoles: null });
    await expect(planRun(inactive.project, command, inactive.options)).rejects.toMatchObject({ code: 'MODEL_NOT_ACTIVATED' });
    expect(inactive.posts).toBe(0);
    // Lead 2026-11-06: the person's own `models roles assign` overlay (here a worker row for this model) is not a binding Brain policy.
    const owned = await fixture({ modelRoles: { schemaVersion: 1, overlays: [{ schemaVersion: 1, revision: 'installation-roles:1', roles: [], models: [{ channelId, modelId, version: 1, tier: 'worker', roles: ['worker'] }], exceptions: [] }] } });
    expect(await planRun(owned.project, command, owned.options)).toMatchObject({ brainBelowRecommended: true });
  });
  it('plans with a dated exception while it is current, and keeps the inactive-model refusal for an eligible Brain', async () => {
    const exception = { id: 'interim', version: 1, role: 'brain', channelId, modelId, source: 'owner-a3', declaredOn: shift(-1), expiresOn: shift(10) };
    const f = await fixture({ modelRoles: roles([], [exception]) });
    expect((await planRun(f.project, command, f.options)).proposal.proposal.source).toMatchObject({ kind: 'model' });
    expect(f.posts).toBe(1);
    const read = await inspectConfiguredRoleModels(f.project, 's', 'brain', f.options);
    expect(read.models.filter(row => row.channelId === channelId)).toEqual([{ channelId, modelId, tier: null, basis: 'exception', exceptionId: 'interim', expiresOn: exception.expiresOn, active: true }]);
    expect(read.models.filter(row => row.channelId !== channelId).every(row => row.tier === 'frontier' && !row.active)).toBe(true);
    const inactive = await fixture({ model: 'inactive' });
    await expect(planRun(inactive.project, command, inactive.options)).rejects.toMatchObject({ code: 'MODEL_NOT_ACTIVATED' });
    expect(inactive.posts).toBe(0);
    await expect(inspectConfiguredRoleModels(f.project, 's', 'auditor', f.options)).rejects.toMatchObject({ code: 'MODEL_ROLE_NOT_REGISTERED' });
  });
  it('R9b: plans with the caller\'s model, else the person\'s Brain model set by `deckent config set` (project over user), else the chat model', async () => {
    const f = await fixture({});
    const policyPath = join(f.data, 'policy.json'), policy = JSON.parse(await readFile(policyPath, 'utf8')) as { grants: { id: string; resource: unknown; actions: string[]; scopes: unknown }[] };
    policy.grants.push({ ...policy.grants[0]!, id: 'config', actions: ['write'], scopes: 'all', resource: { kind: 'config', ids: 'all' } }); // the user layer needs an all-scope grant
    await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 }); clearConfigCache();
    const set = (model: string, ...layer: string[]) => configCommand(['config', 'set', 'brain_planner.reference', JSON.stringify({ ...f.reference, modelId: model }), '--scope', 's', ...layer],
      { root: f.project, env: f.options.env, configApplication: createConfiguredConfigApplication, resolveConfigPrincipal: resolveConfiguredConfigPrincipal, stdout: { write: () => true } } as never);
    // An undeclared reference names which model the planner took, before any count or POST.
    const took = (commandId: string, reference?: object) => planRun(f.project, { ...command, commandId, ...(reference ? { reference } : {}) }, f.options).then(() => 'planned', (error: { code: string; params?: { model?: string } }) => error.params?.model ?? error.code);
    await set('user-brain', '--global');
    expect(await took('brain-user')).toBe('test-operator/user-brain@1');
    await set('project-brain');
    expect(await took('brain-project')).toBe('test-operator/project-brain@1');
    expect(await took('brain-pinned', { ...f.reference, modelId: 'pinned' })).toBe('test-operator/pinned@1');
    expect(f.posts).toBe(0);
    await set(f.reference.modelId);
    expect(await took('brain-own')).toBe('planned'); expect(f.posts).toBe(1);
    // Owner 2026-11-06 ("can be Brain", default on): `models catalog brain --off` switches the model off through the same governed writer; it then never
    // plans (typed, before any count or POST) and --on restores it.
    const out: string[] = [], toggle = (model: string, ...flags: string[]) => brainOfferCommand(['models', 'catalog', 'brain', '--channel', channelId, '--model', model, ...flags],
      { root: f.project, env: f.options.env, configApplication: createConfiguredConfigApplication, resolveConfigPrincipal: resolveConfiguredConfigPrincipal, stdout: { write: (text: string) => out.push(text) } } as never);
    await expect(toggle(modelId, '--off', '--on')).rejects.toMatchObject({ code: 'CLI_USAGE' });
    await expect(toggle('not-declared', '--off')).rejects.toMatchObject({ code: 'MODEL_CATALOG_NOT_FOUND' });
    await toggle(modelId, '--off'); expect(out.join('')).toContain(`${modelId} is no longer offered as Brain`);
    const error = await planRun(f.project, { ...command, commandId: 'brain-off' }, f.options).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'BRAIN_TIER_REFUSED', params: { channelId, modelId, reason: 'switched-off' } });
    for (const locale of ['en', 'tr'] as const) expect((error as { localize(locale: string): { message: string } }).localize(locale).message).toContain(`--model ${modelId} --on`);
    expect(f.posts).toBe(1);
    await toggle(modelId, '--on'); expect(await took('brain-on')).toBe('planned'); expect(f.posts).toBe(2);
  });
  it('refuses an overlay that changes a Core row without compare-and-set, and a project layer that widens Brain eligibility', async () => {
    const core = roles([{ channelId: 'anthropic-api', modelId: 'claude-sonnet-5-5', version: 2, tier: 'frontier', roles: ['brain'] }]);
    const f = await fixture({});
    const globalPath = await resolveGlobalConfigReadPath(f.options.env);
    await writeFile(globalPath, JSON.stringify({ model_roles: core })); clearConfigCache();
    await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'CONFIG_VALIDATION', issues: [{ path: 'model_roles', reason: 'MODEL_ROLE_OVERRIDE_DENIED' }] });
    await writeFile(globalPath, JSON.stringify({})); clearConfigCache();
    await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ ...f.config, model_roles: roles([{ channelId, modelId, version: 1, tier: 'frontier', roles: ['brain'] }]) }));
    clearConfigCache();
    await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'CONFIG_VALIDATION', issues: [{ path: 'model_roles', reason: 'MODEL_ROLE_LAYER_INVALID' }] });
    expect(f.posts).toBe(0); expect(counts(f.path)).toEqual({ runs: 0, proposals: 0 });
  });
});
