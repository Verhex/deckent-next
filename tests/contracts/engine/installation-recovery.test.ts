import { expect, it } from 'vitest';
import { createInstallationEvidencePreview, createInstallationRecovery, validateInstallationRecovery,
  InstallationPreviewApplication } from '#engine/core/installation/index.js';
import { encodeBootstrapJournal } from '#platform/core/bootstrap-state/index.js';
import { installationProfile } from '../support/installation-profile.js';

async function fixture() {
  const prepared = await new InstallationPreviewApplication({
    async resolvePaths(_root, config) { return { config: { ...config, normalized: 'private-value' },
      layout: { schemaVersion: 2, revision: 'layout-1', root: '/project/.deckent', bootstrapConfigPath: '/project/.deckent/config.json' },
      paths: { config: '/project/.deckent/config.json' } }; },
    validateProfile(profile) { return { imageId: String(profile.parameters.imageId) }; }, validateEvaluator() { return undefined; },
  }).prepare('/project', installationProfile(), { principal: { issuer: 'fixture-issuer', subject: 'fixture-subject' }, allowShutdown: false });
  const evidence = createInstallationEvidencePreview(prepared.preview, { name: 'deckent', version: '1',
    measurementDigest: 'c'.repeat(64), fileCount: 1, totalBytes: 1, missingDeclarations: [],
    source: 'installed-bytes', dependencyCoverage: 'excluded' }, prepared.preview.images.map(image => ({ imageId: image.imageId,
    endpoint: 'unix:///run/user/1000/docker.sock', daemonId: 'daemon-a', status: 'locally-available' })));
  const consent = { schemaVersion: 1, mode: 'operator-custom', id: 'operator-choice-1', atMs: 1,
    proposalDigest: evidence.proposalDigest, principal: prepared.preview.principal };
  return { prepared, evidence, consent };
}

it('embeds exact recoverable material and separately attributed custom consent in one bounded journal', async () => {
  const { prepared, evidence, consent } = await fixture();
  const recovery = createInstallationRecovery(prepared, evidence, consent);
  expect(recovery.evidence.publisherVerification).toBe('unverified');
  expect(recovery.material.configuration.normalized).toBe('private-value');
  expect(recovery.material.authoredProfile.configuration.normalized).toBeUndefined();
  expect(validateInstallationRecovery(JSON.parse(JSON.stringify(recovery)), prepared)).toEqual(recovery);
  const journal = JSON.parse(encodeBootstrapJournal({ schemaVersion: 2, transactionId: 'install-1',
    planDigest: prepared.preview.planDigest, profileDigest: prepared.preview.profile.digest,
    phase: 'pending', createdAtMs: 1, updatedAtMs: 1, blockers: ['INSTALLATION_NOT_APPLIED'],
    resources: [{ resource: 'config', path: prepared.preview.paths.config, preimageDigest: null,
      targetDigest: 'd'.repeat(64), state: 'pending' }], recovery }));
  expect(journal.recovery.consent).toEqual(consent);
  expect(journal.recovery.material.configuration.normalized).toBe('private-value');
});

it('rejects old proposal approval, a different operator, and altered evidence', async () => {
  const { prepared, evidence, consent } = await fixture();
  for (const altered of [{ ...consent, proposalDigest: 'f'.repeat(64) },
    { ...consent, principal: { ...consent.principal, subject: 'other-user' } }]) {
    expect(() => createInstallationRecovery(prepared, evidence, altered)).toThrow(expect.objectContaining({ code: 'INSTALLATION_RECOVERY_CONSENT' }));
  }
  expect(() => createInstallationRecovery(prepared, { ...evidence, package: { ...evidence.package, measurementDigest: 'd'.repeat(64) } }, consent))
    .toThrow(expect.objectContaining({ code: 'INSTALLATION_RECOVERY_CHANGED' }));
});

it('rejects persisted material drift even if the outer journal checksum could be recomputed', async () => {
  const { prepared, evidence, consent } = await fixture();
  const record = createInstallationRecovery(prepared, evidence, consent);
  const changed = { ...record, material: { ...record.material, configuration: { ...record.material.configuration, normalized: 'changed' } } };
  expect(() => validateInstallationRecovery(changed, prepared)).toThrow(expect.objectContaining({ code: 'INSTALLATION_RECOVERY_CHANGED' }));
  expect(() => validateInstallationRecovery({ ...record, unknown: true }, prepared))
    .toThrow(expect.objectContaining({ code: 'INSTALLATION_RECOVERY_INVALID' }));
});

it('never executes accessors in persisted recovery or supplied consent', async () => {
  const { prepared, evidence } = await fixture(); let called = false;
  const bad = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { called = true; return 1; } });
  expect(() => validateInstallationRecovery(bad, prepared)).toThrow();
  expect(() => createInstallationRecovery(prepared, evidence, bad)).toThrow();
  expect(called).toBe(false);
});
