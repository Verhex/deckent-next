import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { UninstallApplication, authorizeUninstall, createUninstallPlan, uninstallOperationDescriptors, EffectApplication, OperationPolicyAuthorization,
  EffectTargetError, type UninstallAdmission, type UninstallApplicationPorts, type UninstallInventory, type UninstallPlan, type UninstallResult } from '#engine/index.js';
import { FileEffectStore } from '#adapters/core/file-effect-store/index.js';
import { InstallationCacheRemovalTarget } from '#adapters/core/installation-removal/index.js';
import { createHmacIntegrity, ErrorRegistry, SystemTrustedClock } from '#platform/index.js';
import { evaluatePolicy, type VerifiedPrincipal } from '#domain/index.js';

it('gates the exact uninstall behind the person and durable owners, resumes generic unknown once and keeps data on purge refusal', async () => {
  if (process.platform !== 'linux') {
    const app = new UninstallApplication({ channel: undefined, witness: { attest: async () => true }, principal: async () => ({ id: 'person', issuer: 'fixture', subject: 'person', assurance: 'os-user', scopeIds: ['s'] }),
      authorize: async () => {}, inventory: async () => { throw new Error('must not inspect'); }, retainedPlan: async () => { throw new Error('must not inspect'); } });
    await expect(app.apply({ schemaVersion: 2, commandId: 'remove', planDigest: 'a'.repeat(64) }, { confirm: async () => true })).rejects.toMatchObject({ code: 'UNINSTALL_UNSUPPORTED' });
    console.info('verify-not-run: uninstall file-store positive requires Linux custody'); return;
  }
  const root = await mkdtemp(join(tmpdir(), 'deckent-uninstall-app-'));
  try {
    const cache = join(root, 'cache'), ledger = join(root, 'ledger');
    await mkdir(cache, { mode: 0o700 }); await writeFile(join(cache, 'disposable'), 'cache', { mode: 0o600 }); await writeFile(ledger, 'KEEP', { mode: 0o600 });
    const cacheTarget = new InstallationCacheRemovalTarget('fixture', [{ resourceId: 'cache', path: cache, ownershipDigest: 'a'.repeat(64), members: ['^[a-z]+$'] }], [ledger],
      { maxEntries: 10, maxDepth: 2 }, work => work());
    const version = (await cacheTarget.observe({ kind: 'installation-cache', id: 'cache' })).version;
    let principal: VerifiedPrincipal = { id: 'person', issuer: 'fixture', subject: 'person', assurance: 'os-user', scopeIds: ['s'] };
    let channel: 'mcp' | undefined, witness = true, approved = false, unknown = false, sends = 0, backupCalls = 0, changed = false, covered = true;
    let loseReply = true, changedResource: string | null = null;
    const finished: UninstallResult[] = [];
    const integrity = createHmacIntegrity('fixture', new Uint8Array(32).fill(3)), store = new FileEffectStore(join(root, 'recovery'), integrity, { maxBytes: 65536, maxRecords: 10 });
    await store.initialize();
    const policy = { schemaVersion: 1, revision: 'p1', restrictions: [], grants: [{ id: 'owner', effect: 'allow', principals: 'all', actions: 'all', scopes: 'all', resource: { kind: 'operation', ids: 'all' } }] };
    const clock = new SystemTrustedClock(), now = clock.sample().wallMs;
    const sessions = { verifySession: async () => ({ principal, session: { schemaVersion: 1, sessionId: 'session', authorityRef: 'fixture', kind: 'os-user',
      principalRef: { id: 'person', issuer: 'fixture', subject: 'person' }, scopeIds: ['s'], authenticatedAt: now, expiresAt: now + 60000 } }), isSessionActive: async () => true, revoke: async () => {} };
    const descriptor = uninstallOperationDescriptors().find(entry => entry.operation.id === 'installation.remove-cache')!;
    const effects = () => new EffectApplication({ resolve: async () => descriptor }, { resolve: () => ({ ...cacheTarget, kind: cacheTarget.kind,
      identity: () => cacheTarget.identity(), observe: target => cacheTarget.observe(target),
      async apply(request) {
        sends++; const result = await cacheTarget.apply(request);
        if (loseReply) { unknown = true; throw new EffectTargetError('EFFECT_TARGET_UNKNOWN'); }
        return result;
      },
      lookup: async (target, key) => unknown ? null : cacheTarget.lookup(target, key),
    }) }, store, { admit: async () => { if (!approved) throw new Error('approval missing'); return { approval: { approvalId: 'plan-card', actionDigest: 'd'.repeat(64) } }; } },
    sessions, new OperationPolicyAuthorization({ load: async () => policy }), clock, { surface: 'authority', producer: { kind: 'principal' } });
    const inventory: UninstallInventory = { installation: { id: 'fixture-installation', root }, scopeSummary: ['s'],
      layoutRevision: 'l1', policyRevision: 'p1', inventoryRevision: 'i1', resources: [{ resourceId: 'cache', contribution: 'scratch', locator: cache,
        version, owner: 'fixture-installation', ownership: 'exclusive', ownershipEvidence: 'a'.repeat(64), present: true, protected: false, capability: true, backup: 'covered' }],
      blockers: [], protectedPaths: [ledger], deletionRoots: [root], backupDestination: join(root, 'backup'), packageRemoval: { command: null, shared: true },
      dataBlockers: [], work: { running: [], parked: [], approvals: [], deliveries: [], uncertain: [], complete: true }, service: { running: false, unit: null, unitDisable: 'none', command: null }, managedScopes: [] };
    let retained: UninstallPlan | null = null, observed = inventory;
    const ports = (): UninstallApplicationPorts => ({ channel, witness: { attest: async () => witness }, principal: async () => principal,
      authorize: async () => { if (principal.subject === 'denied') throw new Error('denied'); }, inventory: async () => observed, retainedPlan: async () => retained,
      withAdmission: async (_plan, _id, work) => work({ scopeId: 's', recoveryLocation: join(root, 'recovery'), effects: effects(),
        revalidate: async item => { if (changed || item?.resourceId === changedResource) throw Object.assign(new Error('changed'), { code: 'UNINSTALL_PLAN_CHANGED' }); },
        prepareBackup: async () => { backupCalls++; if (!covered) throw Object.assign(new Error('coverage'), { code: 'UNINSTALL_BACKUP_COVERAGE' }); },
        approvePlan: async () => { approved = true; }, finish: async result => { finished.push(result); },
      } satisfies UninstallAdmission) });
    let app = new UninstallApplication(ports()); const plan = await app.preview({ schemaVersion: 2, tier: 'keep-data', force: false, disableUnit: false }); retained = plan;
    const command = { schemaVersion: 2, commandId: 'uninstall', planDigest: plan.planDigest };
    // Approve the uninstall card, then assert these authority failures caused no target effect (no safe-command substitution).
    const interaction = { confirm: async () => true };
    for (const identity of [{ ...principal, issuer: 'fixture/mcp' }, { ...principal, assurance: 'workload-verified' as const }]) {
      principal = identity; await expect(new UninstallApplication(ports()).apply(command, interaction)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    }
    principal = { id: 'person', issuer: 'fixture', subject: 'person', assurance: 'os-user', scopeIds: ['s'] };
    channel = 'mcp'; await expect(new UninstallApplication(ports()).apply(command, interaction)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' }); channel = undefined;
    witness = false; await expect(new UninstallApplication(ports()).apply(command, interaction)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' }); witness = true;
    principal = { ...principal, subject: 'denied' }; await expect(app.apply(command, interaction)).rejects.toThrow('denied'); principal = { ...principal, subject: 'person' };
    await expect(app.apply(command, { ...interaction, confirm: async () => { witness = false; return true; } })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' }); witness = true;
    await expect(app.apply({ ...command, witnessed: true }, interaction)).rejects.toMatchObject({ code: 'UNINSTALL_INVALID' });
    await expect(new UninstallApplication({ ...ports(), withAdmission: undefined } as unknown as UninstallApplicationPorts).apply(command, interaction)).rejects.toMatchObject({ code: 'UNINSTALL_UNSUPPORTED' });
    changed = true; await expect(app.apply(command, interaction)).rejects.toMatchObject({ code: 'UNINSTALL_PLAN_CHANGED' }); changed = false;
    expect((await app.apply(command, { ...interaction, confirm: async () => false })).status).toBe('cancelled');
    // Separate configured SDK calls construct separate applications: the current digest must still resolve.
    const fresh = new UninstallApplication({ ...ports(), retainedPlan: async () => null });
    expect((await fresh.apply(command, { ...interaction, confirm: async () => false })).status).toBe('cancelled');
    const drifted = new UninstallApplication({ ...ports(), retainedPlan: async () => null,
      inventory: async () => ({ ...inventory, policyRevision: 'p2' }) });
    await expect(drifted.apply(command, interaction)).rejects.toMatchObject({ code: 'UNINSTALL_PLAN_CHANGED' });
    expect(sends).toBe(0); expect(await readFile(ledger, 'utf8')).toBe('KEEP'); expect(await lstat(cache)).toBeTruthy();
    const first = await app.apply(command, interaction); expect(first.status).toBe('unknown'); expect(sends).toBe(1);
    app = new UninstallApplication(ports()); expect((await app.apply(command, interaction)).status).toBe('unknown'); expect(sends).toBe(1);
    unknown = false; expect((await new UninstallApplication(ports()).apply(command, interaction)).status).toBe('completed'); expect(sends).toBe(1);
    expect((await new UninstallApplication(ports()).apply({ ...command, commandId: 'another-cli-invocation' }, interaction)).status).toBe('noop'); expect(sends).toBe(1);
    expect(finished.at(-1)?.status).toBe('noop');
    // Purge cancellation and backup failure run against a fresh data resource, before its generic effect may be claimed.
    await mkdir(cache, { mode: 0o700 }); await writeFile(join(cache, 'retained'), 'DATA', { mode: 0o600 });
    // K7: a tier that deletes data (here an archived file group) backs it up first; caches alone need no backup.
    const purgeInventory = { ...inventory, backupDestination: join(root, '..', 'external-backup'), resources: [{ ...inventory.resources[0]!, contribution: 'conversation', version: (await cacheTarget.observe({ kind: cacheTarget.kind, id: 'cache' })).version }] };
    observed = purgeInventory; retained = createUninstallPlan({ schemaVersion: 2, tier: 'all', force: false, disableUnit: false }, purgeInventory);
    const purgeCommand = { ...command, planDigest: retained.planDigest };
    covered = false; await expect(new UninstallApplication(ports()).apply(purgeCommand, interaction)).rejects.toMatchObject({ code: 'UNINSTALL_BACKUP_COVERAGE' });
    // K7: the one card precedes the backup; an unverifiable backup deletes nothing, a cancelled card creates none.
    covered = true; expect((await new UninstallApplication(ports()).apply(purgeCommand, { confirm: async () => false })).status).toBe('cancelled');
    expect(await readFile(join(cache, 'retained'), 'utf8')).toBe('DATA'); expect(await readFile(ledger, 'utf8')).toBe('KEEP'); expect(sends).toBe(1); expect(backupCalls).toBe(1);
    expect(evaluatePolicy({ ...policy, grants: [{ ...policy.grants[0], resource: { kind: 'installation', ids: 'all' } }] }, { principal: { ...principal, issuer: 'fixture/mcp' },
      scopeId: 's', action: 'uninstall', resource: { kind: 'installation', id: 'fixture-installation' } }).decision).toBe('deny');
    const generic = new EffectApplication({ resolve: async () => descriptor }, { resolve: () => cacheTarget }, store, { admit: async () => { throw new Error('must not reach broker'); } },
      sessions, new OperationPolicyAuthorization({ load: async () => policy }), clock, { producer: { kind: 'principal' } });
    const key = createHash('sha256').update(JSON.stringify([plan.installation.id, plan.planDigest, 'cache'])).digest('hex');
    const record = await store.loadEffect('s', key); expect(record?.state).toBe('settled');
    await expect(generic.execute(record!.intent.command)).rejects.toMatchObject({ code: 'OPERATION_SURFACE_RESTRICTED' }); expect(sends).toBe(1);
    // A fresh policy/ownership refusal after one effect must return its durable partial result.
    const current = { ...inventory.resources[0]!, version: (await cacheTarget.observe({ kind: cacheTarget.kind, id: 'cache' })).version };
    observed = { ...inventory, resources: [current, { ...current, resourceId: 'second', locator: join(root, 'second-cache') }] };
    retained = createUninstallPlan({ schemaVersion: 2, tier: 'keep-data', force: false, disableUnit: false }, observed);
    loseReply = false; changedResource = 'second';
    const partial = await new UninstallApplication(ports()).apply({ ...command, planDigest: retained.planDigest }, interaction);
    expect(partial).toMatchObject({ status: 'partial', failureCode: 'UNINSTALL_PLAN_CHANGED',
      items: [{ resourceId: 'cache', state: 'settled' }, { resourceId: 'second', state: null }] });
    expect(sends).toBe(2); expect(await readFile(ledger, 'utf8')).toBe('KEEP');
  } finally { await rm(root, { recursive: true, force: true }); }
});


it('requires installation-wide policy and honors scope-specific deny, approval and the non-delegable AI floor', () => {
  const principal: VerifiedPrincipal = { id: 'person', issuer: 'fixture', subject: 'person', assurance: 'os-user', scopeIds: ['s', 's2'] };
  const grant = { id: 'owner', effect: 'allow', principals: 'all', actions: ['inspect', 'uninstall'], scopes: 'all', resource: { kind: 'installation', ids: ['installation'] } };
  const document = { schemaVersion: 1, revision: 'p1', grants: [grant], restrictions: [] };
  expect(authorizeUninstall(document, principal, 'installation', ['s', 's2'], 'uninstall')).toBe('p1');
  expect(() => authorizeUninstall({ ...document, grants: [{ ...grant, scopes: ['s'] }] }, principal, 'installation', ['s'], 'uninstall')).toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
  expect(() => authorizeUninstall({ ...document, grants: [grant, { ...grant, id: 'other-company-deny', scopes: ['s2'], effect: 'deny' }] }, principal, 'installation', ['s', 's2'], 'uninstall')).toThrow(expect.objectContaining({ code: 'UNINSTALL_MANAGED' }));
  expect(() => authorizeUninstall({ ...document, grants: [{ ...grant, effect: 'require-approval' }] }, principal, 'installation', ['s'], 'uninstall')).toThrow(expect.objectContaining({ code: 'POLICY_APPROVAL_UNSUPPORTED' }));
  expect(() => authorizeUninstall(document, { ...principal, issuer: 'fixture/mcp' }, 'installation', ['s'], 'uninstall')).toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
});

it('refuses purge under a company legal hold before backup/effect admission even when the real uninstall card would be approved', async () => {
  const principal: VerifiedPrincipal = { id: 'admin', issuer: 'fixture', subject: 'admin', assurance: 'os-user', scopeIds: ['company'] };
  const allow = { id: 'admin', effect: 'allow', principals: 'all', actions: 'all', scopes: 'all', resource: { kind: 'installation', ids: ['installation'] } };
  const document = { schemaVersion: 1, revision: 'hold1', restrictions: [{ id: 'company-retention-owner', principals: 'all', actions: ['purge'], scopes: 'all', resource: { kind: 'installation', ids: 'all' } }], grants: [allow] };
  const plan = createUninstallPlan({ schemaVersion: 2, tier: 'all', force: false, disableUnit: false }, { installation: { id: 'installation', root: '/fixture/data' }, scopeSummary: ['company'],
    layoutRevision: 'layout', policyRevision: 'hold1', inventoryRevision: 'inventory', resources: [], protectedPaths: [], deletionRoots: ['/fixture/data'],
    backupDestination: '/fixture/recovery', packageRemoval: { command: null, shared: true }, blockers: [], dataBlockers: [], managedScopes: [],
    work: { running: [], parked: [], approvals: [], deliveries: [], uncertain: [], complete: true }, service: { running: false, unit: null, unitDisable: 'none', command: null } });
  let admits = 0;
  const app = new UninstallApplication({ channel: undefined, witness: { attest: async () => true }, principal: async () => principal,
    authorize: async (action, actor) => { authorizeUninstall(document, actor, 'installation', ['company'], action); },
    inventory: async () => { throw new Error('retained plan required'); }, retainedPlan: async () => plan,
    withAdmission: async () => { admits++; throw new Error('must not start backup or effects'); } });
  await expect(app.apply({ schemaVersion: 2, commandId: 'purge', planDigest: plan.planDigest }, { confirm: async () => true }))
    .rejects.toMatchObject({ code: 'UNINSTALL_PURGE_DENIED' });
  expect(admits).toBe(0);
  expect(() => authorizeUninstall(document, principal, 'installation', ['company'], 'uninstall')).not.toThrow();
  expect(() => authorizeUninstall(document, principal, 'installation', ['company'], 'purge')).toThrow(/company-retention-owner/u);
});

it('admits an installation-wide administrator role while keeping a managed install closed to its ordinary member', () => {
  const principal: VerifiedPrincipal = { id: 'admin', issuer: 'idp', subject: 'admin', assurance: 'os-user', scopeIds: ['company'] };
  const document = { schemaVersion: 2, revision: 'p1+b1', policyRevision: 'p1', grants: [], restrictions: [], separationOfDuties: [],
    roles: [{ id: 'installation-admin', permissions: [{ id: 'uninstall', effect: 'allow', actions: ['inspect', 'uninstall', 'purge'], resource: { kind: 'installation', ids: 'all' } }] }],
    bindings: { revision: 'b1', entries: [{ id: 'admins', principals: [{ issuer: 'idp', subject: 'admin' }], roles: ['installation-admin'], scopes: 'all' }] } };
  expect(authorizeUninstall(document, principal, 'installation', ['company'], 'uninstall')).toBe('p1+b1');
  expect(() => authorizeUninstall(document, { ...principal, subject: 'member' }, 'installation', ['company'], 'uninstall'))
    .toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
});

it('asks nothing when nothing would change, stops the service before custody in the K4 order, and never closes an unknown result under force', async () => {
  const principal: VerifiedPrincipal = { id: 'person', issuer: 'fixture', subject: 'person', assurance: 'os-user', scopeIds: ['s'] };
  const idle = { running: [], parked: [], approvals: [], deliveries: [], uncertain: [], complete: true };
  const effect = { kind: 'effect' as const, scopeId: 's', id: 'erp-invoice', target: 'erp/invoice-1' };
  let work: UninstallInventory['work'] = idle, answering = false, cards = 0;
  const calls: string[] = [];
  const inventory = (): UninstallInventory => ({ installation: { id: 'installation', root: '/fixture/data' }, scopeSummary: ['s'], layoutRevision: 'l1', policyRevision: 'p1',
    inventoryRevision: 'i1', resources: [], blockers: [], dataBlockers: [], protectedPaths: [], deletionRoots: ['/fixture/data'], backupDestination: '/fixture/recovery/backup',
    packageRemoval: { command: null, shared: true }, work, managedScopes: [], service: { running: false, unit: null, unitDisable: 'none', command: null } });
  const descriptor = (instanceId: string) => ({ instanceId, processId: 41 }) as unknown as import('#engine/index.js').RuntimeServiceDescriptor;
  let instance = 'first';
  const app = () => new UninstallApplication({ channel: undefined, witness: { attest: async () => true }, principal: async () => principal, authorize: async () => {},
    inventory: async () => inventory(), retainedPlan: async () => null,
    withAdmission: async (plan, _id, run) => { calls.push(`custody:${plan.service.running}`); return run({ scopeId: 's', recoveryLocation: '/fixture/recovery', effects: { inspect: async () => null, execute: async () => { throw new Error('no effect expected'); } },
      revalidate: async () => {}, prepareBackup: async () => { calls.push('backup'); }, approvePlan: async () => {}, finish: async result => { calls.push(`finish:${result.status}`); } }); },
    force: { cancelRun: async ref => { calls.push(`cancel:${ref.id}`); work = { ...work, running: [] }; }, rejectApproval: async ref => { calls.push(`reject:${ref.id}`); work = { ...work, approvals: [] }; },
      withdrawDelivery: async ref => { calls.push(`withdraw:${ref.id}`); work = { ...work, deliveries: [] }; } },
    settle: { budgetMs: 1000, wait: async () => {} },
    service: { budgetMs: 1000, describe: async () => { if (!answering) throw ErrorRegistry.createError('LOCAL_RUNTIME_UNAVAILABLE'); return descriptor(instance); },
      unit: async () => ({ unit: 'deckent-fixture.service', unitDisable: 'eligible', command: 'systemctl --user disable --now deckent-fixture.service' }),
      // A manager restarts the stopped service (a new instance) until the unit is disabled.
      shutdown: async () => { calls.push('shutdown'); instance = 'restarted'; }, disable: async unit => { calls.push(`disable:${unit}`); answering = false; return { unit, previous: 'enabled', undo: `systemctl --user enable --now ${unit}` }; } } });
  const confirm = { confirm: async () => { cards++; return true; } };
  const query = (extra: object = {}) => ({ schemaVersion: 2, tier: 'keep-data', force: false, disableUnit: false, ...extra });
  // Owner 2026-10-27: nothing removed or stopped → no card, no custody.
  const nothing = await app().preview(query());
  expect(nothing.nothingToRemove).toBe(true);
  expect(await app().apply({ schemaVersion: 2, commandId: 'c1', planDigest: nothing.planDigest }, confirm)).toMatchObject({ status: 'noop' });
  expect(cards).toBe(0); expect(calls).toEqual([]);
  // A service its unit restarts: refused before any card without --disable-unit; with it, governed shutdown → new instance seen → disable --now → absence → custody.
  answering = true;
  const refused = await app().preview(query());
  await expect(app().apply({ schemaVersion: 2, commandId: 'c2', planDigest: refused.planDigest }, confirm)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
  expect(cards).toBe(0);
  const unit = await app().preview(query({ disableUnit: true }));
  const result = await app().apply({ schemaVersion: 2, commandId: 'c3', planDigest: unit.planDigest }, confirm);
  expect(calls).toEqual(['shutdown', 'disable:deckent-fixture.service', 'custody:false', 'finish:completed']);
  expect(result).toMatchObject({ status: 'completed', unit: { unit: 'deckent-fixture.service', previous: 'enabled' } }); expect(cards).toBe(1);
  // K3: force cancels and rejects with the person's authority, names the unknown result and closes nothing; a NEW unknown result after cancelling stops before custody.
  calls.length = 0; answering = false;
  work = { ...idle, running: [{ scopeId: 's', id: 'run-1', revision: 2 }], approvals: [{ scopeId: 's', id: 'approval-1', revision: 0 }], deliveries: [{ scopeId: 's', id: 'ticket-1', revision: 3 }], uncertain: [effect] };
  const forced = await app().preview(query({ tier: 'all', force: true }));
  const named = await app().apply({ schemaVersion: 2, commandId: 'c4', planDigest: forced.planDigest }, { ...confirm, backupPassphrase: async () => 'temporary' });
  // Nothing here deletes data, so no backup is asked; force's own steps and the unknown result are named.
  expect(calls).toEqual(['cancel:run-1', 'reject:approval-1', 'withdraw:ticket-1', 'custody:false', 'finish:completed']);
  expect(named.uncertain).toEqual([effect]);
  calls.length = 0;
  work = { ...idle, running: [{ scopeId: 's', id: 'run-2', revision: 1 }], uncertain: [effect] };
  const drifting = await app().preview(query({ tier: 'all', force: true }));
  const cancelRun = async () => { calls.push('cancel:run-2'); work = { ...work, running: [], uncertain: [effect, { ...effect, id: 'erp-credit-note' }] }; };
  const raced = new UninstallApplication({ ...(app() as unknown as { ports: import('#engine/index.js').UninstallApplicationPorts }).ports, force: { cancelRun, rejectApproval: async () => {}, withdrawDelivery: async () => {} } });
  await expect(raced.apply({ schemaVersion: 2, commandId: 'c5', planDigest: drifting.planDigest }, confirm))
    .rejects.toMatchObject({ code: 'UNINSTALL_PLAN_CHANGED', params: { diff: 'uncertain:effect:erp-credit-note' } });
  expect(calls).toEqual(['cancel:run-2']);
});
