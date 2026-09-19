import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { hashInstallationProfilePayload } from '#engine/index.js';
import { inspectInstallation } from '../../../src/index.js';
import { installationProfile } from '../support/installation-profile.js';

const execute = promisify(execFile), cli = resolve('dist/composition/core/cli/internal/entry.js');
const configuredImage = process.env.DECKENT_TEST_DOCKER_IMAGE;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function rehash<T extends ReturnType<typeof installationProfile>>(profile: T): T {
  profile.profile.digest = hashInstallationProfilePayload({ ...profile, profile: { id: profile.profile.id, version: profile.profile.version } });
  return profile;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-install-inspect-')); roots.push(root);
  const project = join(root, 'project'), otherProject = join(root, 'other-project'), profilePath = join(root, 'profile.json');
  await mkdir(project); await mkdir(otherProject);
  const profile = installationProfile({ images: [configuredImage!] });
  const principal = { issuer: hostname(), subject: String(userInfo().uid) };
  profile.policy.grants = profile.policy.grants.map(grant => ({ ...grant, principals: [principal] }));
  profile.configuration.execution.docker.executable = '/usr/bin/docker';
  await writeFile(profilePath, JSON.stringify(rehash(profile)), { mode: 0o600 });
  const env = { ...process.env, HOME: join(root, 'home') };
  const run = (args: string[], cwd = project) => execute(process.execPath, [cli, ...args], { cwd, env, timeout: 30_000, maxBuffer: 1_048_576 });
  return { root, project, otherProject, profilePath, profile, run };
}

it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/docker') || !configuredImage)('uses explicit local Docker evidence through compiled CLI and SDK without creating product state', async () => {
  const f = await fixture();
  const cliResult = JSON.parse((await f.run(['init', 'inspect', '--profile', f.profilePath, '--docker-executable', '/usr/bin/docker', '--json'])).stdout);
  const trustedControl = { allowShutdown: false, dockerExecutable: '/usr/bin/docker' };
  const sdkFirst = await inspectInstallation(f.project, f.profile, trustedControl);
  const sdkAgain = await inspectInstallation(f.project, f.profile, trustedControl);
  expect(cliResult).toMatchObject({ status: 'evidence-preview', proposalDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    images: [{ imageId: configuredImage, status: 'locally-available' }], package: { source: 'installed-bytes', dependencyCoverage: 'excluded' },
    operatorApproval: 'not-recorded', publisherVerification: 'unverified' });
  expect(sdkAgain.proposalDigest).toBe(sdkFirst.proposalDigest);
  expect(cliResult.proposalDigest).toBe(sdkFirst.proposalDigest);
  expect(JSON.stringify(sdkFirst.package)).not.toContain(f.root);
  expect(await readdir(f.project)).toEqual([]);

  const changedPolicy = structuredClone(f.profile); changedPolicy.policy.revision = 'policy-changed';
  const changed = await inspectInstallation(f.project, rehash(changedPolicy), trustedControl);
  expect(changed.preview.planDigest).not.toBe(sdkFirst.preview.planDigest);
  const relocatedProject = await inspectInstallation(f.otherProject, f.profile, trustedControl);
  expect(relocatedProject.preview.planDigest).not.toBe(sdkFirst.preview.planDigest);
  expect(await readdir(f.project)).toEqual([]); expect(await readdir(f.otherProject)).toEqual([]);
});

it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/docker') || !configuredImage)('returns typed CLI failure without stdout for malformed external profiles or unknown images', async () => {
  const f = await fixture();
  await writeFile(f.profilePath, '{', { mode: 0o600 });
  await expect(f.run(['init', 'inspect', '--profile', f.profilePath, '--docker-executable', '/usr/bin/docker', '--json'])).rejects.toMatchObject({ code: 78, stdout: '' });
  const unknown = installationProfile({ images: [`sha256:${'b'.repeat(64)}`] });
  const principal = { issuer: hostname(), subject: String(userInfo().uid) };
  unknown.policy.grants = unknown.policy.grants.map(grant => ({ ...grant, principals: [principal] }));
  unknown.configuration.execution.docker.executable = '/usr/bin/docker';
  await writeFile(f.profilePath, JSON.stringify(rehash(unknown)), { mode: 0o600 });
  await expect(inspectInstallation(f.project, unknown, { allowShutdown: false, dockerExecutable: '/usr/bin/docker' }))
    .rejects.toMatchObject({ code: 'DOCKER_IMAGE_PROBE_UNAVAILABLE' });
  await expect(f.run(['init', 'inspect', '--profile', f.profilePath, '--docker-executable', '/usr/bin/docker', '--json'])).rejects.toMatchObject({ code: 78, stdout: '' });
  expect(await readdir(f.project)).toEqual([]);
});

it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/docker') || !configuredImage)('requires trusted caller control and never selects a valid-digest profile executable', async () => {
  const f = await fixture();
  await expect(f.run(['init', 'inspect', '--profile', f.profilePath, '--json'])).rejects.toMatchObject({ code: 78, stdout: '' });
  const marker = join(f.root, 'profile-command-ran'), maliciousExecutable = join(f.root, 'profile-command');
  await writeFile(maliciousExecutable, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o700 });
  f.profile.configuration.execution.docker.executable = maliciousExecutable;
  await writeFile(f.profilePath, JSON.stringify(rehash(f.profile)), { mode: 0o600 });
  await expect(f.run(['init', 'inspect', '--profile', f.profilePath, '--docker-executable', '/usr/bin/docker', '--json']))
    .rejects.toMatchObject({ code: 78, stdout: '' });
  await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(f.project)).toEqual([]);
});
