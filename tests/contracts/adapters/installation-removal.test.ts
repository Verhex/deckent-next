import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { InstallationServiceRemovalTarget, InstallationCacheRemovalTarget, type ServiceObservation, type ServiceRemovalDriver } from '#adapters/core/installation-removal/index.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('observes stop and disable before removing only the owned service; foreign/Also/trigger/self and unresolved native states refuse', async () => {
  for (const scope of ['user', 'system'] as const) {
    const resource = { resourceId: 'service', installationId: 'temp', manager: 'systemd' as const, scope, unit: 'fixture.service', ownershipDigest: 'a'.repeat(64) };
    let current: ServiceObservation = { ownershipDigest: resource.ownershipDigest, active: true, enabled: true, present: true, mainPid: 123,
      also: [], triggers: [], foreignArtifacts: false, callerInService: false, revision: 'v1' };
    const transcript: string[] = [];
    const driver: ServiceRemovalDriver = { identity: `fixture-${scope}`, async withCustody(_service, work) { return work(); },
      async inspect() { transcript.push('inspect'); return current; },
      async stop() { transcript.push('stop'); current = { ...current, active: false, mainPid: 0 }; },
      async disable() { transcript.push('disable'); current = { ...current, enabled: false }; },
      async removeOwnedArtifacts() { transcript.push('remove-owned'); current = { ...current, present: false }; },
      async reload() { transcript.push('reload'); } };
    const target = new InstallationServiceRemovalTarget([resource], driver), ref = { kind: target.kind, id: 'service' };
    const version = (await target.observe(ref)).version;
    if (process.platform !== 'linux') {
      await expect(target.apply({ target: ref, operation: { id: 'installation.remove-service', version: 1 }, idempotencyKey: 'key', expectedVersion: version, input: null })).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
      console.info('verify-not-run: service removal positive requires Linux manager custody'); continue;
    }
    await target.apply({ target: ref, operation: { id: 'installation.remove-service', version: 1 }, idempotencyKey: 'key', expectedVersion: version, input: null });
    expect(transcript).toEqual(['inspect', 'inspect', 'stop', 'inspect', 'disable', 'inspect', 'remove-owned', 'reload', 'inspect']);
    expect(await target.lookup(ref, 'key')).toEqual({ status: 'applied', version: null });
    for (const change of [{ ownershipDigest: 'foreign' }, { also: ['foreign.service'] }, { triggers: ['foreign.socket'] }, { callerInService: true }, { active: null }]) {
      current = { ...current, ...change }; const prior = transcript.length;
      await expect(target.apply({ target: ref, operation: { id: 'installation.remove-service', version: 1 }, idempotencyKey: 'other', expectedVersion: version, input: null })).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
      expect(transcript.slice(prior)).toEqual(['inspect']); current = { ...current, ownershipDigest: resource.ownershipDigest, also: [], triggers: [], callerInService: false, active: false };
    }
    current = { ...current, present: true, active: true, enabled: true, mainPid: 123 };
    driver.stop = async () => { transcript.push('stop-unproven'); };
    const expectedVersion = (await target.observe(ref)).version, prior = transcript.length;
    await expect(target.apply({ target: ref, operation: { id: 'installation.remove-service', version: 1 }, idempotencyKey: 'lost', expectedVersion, input: null })).rejects.toMatchObject({ code: 'EFFECT_TARGET_UNKNOWN' });
    expect(transcript.slice(prior)).toEqual(['inspect', 'stop-unproven', 'inspect']); expect(await target.lookup(ref, 'lost')).toBeNull();
  }
});

it('removes a bounded owned disposable tree, refusing symlinks, protected overlap and version drift while retaining durable sentinels', async () => {
  if (process.platform === 'win32') {
    expect(() => new InstallationCacheRemovalTarget('fixture', [], [], { maxEntries: 10, maxDepth: 3 }, async work => work())).toThrow(expect.objectContaining({ code: 'EFFECT_TARGET_REJECTED' }));
    console.info('verify-not-run: cache removal POSIX ownership unavailable'); return;
  }
  const root = await mkdtemp(join(tmpdir(), 'deckent-uninstall-cache-')); roots.push(root);
  const cache = join(root, 'cache'), audit = join(root, 'audit'); await mkdir(cache, { mode: 0o700 });
  await writeFile(audit, 'retained', { mode: 0o600 }); await writeFile(join(cache, 'entry'), 'disposable', { mode: 0o600 });
  const resource = { resourceId: 'cache', path: cache, ownershipDigest: 'a'.repeat(64) };
  const target = new InstallationCacheRemovalTarget('fixture', [resource], [audit], { maxEntries: 10, maxDepth: 3 }, async work => work());
  const ref = { kind: target.kind, id: 'cache' }, request = { target: ref, operation: { id: 'installation.remove-cache', version: 1 }, idempotencyKey: 'key', expectedVersion: (await target.observe(ref)).version, input: null };
  await symlink(audit, join(cache, 'link'));
  await expect(target.apply(request)).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
  await rm(join(cache, 'link')); await expect(target.apply(request)).rejects.toMatchObject({ code: 'EFFECT_TARGET_PRECONDITION' });
  request.expectedVersion = (await target.observe(ref)).version; await target.apply(request);
  await expect(lstat(cache)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(audit, 'utf8')).toBe('retained');
  expect(await target.lookup(ref, 'key')).toEqual({ status: 'applied', version: null });
  const blocked = new InstallationCacheRemovalTarget('fixture', [{ ...resource, path: root }], [audit], { maxEntries: 10, maxDepth: 3 }, async work => work());
  await expect(blocked.observe(ref)).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
});

it('never accepts a foreign target id or a symlink ancestor into the recorded disposable set', async () => {
  if (process.platform === 'win32') { console.info('verify-not-run: POSIX no-follow ownership check'); return; }
  const root = await mkdtemp(join(tmpdir(), 'deckent-uninstall-foreign-')); roots.push(root);
  const foreign = join(root, 'foreign'), owned = join(root, 'owned');
  await mkdir(foreign, { mode: 0o700 }); await mkdir(owned, { mode: 0o700 });
  await writeFile(join(foreign, 'customer-record'), 'KEEP', { mode: 0o600 });
  await symlink(foreign, join(owned, 'link'));
  const target = new InstallationCacheRemovalTarget('installation', [{ resourceId: 'cache', path: join(owned, 'link/customer-record'), ownershipDigest: 'a'.repeat(64) }], [],
    { maxEntries: 10, maxDepth: 3 }, work => work());
  const command = { operation: { id: 'installation.remove-cache', version: 1 }, idempotencyKey: 'approved-card', expectedVersion: 'approved-version', input: null };
  await expect(target.apply({ ...command, target: { kind: target.kind, id: foreign } })).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
  await expect(target.apply({ ...command, target: { kind: target.kind, id: 'cache' } })).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
  expect(await readFile(join(foreign, 'customer-record'), 'utf8')).toBe('KEEP');
});

it('keeps an authenticated recovery hold on unknown, rejects a different installation/person and releases only after settlement', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: private recovery and directory fsync require Linux'); return; }
  const { UninstallRecovery } = await import('#adapters/core/installation-removal/index.js');
  const { createUninstallPlan } = await import('#engine/core/installation/index.js');
  const { createHmacIntegrity, uninstallHoldPath } = await import('#platform/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-uninstall-recovery-')); roots.push(root);
  const principal = { id: 'person', issuer: 'fixture', subject: 'person', assurance: 'os-user' as const, scopeIds: ['company'] };
  const integrity = createHmacIntegrity('fixture', new Uint8Array(32).fill(7));
  const recovery = new UninstallRecovery(root, 'installation', principal, integrity, 65536);
  const plan = createUninstallPlan({ schemaVersion: 1, purge: false }, { installation: { id: 'installation', root }, scopeSummary: ['company'], layoutRevision: 'l1',
    policyRevision: 'p1', inventoryRevision: 'i1', resources: [], blockers: [], protectedPaths: [], deletionRoots: [root], backupDestination: null, packageRemoval: { command: null, shared: true } });
  expect(await recovery.retained(plan.planDigest)).toBeNull();
  await expect(lstat(join(root, 'uninstall-recovery'))).rejects.toMatchObject({ code: 'ENOENT' });
  await recovery.admit(plan); expect(await recovery.retained(plan.planDigest)).toEqual(plan);
  const outcome = { schemaVersion: 1 as const, planDigest: plan.planDigest, status: 'unknown' as const, items: [], recoveryLocation: root, backup: plan.backup, packageRemoval: plan.packageRemoval };
  await recovery.finish(outcome); expect(await lstat(uninstallHoldPath(root))).toBeTruthy();
  await expect(new UninstallRecovery(root, 'another-installation', principal, integrity, 65536).retained(plan.planDigest)).rejects.toMatchObject({ code: 'UNINSTALL_RECOVERY_INVALID' });
  await expect(new UninstallRecovery(root, 'installation', { ...principal, subject: 'another-person' }, integrity, 65536).retained(plan.planDigest)).rejects.toMatchObject({ code: 'UNINSTALL_RECOVERY_INVALID' });
  await recovery.finish({ ...outcome, status: 'completed' }); await expect(lstat(uninstallHoldPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
  const manifest = join(root, 'uninstall-recovery', `${plan.planDigest}.json`);
  await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('p1', 'p2'), { mode: 0o600 });
  await expect(recovery.retained(plan.planDigest)).rejects.toMatchObject({ code: 'UNINSTALL_RECOVERY_INVALID' });
});
