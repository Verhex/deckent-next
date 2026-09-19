import { describe, expect, it } from 'vitest';
import { InstallationPreviewApplication, encodeInstallationProfilePayload, hashInstallationProfilePayload,
  type InstallationPreviewPorts } from '../../../src/engine/core/installation/index.js';

const principal = { issuer: 'local-host', subject: '1000' };
const registry = { schemaVersion: 1 as const, revision: 'registry-1', profiles: [
  { id: 'node-small', version: 1, adapter: { id: 'docker', version: 2 }, parameters: { imageId: `sha256:${'a'.repeat(64)}`, argv: ['node', 'small.js'] } },
  { id: 'python-large', version: 2, adapter: { id: 'docker', version: 2 }, parameters: { imageId: `sha256:${'b'.repeat(64)}`, argv: ['python', 'large.py'] } },
], kinds: [
  { kind: 'node-task', profile: { id: 'node-small', version: 1 } },
  { kind: 'python-task', profile: { id: 'python-large', version: 2 } },
], evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] };
const pool = { schemaVersion: 1 as const, poolId: 'local-pool', capacity: { executionSlots: 8, inFlightSlots: 16 } };
const poolGrant = { id: 'pool-use', effect: 'allow' as const, actions: ['use'], scopes: ['local-scope'], principals: [principal],
  resource: { kind: 'pool', ids: ['local-pool'] } };
const shutdownGrant = { id: 'runtime-shutdown', effect: 'allow' as const, actions: ['shutdown'], scopes: ['local-scope'], principals: [principal],
  resource: { kind: 'service', ids: ['runtime'] } };
const configuration = { schema_version: 2, admission: { registry, poolId: 'local-pool', executionSlots: 4, inFlightSlots: 6,
  ordering: 'input-order' }, execution: { docker: {}, git: {} },
  service: { identity: { scopeId: 'local-scope', serviceId: 'runtime' } }, marker: 'normalized-default' };

function supplied(overrides: Record<string, unknown> = {}) {
  const payload = { schemaVersion: 1 as const, profile: { id: 'supplied-local', version: 1 }, scopeId: 'local-scope', configuration,
    policy: { schemaVersion: 1 as const, revision: 'policy-1', grants: [poolGrant, shutdownGrant], restrictions: [] }, pool,
    shutdown: { enabled: true }, ...overrides };
  return { ...payload, profile: { ...payload.profile, digest: hashInstallationProfilePayload(payload) } };
}
function ports(overrides: Partial<InstallationPreviewPorts> = {}): InstallationPreviewPorts {
  return {
    async resolvePaths(_root, config) { return { config, layout: { schemaVersion: 1, revision: 'layout-1', root: '/project/.deckent',
      bootstrapConfigPath: '/project/.deckent/config.json' }, paths: { config: '/project/.deckent/config.json', policy: '/project/.deckent/policy.json', ledger: '/project/.deckent/state/ledger.db' } }; },
    validateProfile(profile) { return { imageId: String(profile.parameters.imageId) }; },
    validateEvaluator() { return undefined; },
    ...overrides,
  };
}

describe('supplied installation profile preview', () => {
  it('canonically hashes bounded authored material independent of object key insertion order', () => {
    const first = supplied(), payload = { schemaVersion: first.schemaVersion, profile: { id: first.profile.id, version: first.profile.version },
      scopeId: first.scopeId, configuration: first.configuration, policy: first.policy, pool: first.pool, shutdown: first.shutdown };
    const reordered = { shutdown: payload.shutdown, pool: payload.pool, policy: payload.policy, configuration: payload.configuration,
      scopeId: payload.scopeId, profile: payload.profile, schemaVersion: payload.schemaVersion };
    expect(encodeInstallationProfilePayload(reordered)).toBe(encodeInstallationProfilePayload(payload));
    expect(hashInstallationProfilePayload(reordered)).toBe(first.profile.digest);
  });

  it('previews resolved paths, heterogeneous pinned images and explicit narrow grants without raw config', async () => {
    const preview = await new InstallationPreviewApplication(ports()).preview('/project', supplied(), { principal, allowShutdown: true });
    expect(preview).toMatchObject({ schemaVersion: 1, status: 'preview', profile: { id: 'supplied-local', version: 1, integrity: 'verified' },
      paths: { config: '/project/.deckent/config.json', policy: '/project/.deckent/policy.json' },
      pool, policy: { revision: 'policy-1', grants: [{ id: 'pool-use' }, { id: 'runtime-shutdown' }] },
      shutdown: { enabled: true, serviceIdentity: { scopeId: 'local-scope', serviceId: 'runtime' }, grantRuleId: 'runtime-shutdown' } });
    expect(preview.images.map(value => value.imageId)).toEqual([`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`]);
    expect(preview.blockers).toEqual(['INSTALL_PACKAGE_TRUST_UNVERIFIED', 'INSTALL_IMAGE_PROVENANCE_UNVERIFIED', 'INSTALL_IMAGE_AVAILABILITY_UNCHECKED']);
    expect(JSON.stringify(preview)).not.toContain('small.js');
    expect(JSON.stringify(preview)).not.toContain('normalized-default');
  });

  it('rejects changed profile bytes and an independent shutdown choice mismatch', async () => {
    const app = new InstallationPreviewApplication(ports()), profile = supplied();
    await expect(app.preview('/project', { ...profile, scopeId: 'changed' }, { principal, allowShutdown: true }))
      .rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_DIGEST' });
    await expect(app.preview('/project', profile, { principal, allowShutdown: false }))
      .rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_SHUTDOWN' });
  });

  it('allows shared pool capacity above per-run admission and rejects admission above the pool', async () => {
    const app = new InstallationPreviewApplication(ports());
    await expect(app.preview('/project', supplied(), { principal, allowShutdown: true })).resolves.toMatchObject({ pool });
    const tooLarge = { ...configuration, admission: { ...configuration.admission, executionSlots: 9 } };
    await expect(app.preview('/project', supplied({ configuration: tooLarge }), { principal, allowShutdown: true }))
      .rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_POOL' });
  });

  it('requires narrow explicit pool and shutdown grants that survive deny restrictions', async () => {
    const app = new InstallationPreviewApplication(ports());
    const broadShutdown = { ...shutdownGrant, principals: 'all' as const };
    const broadPolicy = { schemaVersion: 1 as const, revision: 'policy-2', grants: [poolGrant, broadShutdown], restrictions: [] };
    await expect(app.preview('/project', supplied({ policy: broadPolicy }), { principal, allowShutdown: true }))
      .rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_SHUTDOWN' });
    const deniedPolicy = { schemaVersion: 1 as const, revision: 'policy-3', grants: [poolGrant, shutdownGrant], restrictions: [{
      id: 'deny-pool', actions: ['use'], scopes: ['local-scope'], principals: [principal], resource: { kind: 'pool', ids: ['local-pool'] },
    }] };
    await expect(app.preview('/project', supplied({ policy: deniedPolicy }), { principal, allowShutdown: true }))
      .rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_POLICY' });
  });

  it('permits service descriptor identity while shutdown is disabled only when no matching allow grant exists', async () => {
    const noShutdownPolicy = { schemaVersion: 1 as const, revision: 'policy-4', grants: [poolGrant], restrictions: [] };
    const disabled = supplied({ policy: noShutdownPolicy, shutdown: { enabled: false } });
    await expect(new InstallationPreviewApplication(ports()).preview('/project', disabled, { principal, allowShutdown: false }))
      .resolves.toMatchObject({ shutdown: { enabled: false, serviceIdentity: { serviceId: 'runtime' }, grantRuleId: null } });
    const latent = supplied({ shutdown: { enabled: false }, configuration: { ...configuration, service: { identity: null } } });
    await expect(new InstallationPreviewApplication(ports()).preview('/project', latent, { principal, allowShutdown: false }))
      .rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_SHUTDOWN' });
  });
});

it('rejects accessor input before invoking a supplied getter', async () => {
  let invoked = false;
  const hostile = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { invoked = true; return 1; } });
  await expect(new InstallationPreviewApplication(ports()).preview('/project', hostile, { principal, allowShutdown: true }))
    .rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_INVALID' });
  expect(invoked).toBe(false);
});

it('binds plan identity to resolved paths and normalized configuration without leaking configuration', async () => {
  const base = supplied();
  const first = await new InstallationPreviewApplication(ports()).preview('/project', base, { principal, allowShutdown: true });
  const changed = ports(); const previous = changed.resolvePaths;
  changed.resolvePaths = async (root, config) => {
    const result = await previous(root, config);
    return { ...result, config: { ...result.config, marker: 'different-runtime-default' } };
  };
  const next = await new InstallationPreviewApplication(changed).preview('/project', base, { principal, allowShutdown: true });
  expect(next.profile.digest).toBe(first.profile.digest);
  expect(next.planDigest).not.toBe(first.planDigest);
  expect(JSON.stringify(next)).not.toContain('different-runtime-default');
});

it('prepares immutable normalized material without changing the authored profile digest or rendering private defaults', async () => {
  const authored = supplied(), originalDigest = authored.profile.digest;
  const application = new InstallationPreviewApplication(ports({
    async resolvePaths(_root, config) {
      return { config: { ...config, runtimeOnlyDefault: { credentialMarker: 'never-rendered' } }, layout: { schemaVersion: 1,
        revision: 'layout-prepared', root: '/resolved/data', bootstrapConfigPath: '/project/.deckent/config.json' },
      paths: { config: '/project/.deckent/config.json', policy: '/resolved/data/policy.json' } };
    },
  }));
  const prepared = await application.prepare('/project', authored, { principal, allowShutdown: true });
  expect(prepared.material.authoredProfile.profile.digest).toBe(originalDigest);
  expect(hashInstallationProfilePayload({ ...prepared.material.authoredProfile,
    profile: { id: prepared.material.authoredProfile.profile.id, version: prepared.material.authoredProfile.profile.version } })).toBe(originalDigest);
  expect(prepared.material.authoredProfile.configuration).not.toHaveProperty('runtimeOnlyDefault');
  expect(prepared.material.configuration).toMatchObject({ runtimeOnlyDefault: { credentialMarker: 'never-rendered' } });
  expect(Object.isFrozen(prepared.material.configuration)).toBe(true);
  expect(Object.isFrozen((prepared.material.configuration['runtimeOnlyDefault'] as object))).toBe(true);
  expect(() => { (prepared.material.configuration as { runtimeOnlyDefault: unknown }).runtimeOnlyDefault = null; }).toThrow();
  expect(prepared.preview.layout).toMatchObject({ root: '/resolved/data', revision: 'layout-prepared' });
  expect(JSON.stringify(prepared.preview)).not.toContain('runtimeOnlyDefault');
  expect(JSON.stringify(prepared.preview)).not.toContain('never-rendered');
});

it('rejects an invalid authored profile before asking the resolver for normalized material', async () => {
  let resolves = 0;
  const invalid = supplied(); invalid.scopeId = 'changed-without-rehash';
  const application = new InstallationPreviewApplication(ports({ async resolvePaths() { resolves++; throw new Error('MUST_NOT_RESOLVE'); } }));
  await expect(application.prepare('/project', invalid, { principal, allowShutdown: true })).rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_DIGEST' });
  expect(resolves).toBe(0);
});

it('returns deeply frozen permission, pool, service and kind bindings', async () => {
  const result = await new InstallationPreviewApplication(ports()).preview('/project', supplied(), { principal, allowShutdown: true });
  expect(result.registry.kinds).toEqual(registry.kinds);
  expect(Object.isFrozen(result.pool.capacity)).toBe(true);
  expect(Object.isFrozen(result.shutdown.serviceIdentity)).toBe(true);
  expect(Object.isFrozen(result.registry.kinds[0]!.profile)).toBe(true);
  expect(Object.isFrozen(result.policy.grants[0]!.resource)).toBe(true);
  expect(() => { (result.pool.capacity as { executionSlots: number }).executionSlots = 100; }).toThrow();
});

it('rejects an additional latent shutdown grant despite one exact narrow grant', async () => {
  const extra = { ...shutdownGrant, id: 'extra-service', resource: { kind: 'service', ids: ['other-service'] } };
  const policy = { schemaVersion: 1, revision: 'extra-policy', grants: [poolGrant, shutdownGrant, extra], restrictions: [] };
  await expect(new InstallationPreviewApplication(ports()).preview('/project', supplied({ policy }), { principal, allowShutdown: true }))
    .rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_SHUTDOWN' });
});
