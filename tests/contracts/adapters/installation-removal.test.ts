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
