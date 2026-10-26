import { expect, it } from 'vitest';
import { createUninstallPlan, assertUninstallPlanCurrent, uninstallRegistry, uninstallOperationDescriptors, type UninstallInventory, type UninstallResource } from '#engine/core/installation/index.js';

it('pins one keep/purge inventory for every preview consumer and protects relocated, shared and renewable-session resources', () => {
  const resource = (resourceId: string, contribution: string, locator: string, extra: Partial<UninstallResource> = {}): UninstallResource => ({
    resourceId, contribution, locator, version: 'v1', owner: 'installation', ownership: 'exclusive', ownershipEvidence: 'a'.repeat(64),
    present: true, protected: false, capability: true, backup: 'covered', ...extra,
  });
  const inventory: UninstallInventory = { installation: { id: 'installation', root: '/fixture/data' },
    scopeSummary: ['company-b', 'company-a'], layoutRevision: 'l1', policyRevision: 'p1', inventoryRevision: 'i1',
    resources: [resource('scratch', 'scratch', '/fixture/data/scratch'), resource('ledger', 'durable', '/fixture/relocated/ledger.db'),
      resource('shared', 'worker-image', 'sha256:foreign', { ownership: 'shared' }),
      resource('session', 'durable', '/fixture/data/session', { backup: 'protected-session' }),
      resource('realm', 'bwrap-realm', '/fixture/data/realm', { ownership: 'unknown' })],
    protectedPaths: ['/fixture/protected'], deletionRoots: ['/fixture/data', '/fixture/relocated'], backupDestination: '/fixture/recovery/set',
    packageRemoval: { command: null, shared: true }, blockers: [],
  };
  const before = JSON.stringify(inventory);
  for (const purge of [false, true]) {
    const plan = createUninstallPlan({ schemaVersion: 1, purge }, inventory);
    const json = JSON.parse(JSON.stringify(plan));
    expect(json.planDigest).toBe(plan.planDigest); expect(plan.canApply).toBe(false);
    expect(plan.items.map(item => [item.resourceId, item.action])).toEqual([
      ['ledger', purge ? 'remove' : 'keep'], ['realm', 'keep'], ['scratch', 'remove'], ['session', 'keep'], ['shared', 'keep'],
    ]);
    if (purge) expect(plan.blockers).toContain('session:protected-session');
    expect(createUninstallPlan({ schemaVersion: 1, purge }, { ...inventory, resources: [...inventory.resources].reverse() })).toEqual(plan);
    expect(() => assertUninstallPlanCurrent(plan, createUninstallPlan({ schemaVersion: 1, purge }, { ...inventory, policyRevision: 'p2' })))
      .toThrow(expect.objectContaining({ code: 'UNINSTALL_PLAN_CHANGED' }));
  }
  expect(JSON.stringify(inventory)).toBe(before);
  for (const operation of uninstallOperationDescriptors()) expect(operation).toMatchObject({ surface: 'authority', approval: 'required', effectClass: 'irreversible', precondition: 'record-version' });
  const unresolvedService = createUninstallPlan({ schemaVersion: 1, purge: false }, { ...inventory,
    resources: [resource('service', 'service', 'fixture.service', { ownership: 'unknown' }), resource('scratch', 'scratch', '/fixture/data/scratch')] });
  expect(unresolvedService.items.find(item => item.resourceId === 'scratch')).toMatchObject({ action: 'blocked', reason: 'dependency-unresolved' });
  const overlap = createUninstallPlan({ schemaVersion: 1, purge: false }, { ...inventory,
    resources: [resource('cache', 'scratch', '/fixture/data/cache'), resource('audit', 'durable', '/fixture/data/cache/audit')] });
  expect(overlap.items.find(item => item.resourceId === 'cache')).toMatchObject({ action: 'blocked', reason: 'retained-overlap' });
  const unsafe = createUninstallPlan({ schemaVersion: 1, purge: true }, { ...inventory, backupDestination: '/fixture/relocated/backup' });
  expect(unsafe.blockers).toContain('backup-destination');
  expect(() => uninstallRegistry([{ id: 'scratch', owner: 'extension', kind: 'path', targetKind: 'extension-resource', disposable: true, operation: 'extension.remove', after: [] }])).toThrow();
  expect(() => uninstallRegistry([{ id: 'extension.resource', owner: 'extension', kind: 'path', targetKind: 'extension-resource', disposable: false, operation: 'extension.remove', after: ['extension.resource'] }])).toThrow();
});
