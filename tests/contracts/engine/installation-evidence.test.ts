import { expect, it } from 'vitest';
import { createInstallationEvidencePreview, InstallationEvidenceApplication, InstallationPreviewApplication,
  type InstallationImageEvidence, type InstallationPackageEvidence, type InstallationPreview } from '#engine/core/installation/index.js';
import { installationProfile } from '../support/installation-profile.js';

const image = (character: string) => `sha256:${character.repeat(64)}`;
const packageEvidence: InstallationPackageEvidence = { name: 'deckent', version: '1', measurementDigest: 'c'.repeat(64),
  fileCount: 1, totalBytes: 1, missingDeclarations: [], source: 'installed-bytes', dependencyCoverage: 'excluded' };
const imageEvidence = (imageId: string, daemonId = 'daemon-a'): InstallationImageEvidence => ({ imageId,
  endpoint: 'unix:///run/user/1000/docker.sock', daemonId, status: 'locally-available' });

async function preview(images = [image('a'), image('b')]): Promise<InstallationPreview> {
  return new InstallationPreviewApplication({
    async resolvePaths(_projectRoot, config) { return { config, layout: { schemaVersion: 2, revision: 'layout-1', root: '/project/.deckent',
      bootstrapConfigPath: '/project/.deckent/config.json' }, paths: { config: '/project/.deckent/config.json' } }; },
    validateProfile(profile) { return { imageId: String(profile.parameters.imageId) }; },
    validateEvaluator() { return undefined; },
  }).preview('/project', installationProfile({ images }), { principal: { issuer: 'fixture-issuer', subject: 'fixture-subject' }, allowShutdown: false });
}

it('binds proposal identity to profile plan, package measurement, endpoint, daemon, and exact unique image coverage', async () => {
  const source = await preview(), first = createInstallationEvidencePreview(source, packageEvidence, [imageEvidence(image('b')), imageEvidence(image('a'))]);
  const changedPackage = createInstallationEvidencePreview(source, { ...packageEvidence, measurementDigest: 'd'.repeat(64) }, [imageEvidence(image('a')), imageEvidence(image('b'))]);
  expect(first).toMatchObject({ schemaVersion: 1, status: 'evidence-preview', preview: { planDigest: source.planDigest },
    package: { measurementDigest: packageEvidence.measurementDigest }, images: [{ imageId: image('a'), daemonId: 'daemon-a' }, { imageId: image('b') }] });
  expect(changedPackage.proposalDigest).not.toBe(first.proposalDigest);
  await expect(Promise.resolve().then(() => createInstallationEvidencePreview(source, packageEvidence, [imageEvidence(image('a')), imageEvidence(image('a'))])))
    .rejects.toMatchObject({ code: 'INSTALLATION_EVIDENCE_IMAGES' });
  await expect(Promise.resolve().then(() => createInstallationEvidencePreview(source, packageEvidence, [imageEvidence(image('a')), imageEvidence(image('b'), 'daemon-b')])))
    .rejects.toMatchObject({ code: 'INSTALLATION_EVIDENCE_IMAGES' });
});

it('canonicalizes image order while recording no availability approval or publisher verification', async () => {
  const source = await preview();
  const forward = createInstallationEvidencePreview(source, packageEvidence, [imageEvidence(image('a')), imageEvidence(image('b'))]);
  const reverse = createInstallationEvidencePreview(source, packageEvidence, [imageEvidence(image('b')), imageEvidence(image('a'))]);
  expect(reverse.proposalDigest).toBe(forward.proposalDigest);
  expect(forward).toMatchObject({ operatorApproval: 'not-recorded', publisherVerification: 'unverified' });
});

it('does not invoke accessors and freezes nested observation data', async () => {
  const source = await preview(); let invoked = false;
  const hostile = Object.defineProperty({}, 'status', { enumerable: true, get() { invoked = true; return 'preview'; } });
  expect(() => createInstallationEvidencePreview(hostile as InstallationPreview, packageEvidence, [])).toThrow(expect.objectContaining({ code: 'INSTALLATION_EVIDENCE_INVALID' }));
  expect(invoked).toBe(false);
  const result = createInstallationEvidencePreview(source, packageEvidence, [imageEvidence(image('a')), imageEvidence(image('b'))]);
  expect(Object.isFrozen(result.package)).toBe(true);
  expect(Object.isFrozen(result.images[0])).toBe(true);
  expect(() => { (result.package as { totalBytes: number }).totalBytes = 2; }).toThrow();
});

it('remeasures package bytes after deduplicated probes and rejects changed installed bytes', async () => {
  const source = await preview([image('a'), image('a')]); let measurements = 0; const probes: string[] = [];
  const application = new InstallationEvidenceApplication({
    async preview() { return source; },
    async measurePackage() { measurements++; return packageEvidence; },
    async inspectImage(imageId) { probes.push(imageId); return imageEvidence(imageId); },
  });
  await expect(application.inspect()).resolves.toMatchObject({ status: 'evidence-preview' });
  expect(measurements).toBe(2); expect(probes).toEqual([image('a')]);
  let measured = 0;
  await expect(new InstallationEvidenceApplication({
    async preview() { return source; },
    async measurePackage() { return { ...packageEvidence, measurementDigest: (++measured === 1 ? 'c' : 'd').repeat(64) }; },
    async inspectImage(imageId) { return imageEvidence(imageId); },
  }).inspect()).rejects.toMatchObject({ code: 'INSTALLATION_EVIDENCE_CHANGED' });
});
