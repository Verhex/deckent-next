import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { UninstallApplication, authorizeUninstall, authorizeUninstallSteps, createUninstallPlan, uninstallOperationDescriptors, EffectApplication, OperationPolicyAuthorization,
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
      blockers: [], protectedPaths: [ledger], deletionRoots: [root], backupDestination: join(`${root}-recovery`, 'backup'), packageRemoval: { command: null, shared: true },
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
    const purgeInventory = { ...inventory, backupDestination: join(`${root}-external`, 'backup'), resources: [{ ...inventory.resources[0]!, contribution: 'conversation', version: (await cacheTarget.observe({ kind: cacheTarget.kind, id: 'cache' })).version }] };
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
      shutdown: async () => { calls.push('shutdown'); instance = 'restarted'; }, disable: async ({ unit }) => { calls.push(`disable:${unit}`); answering = false; return { unit: unit!, previous: 'enabled', undo: `systemctl --user enable --now ${unit}` }; } } });
  const confirm = { confirm: async () => { cards++; return true; } };
  const query = (extra: object = {}) => ({ schemaVersion: 2, tier: 'keep-data', force: false, disableUnit: false, ...extra });
  // Owner 2026-10-27: nothing removed or stopped → no card, no custody.
  const nothing = await app().preview(query());
  expect(nothing.nothingToRemove).toBe(true);
  expect(await app().apply({ schemaVersion: 2, commandId: 'c1', planDigest: nothing.planDigest }, confirm)).toMatchObject({ status: 'noop' });
  expect(cards).toBe(0); expect(calls).toEqual([]);
  // A service under a unit: refused before any card without --disable-unit; with it, governed shutdown → absence → disable --now → custody.
  answering = true;
  const refused = await app().preview(query());
  await expect(app().apply({ schemaVersion: 2, commandId: 'c2', planDigest: refused.planDigest }, confirm)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
  expect(cards).toBe(0);
  const unitPorts = (app() as unknown as { ports: import('#engine/index.js').UninstallApplicationPorts }).ports;
  const stops = new UninstallApplication({ ...unitPorts, service: { ...unitPorts.service!, shutdown: async () => { calls.push('shutdown'); answering = false; } } });
  const unit = await stops.preview(query({ disableUnit: true }));
  const result = await stops.apply({ schemaVersion: 2, commandId: 'c3', planDigest: unit.planDigest }, confirm);
  expect(calls).toEqual(['shutdown', 'disable:deckent-fixture.service', 'custody:false', 'finish:completed']);
  expect(result).toMatchObject({ status: 'completed', unit: { unit: 'deckent-fixture.service', previous: 'enabled' } }); expect(cards).toBe(1);
  // R4 (lead 2026-10-28): the unit's manager starts a new instance after the governed shutdown (it may already accept work): nothing is
  // disabled or stopped by --now; the refusal names the exact command.
  calls.length = 0; answering = true; instance = 'first';
  const restarting = await app().preview(query({ disableUnit: true }));
  await expect(app().apply({ schemaVersion: 2, commandId: 'c3b', planDigest: restarting.planDigest }, confirm))
    .rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING', params: { command: 'systemctl --user disable --now deckent-fixture.service' } });
  expect(calls).toEqual(['shutdown']); answering = false;
  // K3: force cancels and rejects with the person's authority, names the unknown result and closes nothing; a NEW unknown result after cancelling stops before custody.
  calls.length = 0; answering = false;
  work = { ...idle, running: [{ scopeId: 's', id: 'run-1', revision: 2 }], approvals: [{ scopeId: 's', id: 'approval-1', revision: 0 }], deliveries: [{ scopeId: 's', id: 'ticket-1', revision: 3 }], uncertain: [effect] };
  const forced = await app().preview(query({ tier: 'all', force: true }));
  const named = await app().apply({ schemaVersion: 2, commandId: 'c4', planDigest: forced.planDigest }, { ...confirm, backupPassphrase: async () => 'temporary' });
  // Nothing here deletes data, so no backup is asked; force's own steps and the unknown result are named.
  expect(calls).toEqual(['withdraw:ticket-1', 'cancel:run-1', 'reject:approval-1', 'custody:false', 'finish:completed']);
  expect(named.uncertain).toEqual([effect]);
  calls.length = 0;
  work = { ...idle, running: [{ scopeId: 's', id: 'run-2', revision: 1 }], uncertain: [effect] };
  const drifting = await app().preview(query({ tier: 'all', force: true }));
  const cancelRun = async () => { calls.push('cancel:run-2'); work = { ...work, running: [], uncertain: [effect, { ...effect, id: 'erp-credit-note' }] }; };
  const raced = new UninstallApplication({ ...(app() as unknown as { ports: import('#engine/index.js').UninstallApplicationPorts }).ports, force: { cancelRun, rejectApproval: async () => {}, withdrawDelivery: async () => {} } });
  await expect(raced.apply({ schemaVersion: 2, commandId: 'c5', planDigest: drifting.planDigest }, confirm))
    .rejects.toMatchObject({ code: 'UNINSTALL_PLAN_CHANGED', params: { diff: 'uncertain:effect:erp-credit-note' } });
  expect(calls).toEqual(['cancel:run-2']);
  // M14, R8: any step an owner would refuse after the card (here the second of two deliveries) is refused before it: no card, no service
  // stop, no cancel, no withdrawal, no custody.
  calls.length = 0; cards = 0; answering = false;
  work = { ...idle, running: [{ scopeId: 's', id: 'run-3', revision: 1 }], deliveries: [{ scopeId: 's', id: 'ticket-1', revision: 1 }, { scopeId: 's', id: 'ticket-2', revision: 1 }] };
  const ports = (app() as unknown as { ports: import('#engine/index.js').UninstallApplicationPorts }).ports, decided: string[] = [];
  const denied = new UninstallApplication({ ...ports, preflight: async plan => { for (const ref of plan.steps.withdrawDeliveries) { decided.push(ref.id); if (ref.id === 'ticket-2') throw ErrorRegistry.createError('POLICY_DENIED'); } } });
  const forcedRun = await denied.preview(query({ tier: 'all', force: true }));
  await expect(denied.apply({ schemaVersion: 2, commandId: 'c6', planDigest: forcedRun.planDigest }, confirm)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(cards).toBe(0); expect(calls).toEqual([]); expect(decided).toEqual(['ticket-1', 'ticket-2']); work = idle;
  // R8: the owners' own rules from one policy document: a run cancel, the removal's operation and the person's approval decision are each refused.
  const base = { schemaVersion: 1, revision: 'p1', restrictions: [], grants: ['installation', 'backup', 'run', 'operation', 'approval'].map(kind => ({ id: kind, effect: 'allow', principals: 'all', actions: 'all', scopes: 'all', resource: { kind, ids: 'all' } })) };
  const removing = { ...forcedRun, items: [{ action: 'remove', operation: { id: 'installation.remove-data', version: 1 } }], steps: { ...forcedRun.steps, cancelRuns: [{ scopeId: 's', id: 'run-3', revision: 1 }], rejectApprovals: [] } } as unknown as UninstallPlan;
  await expect(authorizeUninstallSteps(base, removing, principal, 's')).resolves.toBeUndefined();
  for (const kind of ['run', 'operation', 'approval']) {
    const without = { ...base, grants: [...base.grants.filter(grant => grant.id !== kind), { ...base.grants[0]!, id: `deny-${kind}`, effect: 'deny', resource: { kind, ids: 'all' } }] };
    await expect(authorizeUninstallSteps(without, removing, principal, 's')).rejects.toMatchObject({ code: kind === 'approval' ? 'APPROVAL_DENIED' : 'POLICY_DENIED' });
  }
  // F6: the decider's fixed rules for the same person, before any card: an approval grant naming ids (the broker's id is not known yet, so the
  // plan digest named on the card covers nothing), a four-eyes rule, and an assurance minimum the card cannot attest are each refused.
  const v2 = { ...base, schemaVersion: 2, revision: 'p1+b1', policyRevision: 'p1', bindings: { revision: 'b1', entries: [] }, roles: [], separationOfDuties: [] };
  const listed = { ...v2, grants: v2.grants.map(grant => grant.id === 'approval' ? { ...grant, resource: { kind: 'approval', ids: [forcedRun.planDigest] } } : grant) };
  await expect(authorizeUninstallSteps(listed, removing, principal, 's')).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
  await expect(authorizeUninstallSteps({ ...v2, separationOfDuties: [{ id: 'four-eyes', rule: 'requester-cannot-approve', scopes: 'all' }] }, removing, principal, 's'))
    .rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
  await expect(authorizeUninstallSteps({ ...v2, approvalAssurance: [{ id: 'strong', scopes: 'all', subject: 'operation', minimum: 'turn-bound' }] }, removing, principal, 's'))
    .rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
  await expect(authorizeUninstallSteps(v2, removing, principal, 's')).resolves.toBeUndefined();
  // M14: deleting data needs the backup grant too; without it the data tiers are refused by the same decision the menu shows before any card.
  const owner = { id: 'owner', effect: 'allow', principals: 'all', actions: 'all', scopes: 'all' } as const;
  const noBackup = { schemaVersion: 1, revision: 'p1', restrictions: [], grants: [{ ...owner, resource: { kind: 'installation', ids: 'all' } }] };
  expect(() => authorizeUninstall(noBackup, principal, 'installation', ['s'], 'purge')).toThrow(expect.objectContaining({ code: 'UNINSTALL_BACKUP_DENIED' }));
  expect(authorizeUninstall(noBackup, principal, 'installation', ['s'], 'uninstall')).toBe('p1');
  expect(authorizeUninstall({ ...noBackup, grants: [...noBackup.grants, { ...owner, id: 'backup', resource: { kind: 'backup', ids: 'all' } }] }, principal, 'installation', ['s'], 'purge')).toBe('p1');
});

it('K3 on the real delivery queue: delete everything refuses a queued delivery naming the next command; --force withdraws it through the queue owner', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { migrateLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  const { SqliteTargetQueue } = await import('#adapters/core/target-queue-store/index.js');
  const { observeUninstallWork } = await import('#adapters/core/installation-removal/index.js');
  const { TargetQueueApplication } = await import('#engine/index.js');
  const { targetQueueRequestSchema } = await import('#domain/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-uninstall-queue-')), ledger = join(root, 'ledger.sqlite'), db = new DatabaseSync(ledger);
  try {
    migrateLedger(db, 'allow');
    const principal: VerifiedPrincipal = { id: 'person', issuer: 'fixture', subject: 'person', assurance: 'os-user', scopeIds: ['s'] }, asked: string[] = [];
    const queue = new TargetQueueApplication(new SqliteTargetQueue(db), { async authorize(_request, _principal, action) { asked.push(action); }, async validate() {} },
      { capacity: 8, perTarget: 4, activeTargets: 2, batchSize: 2, batchWindowMs: 100, leaseMs: 1000, verificationTimeoutMs: 1000, revalidations: 2 }, () => {});
    await queue.submit(targetQueueRequestSchema.parse({ schemaVersion: 1, commandId: 'delivery-1', identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' },
      actor: { id: 'person', issuer: 'fixture', subject: 'person' }, target: { schemaVersion: 1, installationId: 'i', adapter: { id: 'adapter', version: 1 }, resourceBinding: 'a'.repeat(64),
        target: { kind: 'record', id: 'erp-invoice' } }, payloadDigest: 'b'.repeat(64), policyRevision: 'p1', outputDigest: 'c'.repeat(64), acceptedRevision: 1, submittedAt: 1, deadline: 5000 }), principal);
    const custody: string[] = [];
    const app = () => new UninstallApplication({ channel: undefined, witness: { attest: async () => true }, principal: async () => principal, authorize: async () => {},
      inventory: async () => ({ installation: { id: 'installation', root: '/fixture/data' }, scopeSummary: ['s'], layoutRevision: 'l1', policyRevision: 'p1', inventoryRevision: 'i1',
        resources: [], blockers: [], dataBlockers: [], protectedPaths: [], deletionRoots: ['/fixture/data'], backupDestination: '/fixture/recovery/backup', packageRemoval: { command: null, shared: true },
        // The work comes from the ledger itself, read-only, exactly as the uninstall inventory observes it.
        work: observeUninstallWork(ledger, { busyTimeoutMs: 1000, maxRecords: 64 }), managedScopes: [], service: { running: false, unit: null, unitDisable: 'none', command: null } }),
      retainedPlan: async () => null,
      withAdmission: async (_plan, _id, run) => { custody.push('custody'); return run({ scopeId: 's', recoveryLocation: '/fixture/recovery', effects: { inspect: async () => null, execute: async () => { throw new Error('no effect expected'); } },
        revalidate: async () => {}, prepareBackup: async () => {}, approvePlan: async () => {}, finish: async () => {} }); },
      force: { cancelRun: async () => {}, rejectApproval: async () => {},
        withdrawDelivery: async ref => { const record = await queue.inspect(ref.scopeId, ref.id, principal); if (record) await queue.cancel(record, principal); } },
      settle: { budgetMs: 1000, wait: async () => {} }, service: { budgetMs: 1000, describe: async () => { throw ErrorRegistry.createError('LOCAL_RUNTIME_UNAVAILABLE'); },
        unit: async () => null, shutdown: async () => {}, disable: async ({ unit }) => ({ unit: unit!, previous: 'enabled', undo: '' }) } });
    const query = { schemaVersion: 2, tier: 'all', force: false, disableUnit: false } as const, confirm = { confirm: async () => true, backupPassphrase: async () => 'temporary' };
    // Negative: without --force nothing is touched and the refusal names the next command.
    const refused = await app().preview(query);
    const error = await app().apply({ schemaVersion: 2, commandId: 'q1', planDigest: refused.planDigest }, confirm).catch((caught: unknown) => caught as { code?: string; message?: string });
    expect(error).toMatchObject({ code: 'UNINSTALL_DELIVERY_QUEUED' }); expect(error?.message).toContain('deckent uninstall --all --force');
    expect(new SqliteTargetQueue(db).load('s', 'delivery-1')?.state).toBe('queued'); expect(custody).toEqual([]);
    // --force: the queue owner cancels it with the person's authority (no direct row write); the plan sees no drift and custody follows.
    const forced = await app().preview({ ...query, force: true });
    expect(await app().apply({ schemaVersion: 2, commandId: 'q2', planDigest: forced.planDigest }, confirm)).toMatchObject({ status: 'completed' });
    expect(new SqliteTargetQueue(db).load('s', 'delivery-1')?.state).toBe('cancelled'); expect(asked).toEqual(['submit', 'inspect', 'cancel']); expect(custody).toEqual(['custody']);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
