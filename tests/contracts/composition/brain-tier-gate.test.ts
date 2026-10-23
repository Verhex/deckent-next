import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planRun } from '../../../src/index.js';
import { inspectConfiguredRoleModels } from '#composition/core/run-planner/index.js';
import { clearConfigCache, resolveGlobalConfigReadPath } from '#platform/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';

// S2 (owner A2, A3, BRAIN1): the Brain model is checked against the tier/role registry where the planner takes it, before the budget read, the
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
    ['model-unknown', null],
    ['role-not-held', roles([{ channelId, modelId, version: 1, tier: 'frontier', roles: ['worker'] }])],
    ['exception-not-current', roles([], [{ id: 'interim', version: 1, role: 'brain', channelId, modelId, source: 'owner-a3', declaredOn: shift(-20), expiresOn: shift(-1) }])],
  ] as const)('refuses a Brain whose registry decision is %s before any budget read, count or model POST', async (reason, modelRoles) => {
    const f = await fixture({ modelRoles, tokenCount: { count: 10, max_model_len: 1000 } });
    const error = await planRun(f.project, command, f.options).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'BRAIN_TIER_REFUSED', params: { channelId, modelId, reason } });
    for (const locale of ['en', 'tr'] as const) {
      const message = (error as { localize(locale: string): { message: string } }).localize(locale).message;
      expect(message).toContain(modelId); expect(message).toContain(channelId);
    }
    expect(f.posts).toBe(0); expect(f.counterBodies).toHaveLength(0); expect(counts(f.path)).toEqual({ runs: 0, proposals: 0 });
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
