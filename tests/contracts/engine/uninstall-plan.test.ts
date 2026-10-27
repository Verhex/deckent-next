import { expect, it } from 'vitest';
import { createUninstallPlan, assertUninstallPlanCurrent, uninstallPlanDrift, uninstallRegistry, uninstallOperationDescriptors, type UninstallInventory, type UninstallResource } from '#engine/core/installation/index.js';
const resource = (resourceId: string, contribution: string, locator: string, extra: Partial<UninstallResource> = {}): UninstallResource => ({
  resourceId, contribution, locator, version: 'v1', owner: 'installation', ownership: 'exclusive', ownershipEvidence: 'a'.repeat(64),
  present: true, protected: false, capability: true, backup: 'covered', ...extra,
});
const idle = { running: [], parked: [], approvals: [], deliveries: [], uncertain: [], complete: true };
const stopped = { running: false, unit: null, unitDisable: 'none' as const, command: null };
const query = (tier: 'keep-data' | 'keep-work' | 'all', extra: { force?: boolean; disableUnit?: boolean } = {}) => ({ schemaVersion: 2, tier, force: false, disableUnit: false, ...extra });
const inventory: UninstallInventory = { installation: { id: 'installation', root: '/fixture/data' },
  scopeSummary: ['company-b', 'company-a'], layoutRevision: 'l1', policyRevision: 'p1', inventoryRevision: 'i1',
  resources: [resource('scratch', 'scratch', '/fixture/data/scratch'), resource('ledger', 'durable', '/fixture/relocated/ledger.db'),
    resource('shared', 'worker-image', 'sha256:foreign', { ownership: 'shared' }),
    resource('session', 'durable', '/fixture/data/session', { backup: 'protected-session' }),
    resource('realm', 'bwrap-realm', '/fixture/data/realm', { ownership: 'unknown' })],
  protectedPaths: ['/fixture/protected'], deletionRoots: ['/fixture/data', '/fixture/relocated'], backupDestination: '/fixture/recovery/set',
  packageRemoval: { command: null, shared: true }, blockers: [], dataBlockers: [], work: idle, service: stopped, managedScopes: [],
};

it('pins one keep/purge inventory for every preview consumer and protects relocated, shared and renewable-session resources', () => {
  const before = JSON.stringify(inventory);
  for (const tier of ['keep-data', 'all'] as const) {
    const plan = createUninstallPlan(query(tier), inventory), purge = tier === 'all';
    const json = JSON.parse(JSON.stringify(plan));
    expect(json.planDigest).toBe(plan.planDigest); expect(plan.canApply).toBe(false); expect(plan.purge).toBe(purge);
    expect(plan.items.map(item => [item.resourceId, item.action])).toEqual([
      ['ledger', purge ? 'remove' : 'keep'], ['realm', 'keep'], ['scratch', 'remove'], ['session', 'keep'], ['shared', 'keep'],
    ]);
    if (purge) expect(plan.blockers).toContain('session:protected-session');
    expect(createUninstallPlan(query(tier), { ...inventory, resources: [...inventory.resources].reverse() })).toEqual(plan);
    expect(() => assertUninstallPlanCurrent(plan, createUninstallPlan(query(tier), { ...inventory, policyRevision: 'p2' })))
      .toThrow(expect.objectContaining({ code: 'UNINSTALL_PLAN_CHANGED' }));
  }
  expect(JSON.stringify(inventory)).toBe(before);
  for (const operation of uninstallOperationDescriptors()) expect(operation).toMatchObject({ surface: 'authority', approval: 'required', effectClass: 'irreversible', precondition: 'record-version' });
  const unresolvedService = createUninstallPlan(query('keep-data'), { ...inventory,
    resources: [resource('service', 'service', 'fixture.service', { ownership: 'unknown' }), resource('scratch', 'scratch', '/fixture/data/scratch')] });
  expect(unresolvedService.items.find(item => item.resourceId === 'scratch')).toMatchObject({ action: 'blocked', reason: 'dependency-unresolved' });
  const overlap = createUninstallPlan(query('keep-data'), { ...inventory,
    resources: [resource('cache', 'scratch', '/fixture/data/cache'), resource('audit', 'durable', '/fixture/data/cache/audit')] });
  expect(overlap.items.find(item => item.resourceId === 'cache')).toMatchObject({ action: 'blocked', reason: 'retained-overlap' });
  const unsafe = createUninstallPlan(query('all'), { ...inventory, backupDestination: '/fixture/relocated/backup' });
  expect(unsafe.blockers).toContain('backup-destination');
  expect(() => uninstallRegistry([{ id: 'scratch', owner: 'extension', kind: 'path', targetKind: 'extension-resource', disposable: true, operation: 'extension.remove', after: [] }])).toThrow();
  expect(() => uninstallRegistry([{ id: 'extension.resource', owner: 'extension', kind: 'path', targetKind: 'extension-resource', disposable: false, operation: 'extension.remove', after: ['extension.resource'] }])).toThrow();
});

it('checks work and the service before any card: nothing to do asks nothing, a running service is a stop step, force never closes unknown results', () => {
  // Owner 2026-10-27: nothing removed or stopped is no confirmation; a running service alone is an action (stop), never "work active".
  const empty = { ...inventory, resources: [resource('scratch', 'scratch', '/fixture/data/scratch', { present: false })] };
  expect(createUninstallPlan(query('keep-data'), empty)).toMatchObject({ nothingToRemove: true, blockers: [] });
  expect(createUninstallPlan(query('keep-data'), { ...empty, service: { ...stopped, running: true } })).toMatchObject({ nothingToRemove: false, blockers: [], steps: { stopService: true } });
  // A unit that restarts the service needs its own consent (K4); without it the plan stops before the card with the command.
  const unit = { running: true, unit: 'deckent-fixture.service', unitDisable: 'eligible' as const, command: 'systemctl --user disable --now deckent-fixture.service' };
  expect(createUninstallPlan(query('keep-data'), { ...empty, service: unit }).blockers).toEqual(['service-managed']);
  expect(createUninstallPlan(query('keep-data', { disableUnit: true }), { ...empty, service: unit })).toMatchObject({ blockers: [], steps: { disableUnit: true } });
  expect(createUninstallPlan(query('keep-data', { disableUnit: true }), { ...empty, service: { ...unit, unitDisable: 'command-only' } }).blockers).toEqual(['service-managed']);
  const effect = { kind: 'effect' as const, scopeId: 'company-a', id: 'erp-invoice', target: 'erp/invoice-1' };
  const busy = { ...inventory, resources: inventory.resources.slice(0, 2), work: { ...idle, running: [{ scopeId: 'company-a', id: 'run-1', revision: 3 }], approvals: [{ scopeId: 'company-a', id: 'approval-1', revision: 0 }], uncertain: [effect] } };
  expect(createUninstallPlan(query('keep-data'), busy).blockers).toEqual(['work-active']);
  expect(createUninstallPlan(query('all'), busy).blockers).toEqual(expect.arrayContaining(['work-active', 'work-pending', 'uncertain-effects']));
  const forced = createUninstallPlan(query('all', { force: true }), busy);
  expect(forced.blockers).toEqual([]); expect(forced.steps).toMatchObject({ cancelRuns: [{ id: 'run-1' }], rejectApprovals: [{ id: 'approval-1' }] });
  // K3: under company control an unknown result keeps data deletion closed, force included; keeping data stays open.
  expect(createUninstallPlan(query('all', { force: true }), { ...busy, managedScopes: ['company-a'] }).blockers).toEqual(['uncertain-managed']);
  expect(createUninstallPlan(query('keep-data', { force: true }), { ...busy, managedScopes: ['company-a'] }).blockers).toEqual([]);
  expect(createUninstallPlan(query('keep-data'), { ...inventory, work: { ...idle, complete: false } }).blockers).toEqual(['work-unverified']);
  // E(D0): after force only work the confirmation named may remain unknown; a new unknown result or work still running is drift.
  const after = (work: Partial<typeof idle>) => createUninstallPlan(query('all', { force: true }), { ...busy, work: { ...idle, ...work } });
  expect(uninstallPlanDrift(forced, after({ uncertain: [effect] }))).toEqual([]);
  expect(uninstallPlanDrift(forced, after({ uncertain: [effect, { ...effect, id: 'erp-credit-note' }] }))).toEqual(['uncertain:effect:erp-credit-note']);
  expect(uninstallPlanDrift(forced, after({ running: [{ scopeId: 'company-a', id: 'run-1', revision: 4 }] }))).toEqual(['running:run-1']);
  expect(forced.tiers).toMatchObject({ 'keep-data': { removes: 1, blocker: null }, all: { removes: 2 } });
});
