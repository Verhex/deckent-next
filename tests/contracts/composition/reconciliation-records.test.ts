import { afterEach, expect, it, vi } from 'vitest';
import { reconcileConfiguredAttempt } from '#composition/core/runs/index.js';
import { custodyPrincipal, custodyProfile } from '../support/custody.js';

const fixture = vi.hoisted(() => ({ run: null as unknown, attempt: null as unknown,
  authorize: vi.fn(), close: vi.fn(), integrity: vi.fn(), observe: vi.fn(), loadRun: vi.fn(), loadAttempt: vi.fn() }));
const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
vi.mock('#composition/core/scoped-request/index.js', () => ({
  async loadConfiguredScopeContext() { return { config: { inspection: { policyMaxBytes: 65536 },
    storage: { sqlite: {} }, runRuntime: { parking: { timeoutMs: 1000 } }, artifacts: { maxBytes: 65536 }, approvals: { keyFile: 'key' } },
    layout: {}, document: { revision: 'policy' }, principal: custodyPrincipal, path: async () => 'fixture-ledger' }; },
}));
vi.mock('#composition/core/policy/index.js', () => ({ createLayoutPolicySource: () => ({}) }));
vi.mock('#platform/index.js', async importOriginal => ({ ...await importOriginal<typeof import('#platform/index.js')>(),
  inspectProductDirectory: async () => 'fixture-artifacts' }));
vi.mock('#engine/index.js', async importOriginal => ({ ...await importOriginal<typeof import('#engine/index.js')>(),
  DispatchPolicyAuthorization: class { authorizeIdentity = fixture.authorize; } }));
vi.mock('#adapters/index.js', async importOriginal => ({ ...await importOriginal<typeof import('#adapters/index.js')>(),
  openLocalIntegrityAuthority: fixture.integrity,
  recordedDockerSupervisor: () => ({ observe: fixture.observe }),
  FileArtifactStore: class {},
  async openSqliteAttemptStore() { return {
    async loadBoundDispatch() { return { schemaVersion: 2, owner: 'owner', profile: custodyProfile,
      request: { protocolVersion: 1, identity, workspace: 'fixture-workspace', argv: ['fixture'] },
      launch: 'granted', terminal: null }; },
    async loadRunReceipt() { return { commandId: 'fence' }; },
    async loadRun() { fixture.loadRun(); return fixture.run; },
    async load() { fixture.loadAttempt(); return fixture.attempt; }, close: fixture.close,
  }; },
}));
afterEach(() => { vi.clearAllMocks(); });
it.each(['run', 'attempt'] as const)('refuses missing %s after fence lookup before recovery/secret access', async missing => {
  fixture.run = missing === 'run' ? null : { revision: 2 };
  fixture.attempt = missing === 'attempt' ? null : { revision: 1 };
  // Reconcile authority is explicitly granted; the same recorded token takes the missing-row path.
  await expect(reconcileConfiguredAttempt('fixture-project', identity)).rejects.toMatchObject({ code: 'DISPATCH_NOT_ADMITTED' });
  expect(fixture.authorize).toHaveBeenCalledExactlyOnceWith('reconcile', identity, custodyPrincipal);
  expect(fixture.loadRun).toHaveBeenCalledOnce(); expect(fixture.loadAttempt).toHaveBeenCalledOnce();
  expect(fixture.integrity).not.toHaveBeenCalled(); expect(fixture.observe).not.toHaveBeenCalled();
  expect(fixture.close).toHaveBeenCalledOnce();
});
