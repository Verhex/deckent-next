import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { immutableJsonObjectSchema } from '#domain/index.js';
import { hashInstallationProfilePayload } from '#engine/index.js';
import { validateConfig, versionedConfig } from '#platform/index.js';
import { applyInstallation, inspectInstallation } from '../../../src/index.js';
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
  if (!configuredImage) throw new Error('DECKENT_TEST_DOCKER_IMAGE is required for installation apply integration tests');
  const root = await mkdtemp(join(tmpdir(), 'deckent-install-apply-'));
  roots.push(root); await chmod(root, 0o700);
  const project = join(root, 'project'), data = join(root, 'relocated-data'), profilePath = join(root, 'profile.json');
  await mkdir(project, { mode: 0o700 });
  const profile = installationProfile({ root: data, images: [configuredImage!] });
  const principal = { issuer: hostname(), subject: String(userInfo().uid) };
  profile.policy.grants = profile.policy.grants.map(grant => ({ ...grant, principals: [principal] }));
  profile.configuration.execution.docker.executable = '/usr/bin/docker';
  await writeFile(profilePath, JSON.stringify(rehash(profile)), { mode: 0o600 });
  const env = { HOME: join(root, 'home'), PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const run = (args: string[]) => execute(process.execPath, [cli, ...args], { cwd: project, env, timeout: 45_000, maxBuffer: 1_048_576 });
  return { root, project, data, profilePath, profile, run };
}
const unsupported = process.platform !== 'linux';

it.skipIf(unsupported).each([0o700, 0o775])('publishes a relocated installation in project mode %s through SDK and replays through compiled CLI', async mode => {
  const f = await fixture(); await chmod(f.project, mode);
  const control = { allowShutdown: false, dockerExecutable: '/usr/bin/docker' };
  const evidence = await inspectInstallation(f.project, f.profile, control);
  const installed = await applyInstallation(f.project, f.profile, { ...control, proposalDigest: evidence.proposalDigest, acceptCustom: true });
  expect(installed).toMatchObject({ schemaVersion: 1, status: 'installed', proposalDigest: evidence.proposalDigest,
    trust: { mode: 'operator-custom', publisherVerification: 'unverified' }, paths: {
      config: join(f.project, '.deckent/config.json'), installationJournal: join(f.project, '.deckent/installation/journal.json'),
      policy: join(f.data, 'policy.json'), ledger: join(f.data, 'state/ledger.db') } });

  expect((await lstat(f.project)).mode & 0o777).toBe(mode);
  expect((await lstat(join(f.project, '.deckent/installation/journal.json'))).mode & 0o777).toBe(0o600);
  const config = JSON.parse(await readFile(join(f.project, '.deckent/config.json'), 'utf8'));
  const journal = JSON.parse(await readFile(join(f.project, '.deckent/installation/journal.json'), 'utf8'));
  expect(config.layout.root).toBe(f.data);
  expect(JSON.parse(await readFile(join(f.data, 'policy.json'), 'utf8'))).toEqual(f.profile.policy);
  expect(journal).toMatchObject({ schemaVersion: 2, transactionId: installed.transactionId, phase: 'committed', blockers: [],
    resources: expect.arrayContaining(['config', 'policy', 'ledger'].map(resource => expect.objectContaining({ resource, state: 'published' }))) });
  const db = new DatabaseSync(join(f.data, 'state/ledger.db'), { readOnly: true });
  try {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION);
    expect(db.prepare('SELECT count(*) AS count FROM installation_ownership').get()?.count).toBe(1);
    expect(JSON.parse(String(db.prepare('SELECT policy FROM execution_pools WHERE pool_id=?').get('pool-1')?.policy))).toEqual(f.profile.pool);
  } finally { db.close(); }

  await rm(f.profilePath);
  const replayed = JSON.parse((await f.run(['init', 'resume', '--docker-executable', '/usr/bin/docker', '--proposal', evidence.proposalDigest,
    '--accept-custom', '--json'])).stdout);
  expect(replayed).toMatchObject({ status: 'replayed', transactionId: installed.transactionId, proposalDigest: evidence.proposalDigest,
    trust: { mode: 'operator-custom', publisherVerification: 'unverified' } });
// Inspect + apply + a compiled-CLI replay measured 27.5-28.1 s on this host and 30.4 s under a running local model server.
}, 90_000);

it.skipIf(unsupported)('rejects a changed proposal or absent custom consent before publishing a target', async () => {
  const changed = await fixture();
  await expect(applyInstallation(changed.project, changed.profile, { allowShutdown: false, dockerExecutable: '/usr/bin/docker',
    proposalDigest: '0'.repeat(64), acceptCustom: true })).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CHANGED' });
  await expect(readFile(join(changed.project, '.deckent/config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(changed.data, 'policy.json'))).rejects.toMatchObject({ code: 'ENOENT' });

  const noConsent = await fixture();
  await expect(noConsent.run(['init', 'apply', '--profile', noConsent.profilePath, '--docker-executable', '/usr/bin/docker',
    '--proposal', '0'.repeat(64), '--json'])).rejects.toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('CLI_USAGE') });
  await expect(readFile(join(noConsent.project, '.deckent/config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(noConsent.data, 'policy.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(unsupported)('never overwrites pre-existing config or policy bytes', async () => {
  const f = await fixture(), config = join(f.project, '.deckent/config.json'), policy = join(f.data, 'policy.json');
  await mkdir(resolve(config, '..'), { recursive: true, mode: 0o700 });
  await mkdir(resolve(policy, '..'), { recursive: true, mode: 0o700 });
  await writeFile(config, '{"foreign":"config"}\n', { mode: 0o600 });
  await writeFile(policy, '{"foreign":"policy"}\n', { mode: 0o600 });
  const beforeConfig = await readFile(config), beforePolicy = await readFile(policy);
  const evidence = await inspectInstallation(f.project, f.profile, { allowShutdown: false, dockerExecutable: '/usr/bin/docker' });
  await expect(applyInstallation(f.project, f.profile, { allowShutdown: false, dockerExecutable: '/usr/bin/docker',
    proposalDigest: evidence.proposalDigest, acceptCustom: true })).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });
  expect(await readFile(config)).toEqual(beforeConfig);
  expect(await readFile(policy)).toEqual(beforePolicy);
});

it.skipIf(unsupported)('adopts exact approved config and policy bytes without replacing their files', async () => {
  const f = await fixture(), control = { allowShutdown: false, dockerExecutable: '/usr/bin/docker' };
  const evidence = await inspectInstallation(f.project, f.profile, control);
  const content = (value: unknown) => `${JSON.stringify(immutableJsonObjectSchema.parse(value))}\n`;
  const selected = ([
    { resource: 'config' as const, path: evidence.preview.paths.config,
      content: content(validateConfig(versionedConfig(f.profile.configuration)).config) },
    { resource: 'policy' as const, path: evidence.preview.paths.policy, content: content(f.profile.policy) },
  ]).map(target => ({ ...target, digest: createHash('sha256').update(target.content, 'utf8').digest('hex') }));
  for (const target of selected) {
    await mkdir(resolve(target.path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(target.path, target.content, { mode: 0o600 });
  }
  const before = new Map(await Promise.all(selected.map(async target => [target.resource,
    { bytes: await readFile(target.path), stat: await lstat(target.path) }] as const)));

  const installed = await applyInstallation(f.project, f.profile, { ...control, proposalDigest: evidence.proposalDigest, acceptCustom: true });
  expect(installed.status).toBe('installed');
  const journal = JSON.parse(await readFile(join(f.project, '.deckent/installation/journal.json'), 'utf8'));
  for (const target of selected) {
    const prior = before.get(target.resource)!; const after = await lstat(target.path);
    expect(await readFile(target.path)).toEqual(prior.bytes);
    expect([after.dev, after.ino]).toEqual([prior.stat.dev, prior.stat.ino]);
    expect(journal.resources).toContainEqual(expect.objectContaining({ resource: target.resource,
      preimageDigest: target.digest, targetDigest: target.digest, state: 'published' }));
  }
});

it.skipIf(unsupported || userInfo().uid === 0)('resumes a real pending publication without the external profile after fixing owned directory permissions', async () => {
  const f = await fixture(), control = { allowShutdown: false, dockerExecutable: '/usr/bin/docker' };
  const evidence = await inspectInstallation(f.project, f.profile, control);
  await mkdir(f.data, { mode: 0o700 }); await chmod(f.data, 0o555);
  await expect(applyInstallation(f.project, f.profile, { ...control, proposalDigest: evidence.proposalDigest, acceptCustom: true })).rejects.toBeDefined();

  const journalPath = join(f.project, '.deckent/installation/journal.json');
  const pending = JSON.parse(await readFile(journalPath, 'utf8'));
  expect(pending).toMatchObject({ schemaVersion: 2, phase: 'pending', planDigest: evidence.preview.planDigest,
    profileDigest: f.profile.profile.digest, blockers: ['INSTALLATION_NOT_APPLIED'],
    resources: expect.arrayContaining(['config', 'policy', 'ledger'].map(resource => expect.objectContaining({ resource, state: 'pending' }))),
    recovery: { schemaVersion: 1, material: { authoredProfile: f.profile, allowShutdown: false },
      consent: { mode: 'operator-custom', proposalDigest: evidence.proposalDigest } } });
  expect(pending.transactionId).toBe(pending.recovery.consent.id);
  await expect(readFile(join(f.data, 'policy.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(f.data, 'state/ledger.db'))).rejects.toMatchObject({ code: 'ENOENT' });

  await rm(f.profilePath); await chmod(f.data, 0o700);
  const installed = JSON.parse((await f.run(['init', 'resume', '--docker-executable', '/usr/bin/docker', '--proposal', evidence.proposalDigest,
    '--accept-custom', '--json'])).stdout);
  expect(installed).toMatchObject({ status: 'installed', transactionId: pending.transactionId, proposalDigest: evidence.proposalDigest,
    trust: { mode: 'operator-custom', publisherVerification: 'unverified' } });
  expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({ transactionId: pending.transactionId, phase: 'committed', blockers: [] });
});
