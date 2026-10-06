import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach } from 'vitest';
import { hashInstallationProfilePayload } from '#engine/index.js';
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
export { fixture, rehash, unsupported };
