import { hostname, tmpdir, userInfo } from 'node:os';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hashInstallationProfilePayload } from '#engine/core/installation/index.js';
import { previewSuppliedInstallation } from '#composition/core/installation/index.js';
import { installationProfile } from '../support/installation-profile.js';

function bound(input = installationProfile()) {
  const principal = { issuer: hostname(), subject: String(userInfo().uid) };
  const profile = structuredClone(input);
  profile.policy.grants = profile.policy.grants.map(grant => ({ ...grant, principals: [principal] }));
  return rehash(profile);
}

function rehash<T extends ReturnType<typeof installationProfile>>(profile: T): T {
  profile.profile.digest = hashInstallationProfilePayload({ ...profile, profile: { id: profile.profile.id, version: profile.profile.version } });
  return profile;
}

it('previews a supplied profile without creating a missing project or echoing configuration secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-install-preview-')); const project = join(root, 'absent');
  try {
    const profile = bound(installationProfile({ root: join(root, 'relocated') }));
    (profile.configuration as Record<string, unknown>)['secret'] = 'not-allowed';
    profile.profile.digest = hashInstallationProfilePayload({ ...profile, profile: { id: profile.profile.id, version: profile.profile.version } });
    await expect(previewSuppliedInstallation(project, profile, { allowShutdown: false })).rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_CONFIG' });
    await expect(access(project)).rejects.toBeDefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('returns relocated bootstrap paths and heterogeneous pinned images from a valid supplied profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-install-preview-')); const project = join(root, 'absent');
  try {
    const profile = bound(installationProfile({ root: join(root, 'relocated'), images: [`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`] }));
    const preview = await previewSuppliedInstallation(project, profile, { allowShutdown: false });
    expect(preview).toMatchObject({ status: 'preview', layout: { root: join(root, 'relocated'), bootstrapConfigPath: join(project, '.deckent/config.json') }, images: [{ imageId: `sha256:${'a'.repeat(64)}` }, { imageId: `sha256:${'b'.repeat(64)}` }] });
    expect(JSON.stringify(preview)).not.toContain('secret'); await expect(access(project)).rejects.toBeDefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects untrusted profile integrity and an ungranted shutdown selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-install-preview-')); const project = join(root, 'absent');
  try {
    const profile = bound();
    await expect(previewSuppliedInstallation(project, { ...profile, profile: { ...profile.profile, digest: '0'.repeat(64) } }, { allowShutdown: false }))
      .rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_DIGEST' });
    await expect(previewSuppliedInstallation(project, profile, { allowShutdown: true })).rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_SHUTDOWN' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects a profile whose pool grant is not bound to the actual local identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-install-preview-')); const project = join(root, 'absent');
  try {
    const profile = bound();
    profile.policy.grants = profile.policy.grants.map(grant => ({ ...grant,
      principals: [{ issuer: 'another-issuer', subject: 'another-subject' }] }));
    await expect(previewSuppliedInstallation(project, rehash(profile), { allowShutdown: false }))
      .rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_POLICY' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reports unsupported installed adapters and evaluators with typed profile errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-install-preview-')); const project = join(root, 'absent');
  try {
    const unsupportedAdapter = bound();
    unsupportedAdapter.configuration.admission.registry.profiles[0]!.adapter.version = 99;
    await expect(previewSuppliedInstallation(project, rehash(unsupportedAdapter), { allowShutdown: false }))
      .rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_ADAPTER' });

    const unsupportedEvaluator = bound();
    unsupportedEvaluator.configuration.admission.registry.evaluators[0]!.implementation = { id: 'other-exit', version: 1 };
    await expect(previewSuppliedInstallation(project, rehash(unsupportedEvaluator), { allowShutdown: false }))
      .rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_EVALUATOR' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects a narrowly granted shutdown when a matching restriction denies it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-install-preview-')); const project = join(root, 'absent');
  try {
    const profile = bound(installationProfile({ shutdown: true }));
    const principal = { issuer: hostname(), subject: String(userInfo().uid) };
    profile.policy.restrictions.push({ id: 'deny-shutdown', actions: ['shutdown'], scopes: ['scope-1'], principals: [principal],
      resource: { kind: 'service', ids: ['service-1'] } });
    await expect(previewSuppliedInstallation(project, rehash(profile), { allowShutdown: true }))
      .rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_SHUTDOWN' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('accepts a pool larger than per-run demand and rejects a smaller pool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-install-preview-')); const project = join(root, 'absent');
  try {
    const largerPool = bound();
    largerPool.pool.capacity = { executionSlots: 2, inFlightSlots: 2 };
    await expect(previewSuppliedInstallation(project, rehash(largerPool), { allowShutdown: false })).resolves.toMatchObject({ status: 'preview' });

    const smallerPool = bound();
    smallerPool.configuration.admission.executionSlots = 2;
    smallerPool.configuration.admission.inFlightSlots = 2;
    await expect(previewSuppliedInstallation(project, rehash(smallerPool), { allowShutdown: false }))
      .rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_POOL' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects a profile without an execution configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-install-preview-')); const project = join(root, 'absent');
  try {
    const profile = bound();
    delete (profile.configuration as Record<string, unknown>).execution;
    await expect(previewSuppliedInstallation(project, rehash(profile), { allowShutdown: false }))
      .rejects.toMatchObject({ code: 'INSTALLATION_PROFILE_CONFIG' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
