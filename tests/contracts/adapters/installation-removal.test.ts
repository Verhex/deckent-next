import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { InstallationServiceRemovalTarget, InstallationCacheRemovalTarget, type ServiceObservation, type ServiceRemovalDriver } from '#adapters/core/installation-removal/index.js';
const roots: string[] = [];
const observed = { dataBlockers: [], managedScopes: [], work: { running: [], parked: [], approvals: [], deliveries: [], uncertain: [], complete: true },
  service: { running: false, unit: null, unitDisable: 'none' as const, command: null } };
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

it('removes only the owner-named members of a cache, keeping same-user strays and their parent while refusing symlinks, protected overlap and drift', async () => {
  if (process.platform === 'win32') {
    expect(() => new InstallationCacheRemovalTarget('fixture', [], [], { maxEntries: 10, maxDepth: 3 }, async work => work())).toThrow(expect.objectContaining({ code: 'EFFECT_TARGET_REJECTED' }));
    console.info('verify-not-run: cache removal POSIX ownership unavailable'); return;
  }
  const root = await mkdtemp(join(tmpdir(), 'deckent-uninstall-cache-')); roots.push(root);
  const cache = join(root, 'cache'), area = join(cache, 'a'.repeat(32)), audit = join(root, 'audit'); await mkdir(area, { mode: 0o700, recursive: true });
  await writeFile(audit, 'retained', { mode: 0o600 }); await writeFile(join(area, 'entry'), 'disposable', { mode: 0o600 });
  // M1: a private same-user file in the canonical tree is not the owner's member; placement and UID are no ownership.
  await writeFile(join(cache, 'customer-record'), 'KEEP', { mode: 0o600 });
  const resource = { resourceId: 'cache', path: cache, ownershipDigest: 'a'.repeat(64), members: ['^[0-9a-f]{32}$'] };
  const target = new InstallationCacheRemovalTarget('fixture', [resource], [audit], { maxEntries: 10, maxDepth: 3 }, async work => work());
  const ref = { kind: target.kind, id: 'cache' }, request = { target: ref, operation: { id: 'installation.remove-cache', version: 1 }, idempotencyKey: 'key', expectedVersion: (await target.observe(ref)).version, input: null };
  expect(await target.inspect(ref)).toMatchObject({ members: [area], unlisted: [join(cache, 'customer-record')] });
  await symlink(audit, join(area, 'link'));
  await expect(target.apply(request)).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
  await rm(join(area, 'link')); await expect(target.apply(request)).rejects.toMatchObject({ code: 'EFFECT_TARGET_PRECONDITION' });
  request.expectedVersion = (await target.observe(ref)).version; await target.apply(request);
  await expect(lstat(area)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(audit, 'utf8')).toBe('retained');
  expect(await readFile(join(cache, 'customer-record'), 'utf8')).toBe('KEEP');
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
  const target = new InstallationCacheRemovalTarget('installation', [{ resourceId: 'cache', path: join(owned, 'link/customer-record'), ownershipDigest: 'a'.repeat(64), members: ['^.*$'] }], [],
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
  const plan = createUninstallPlan({ schemaVersion: 2, tier: 'keep-data', force: false, disableUnit: false }, { installation: { id: 'installation', root }, scopeSummary: ['company'], layoutRevision: 'l1',
    policyRevision: 'p1', inventoryRevision: 'i1', resources: [], blockers: [], protectedPaths: [], deletionRoots: [root], backupDestination: null, packageRemoval: { command: null, shared: true }, ...observed });
  expect(await recovery.retained(plan.planDigest)).toBeNull();
  await expect(lstat(join(root, 'uninstall-recovery'))).rejects.toMatchObject({ code: 'ENOENT' });
  await recovery.admit(plan); expect(await recovery.retained(plan.planDigest)).toEqual(plan);
  const outcome = { schemaVersion: 2 as const, planDigest: plan.planDigest, status: 'unknown' as const, items: [], recoveryLocation: root, backup: plan.backup, packageRemoval: plan.packageRemoval, uncertain: [] };
  await recovery.finish(outcome); expect(await lstat(uninstallHoldPath(root))).toBeTruthy();
  await expect(new UninstallRecovery(root, 'another-installation', principal, integrity, 65536).retained(plan.planDigest)).rejects.toMatchObject({ code: 'UNINSTALL_RECOVERY_INVALID' });
  await expect(new UninstallRecovery(root, 'installation', { ...principal, subject: 'another-person' }, integrity, 65536).retained(plan.planDigest)).rejects.toMatchObject({ code: 'UNINSTALL_RECOVERY_INVALID' });
  await recovery.finish({ ...outcome, status: 'completed' }); await expect(lstat(uninstallHoldPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
  const manifest = join(root, 'uninstall-recovery', `${plan.planDigest}.json`);
  await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('p1', 'p2'), { mode: 0o600 });
  await expect(recovery.retained(plan.planDigest)).rejects.toMatchObject({ code: 'UNINSTALL_RECOVERY_INVALID' });
});

it('uses the bounded native systemd driver only for the exact recorded user unit and enablement links, refusing foreign artifacts before stop', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: native systemd removal is Linux-only'); return; }
  const { NativeServiceRemovalDriver, InstallationServiceRemovalTarget, readNativeServiceRecord } = await import('#adapters/core/installation-removal/index.js');
  const { sha256, createHmacIntegrity } = await import('#platform/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-native-uninstall-')); roots.push(root);
  const units = join(root, 'units'), links = join(units, 'default.target.wants'), identity = join(root, 'identity');
  await mkdir(units, { mode: 0o700 }); await mkdir(links, { mode: 0o700 }); await mkdir(identity, { mode: 0o700 });
  const unit = join(units, 'temporary.service'), link = join(links, 'temporary.service'), foreign = join(units, 'customer.service');
  const bytes = '[Unit]\nDescription=temporary fixture\n[Service]\nExecStart=/fixture-only\n';
  await writeFile(unit, bytes, { mode: 0o600 }); await writeFile(foreign, 'KEEP', { mode: 0o600 }); await symlink(unit, link);
  const record = { schemaVersion: 1 as const, installationId: 'temporary', manager: 'systemd' as const, scope: 'user' as const, unit: 'temporary.service', directory: units,
    artifacts: [{ path: unit, digest: sha256(bytes), link: null }, { path: link, digest: sha256(unit), link: unit }] };
  const integrity = createHmacIntegrity('fixture', Buffer.alloc(32, 7));
  await writeFile(join(identity, 'native-service.json'), JSON.stringify({ body: record, keyId: integrity.keyId, mac: integrity.sign(JSON.stringify(record)) }), { mode: 0o600 });
  expect(await readNativeServiceRecord(identity, 'temporary', integrity, 65536)).toEqual(record);
  await expect(readNativeServiceRecord(identity, 'foreign', integrity, 65536)).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
  let active = true, also = 'customer.service'; const commands: string[][] = [];
  const exec = async (args: readonly string[]) => {
    commands.push([...args]);
    if (args[0] === 'stop') { active = false; return ''; }
    if (args[0] === 'daemon-reload') return '';
    expect(args[0]).toBe('show');
    const present = await lstat(unit).then(() => true, () => false), enabled = await lstat(link).then(() => true, () => false);
    return Object.entries({ LoadState: present ? 'loaded' : 'not-found', ActiveState: active ? 'active' : 'inactive', UnitFileState: enabled ? 'enabled' : present ? 'disabled' : '',
      MainPID: active ? '999999' : '0', FragmentPath: present ? unit : '', DropInPaths: '', Names: 'temporary.service', Also: also, Triggers: '', TriggeredBy: '', ConsistsOf: '', BoundBy: '', PropagatesStopTo: '', OnSuccess: '', OnFailure: '', ControlGroup: '' }).map(([key, value]) => `${key}=${value}`).join('\n');
  };
  const driver = new NativeServiceRemovalDriver(record, exec, (_service, work) => work(), 65536);
  const target = new InstallationServiceRemovalTarget([driver.service], driver), ref = { kind: target.kind, id: driver.service.resourceId };
  const request = { target: ref, operation: { id: 'installation.remove-service', version: 1 }, expectedVersion: (await target.observe(ref)).version, idempotencyKey: 'approved-native-card', input: null };
  await expect(target.apply(request)).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
  expect(commands.some(args => args[0] === 'stop')).toBe(false); expect(await readFile(foreign, 'utf8')).toBe('KEEP');
  also = ''; request.expectedVersion = (await target.observe(ref)).version; await target.apply(request);
  expect(commands.filter(args => args[0] === 'stop')).toEqual([['stop', '--', 'temporary.service']]);
  expect(commands.some(args => args[0] === 'disable')).toBe(false); // disable can cascade through Also=/aliases
  await expect(lstat(unit)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(foreign, 'utf8')).toBe('KEEP'); expect(await target.lookup(ref, 'approved-native-card')).toEqual({ status: 'applied', version: null });
});

it('refuses unsupported native managers with typed manual guidance rather than translating them into Linux deletions', async () => {
  const { assertNativeUninstallSupport } = await import('#adapters/core/installation-removal/index.js');
  for (const platform of ['darwin', 'win32']) expect(() => assertNativeUninstallSupport(platform)).toThrow(expect.objectContaining({ code: 'UNINSTALL_NATIVE_UNSUPPORTED' }));
  expect(() => assertNativeUninstallSupport('linux')).not.toThrow();
});

it('deletes only exact members bound to the verified backup: a failed backup, a changed byte, a replacement link or a new member after verification is never deleted', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: private native purge target'); return; }
  const { InstallationDataRemovalTarget } = await import('#adapters/core/installation-removal/index.js');
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'deckent-data-final-tail-')); roots.push(root);
  const directory = join(root, 'identity'), first = join(root, 'policy.json'), second = join(directory, 'identity.json'), foreign = join(root, 'customer'), set = join(root, 'set');
  for (const path of [directory, set]) await mkdir(path, { mode: 0o700 });
  for (const path of [first, second, foreign]) await writeFile(path, 'KEEP UNTIL BACKED UP', { mode: 0o600 });
  await writeFile(join(set, 'MANIFEST.sha256'), 'verified manifest', { mode: 0o600 });
  const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
  const target = new InstallationDataRemovalTarget('temporary', [{ resourceId: 'policy', path: first, directory: null },
    { resourceId: 'installationIdentity', path: second, directory }], [foreign]), ref = { kind: target.kind, id: 'global-data' };
  const snapshot = async () => ({ set, manifestDigest: sha('verified manifest'), members: await Promise.all([first, second].map(async path => {
    const info = await lstat(path); return { path, digest: sha(await readFile(path)), dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }; })) });
  const command = { target: ref, operation: { id: 'installation.remove-data', version: 1 }, idempotencyKey: 'approved-purge-card', expectedVersion: (await target.observe(ref)).version, input: null };
  target.prepare(async () => { throw new Error('BACKUP_VERIFICATION_FAILED'); });
  await expect(target.apply(command)).rejects.toThrow('BACKUP_VERIFICATION_FAILED');
  // M4: bytes written after the backup was verified are never deleted with the older backup.
  target.prepare(async () => { const bound = await snapshot(); await writeFile(second, 'NEWER BYTES'); return bound; });
  await expect(target.apply(command)).rejects.toMatchObject({ code: 'EFFECT_TARGET_PRECONDITION' });
  expect(await readFile(first, 'utf8')).toBe('KEEP UNTIL BACKED UP'); expect(await readFile(second, 'utf8')).toBe('NEWER BYTES');
  const saved = await readFile(second);
  target.prepare(async () => { const bound = await snapshot(); await rm(second); await symlink(foreign, second); return bound; });
  await expect(target.apply({ ...command, expectedVersion: (await target.observe(ref)).version })).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
  expect(await readFile(first, 'utf8')).toBe('KEEP UNTIL BACKED UP'); expect(await readFile(foreign, 'utf8')).toBe('KEEP UNTIL BACKED UP');
  await rm(second); await writeFile(second, saved, { mode: 0o600 });
  // M1: a new private file in the owner's directory is no member; it stays with its directory.
  await writeFile(join(directory, 'added'), 'NEW MEMBER', { mode: 0o600 });
  target.prepare(snapshot);
  await expect(target.apply({ ...command, expectedVersion: (await target.observe(ref)).version })).resolves.toEqual({ version: null });
  for (const path of [first, second]) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(directory, 'added'), 'utf8')).toBe('NEW MEMBER'); expect(await readFile(foreign, 'utf8')).toBe('KEEP UNTIL BACKED UP');
  expect(await target.lookup(ref, 'key')).toEqual({ status: 'applied', version: null });
});

it('keeps immutable tombstones across reinstall and never substitutes an old completed purge for a newly held partial one', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: private native completion custody'); return; }
  const { uninstallRecoveryDirectory, readUninstallTombstone, writeUninstallTombstone } = await import('#adapters/core/installation-removal/index.js');
  const { createUninstallPlan } = await import('#engine/core/installation/index.js');
  const { uninstallHoldPath } = await import('#platform/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-reinstalled-purge-')); roots.push(root);
  const data = join(root, 'global'); await mkdir(data, { mode: 0o700 });
  // §5.5: the recovery directory is the person's XDG state, outside the data root; the alpha.56 place beside it is read only while it alone exists.
  const env = { HOME: join(root, 'home') }, directory = uninstallRecoveryDirectory(data, env);
  expect(directory.startsWith(join(root, 'home', '.local', 'state', 'deckent', 'uninstall'))).toBe(true);
  const legacy = join(root, '.deckent-uninstall', createHash('sha256').update(data).digest('hex')); await mkdir(legacy, { recursive: true });
  expect(uninstallRecoveryDirectory(data, env)).toBe(legacy); expect(uninstallRecoveryDirectory(data, { ...env, XDG_STATE_HOME: join(root, 'state') })).toBe(legacy);
  await mkdir(directory, { mode: 0o700, recursive: true }); expect(uninstallRecoveryDirectory(data, env)).toBe(directory);
  const actor = { id: 'person', issuer: 'fixture', subject: 'person', assurance: 'os-user' as const, scopeIds: ['s'] };
  const plan = (id: string) => createUninstallPlan({ schemaVersion: 2, tier: 'all', force: false, disableUnit: false }, { installation: { id, root: data }, scopeSummary: ['s'], layoutRevision: 'l1', policyRevision: 'p1', inventoryRevision: id,
    resources: [], blockers: [], protectedPaths: [], deletionRoots: [data], backupDestination: join(root, 'backup'), packageRemoval: { command: null, shared: true }, ...observed });
  const finish = async (value: ReturnType<typeof plan>) => writeUninstallTombstone(directory, data, actor, value, { schemaVersion: 2, planDigest: value.planDigest,
    status: 'completed', items: [], recoveryLocation: directory, backup: value.backup, packageRemoval: value.packageRemoval, uncertain: [] });
  const first = plan('first'); await finish(first);
  const saved = await readFile(join(directory, `${first.planDigest}.tombstone.json`));
  expect((await readUninstallTombstone(directory, data, actor, 65536))?.plan.installation.id).toBe('first');
  await writeFile(uninstallHoldPath(data), 'unknown-new-purge', { mode: 0o600 });
  expect(await readUninstallTombstone(directory, data, actor, 65536)).toBeNull();
  const second = plan('second'); await finish(second); await rm(uninstallHoldPath(data));
  expect((await readUninstallTombstone(directory, data, actor, 65536))?.plan.installation.id).toBe('second');
  expect(await readFile(join(directory, `${first.planDigest}.tombstone.json`))).toEqual(saved);
});

it('reads Git tracking hardened: a hostile repository config runs nothing, tracked paths are kept, unreadable tracking keeps every project path', async () => {
  if (process.platform !== 'linux' || !existsSync('/usr/bin/git')) { console.info('verify-not-run: hardened Git probe needs Linux and /usr/bin/git'); return; }
  const { projectTracking } = await import('#adapters/core/installation-removal/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-uninstall-vcs-')); roots.push(root);
  const project = join(root, 'project'), data = join(project, '.deckent'), marker = join(root, 'marker'), bounds = { timeoutMs: 10_000, outputBytes: 65_536 };
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'policy.json'), 'TEAM', { mode: 0o600 }); await writeFile(join(data, 'ledger.db'), 'LOCAL', { mode: 0o600 });
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', project, ...args], { env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q'); git('add', '-f', '.deckent/policy.json');
  // The repository's own config asks Git to run a command (fsmonitor, hooks): the uninstall probe must never execute it.
  for (const [key, value] of [['core.fsmonitor', `touch ${marker}`], ['core.hooksPath', root]]) git('config', key, value!);
  const tracked = await projectTracking(project, data, '/usr/bin/git', bounds);
  expect(tracked(join(data, 'policy.json'))).toBe('vcs-tracked'); expect(tracked(data)).toBe('vcs-tracked'); expect(tracked(join(data, 'ledger.db'))).toBeNull();
  await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  // A Git that cannot answer inside a repository (here: not absolute / refusing) never makes a project path untracked.
  for (const configured of ['git', join(root, 'missing-git')]) {
    const unreadable = await projectTracking(project, data, configured, bounds);
    expect(unreadable(join(data, 'ledger.db'))).toBe('vcs-unverified'); expect(unreadable(join(root, 'global', 'ledger.db'))).toBeNull();
  }
});
