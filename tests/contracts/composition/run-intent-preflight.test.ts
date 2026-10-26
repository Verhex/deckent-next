import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { SqliteRunProposals } from '#adapters/core/run-proposal-store/index.js';
import { migrateLedger } from '#adapters/core/sqlite-ledger/index.js';
import { BrainPlanApplication } from '#engine/index.js';
import { planConfiguredRun, planRuntimeRun } from '#composition/core/run-planner/index.js';
const state = vi.hoisted(() => ({ store: null as unknown, principal: { id: 'owner', issuer: 'test', subject: 'owner', assurance: 'os-user', scopeIds: ['s'] } }));
vi.mock('#adapters/index.js', async original => ({ ...await original<object>(), openSqliteRunProposalStore: async () => Object.assign(state.store as object, { close() {} }) }));
vi.mock('#composition/core/scoped-request/index.js', async original => ({ ...await original<object>(), loadConfiguredScopeContext: async () => ({ principal: state.principal,
  config: { storage: { sqlite: {} }, inspection: { policyMaxBytes: 4096 } }, layout: {}, path: async () => 'unused' }) }));
vi.mock('#composition/core/policy/index.js', async original => ({ ...await original<object>(), createLayoutPolicySource: () => ({ load: async () => ({ schemaVersion: 1, revision: 'p', restrictions: [],
  grants: [{ id: 'inspect', effect: 'allow', actions: ['inspect'], principals: 'all', scopes: ['s'], resource: { kind: 'run', ids: 'all' } }] }) }) }));
vi.mock('../../../src/composition/core/run-planner/internal/intent-facts.js', () => ({ configuredWorkerSetupFact: async () => ({ id: 'fact', revision: 1, basis: 'a'.repeat(64), ready: false,
  reason: 'WORKER_SETUP_PENDING', params: { phase: 'waiting-docker' } }) }));
it('U4-1p: normal SDK and runtime entrypoints park/replay before any Brain planning call', async () => {
  const db = new DatabaseSync(':memory:'); migrateLedger(db, 'allow'); state.store = new SqliteRunProposals(db);
  const planning = vi.spyOn(BrainPlanApplication.prototype, 'plan').mockRejectedValue(new Error('must not plan'));
  const command = { schemaVersion: 1 as const, scopeId: 's', commandId: 'request', intent: 'Inspect the purchase process' };
  try {
    const parked = await planConfiguredRun('/unused', command), replay = await planRuntimeRun('/unused', command);
    expect(parked).toMatchObject({ schemaVersion: 2, kind: 'intent', intent: { status: 'parked', fact: { reason: 'WORKER_SETUP_PENDING' } }, run: null });
    expect(replay).toEqual(parked); expect(planning).not.toHaveBeenCalled();
    expect(db.prepare('SELECT count(*) AS n FROM runs').get()?.n).toBe(0);
    await expect(planConfiguredRun('/unused', { ...command, intent: 'different' })).rejects.toMatchObject({ code: 'RUN_PROPOSAL_COMMAND_CONFLICT' });
  } finally { planning.mockRestore(); db.close(); }
});
