import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashInstallationProfilePayload } from '#engine/core/installation/index.js';
import { installationProfile } from '../support/installation-profile.js';
import { childEnv } from '../support/child-env.js';
import { owned } from '../support/owned.js';

const cli = resolve('dist/composition/core/cli/internal/entry.js');
async function fixture(shutdown = false) {
  const root = await owned().root('deckent-install-cli-');
  const project = join(root, 'project'), path = join(root, 'profile.json'); await mkdir(project);
  const profile = installationProfile({ root: join(root, 'data'), shutdown });
  const principal = { issuer: hostname(), subject: String(userInfo().uid) };
  for (const grant of profile.policy.grants) grant.principals = [principal];
  profile.profile.digest = hashInstallationProfilePayload({ ...profile, profile: { id: profile.profile.id, version: profile.profile.version } });
  await writeFile(path, JSON.stringify(profile), { mode: 0o600 });
  const env = childEnv({ HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), DECKENT_HOME: join(root, 'wrong-data-root') });
  const run = (args: string[]) => owned().exec(process.execPath, [cli, ...args], { cwd: project, env, deadlineMs: 5000, outputBytes: 1048576, label: args.slice(0, 2).join(' ') });
  return { root, project, path, profile, run };
}

describe.skipIf(process.platform === 'win32')('requires POSIX local principal; AUTHENTICATION_REQUIRED on Windows UID -1', () => {
it('compiled CLI reads the real supplied profile and previews exact paths without creating product state', async () => {
  const f = await fixture();
  const result = JSON.parse((await f.run(['init', 'preview', '--profile', f.path, '--json'])).stdout);
  expect(result).toMatchObject({ status: 'preview', profile: { digest: f.profile.profile.digest, integrity: 'verified' },
    layout: { root: join(f.root, 'data'), bootstrapConfigPath: join(f.project, '.deckent', 'config.json') }, shutdown: { enabled: false } });
  expect(result.blockers).toContain('INSTALL_IMAGE_PROVENANCE_UNVERIFIED');
  expect(result.registry.kinds).toEqual([{ kind: 'kind-1', profile: { id: 'docker-1', version: 1 } }]);
  expect(await readdir(f.project)).toEqual([]);
  expect(await readdir(f.root)).toEqual(expect.arrayContaining(['project', 'profile.json']));
  expect((await readdir(f.root)).sort()).toEqual(['profile.json', 'project']);
});

it('compiled CLI requires independent shutdown choice and still reports preview only', async () => {
  const f = await fixture(true);
  await expect(f.run(['init', 'preview', '--profile', f.path, '--json'])).rejects.toMatchObject({ code: 78 });
  const result = JSON.parse((await f.run(['init', 'preview', '--profile', f.path, '--allow-shutdown', '--json'])).stdout);
  expect(result).toMatchObject({ status: 'preview', shutdown: { enabled: true, grantRuleId: 'shutdown' } });
  expect(await readdir(f.project)).toEqual([]);
});

it('compiled CLI rejects modified profile content without a write or fake built-in fallback', async () => {
  const f = await fixture(); f.profile.pool.capacity.executionSlots = 2;
  await writeFile(f.path, JSON.stringify(f.profile));
  await expect(f.run(['init', 'preview', '--profile', f.path, '--json'])).rejects.toMatchObject({ code: 78 });
  await expect(f.run(['init', 'preview', '--json'])).rejects.toMatchObject({ code: 78 });
  expect(await readdir(f.project)).toEqual([]);
});

it('compiled CLI refuses a require-approval pool grant with its own typed config-category exit, not the shared policy exit code (C12 Q8 follow-up, owner 2026-09-27)', async () => {
  const f = await fixture();
  f.profile.policy.grants = f.profile.policy.grants.map(grant => grant.id === 'pool' ? { ...grant, effect: 'require-approval' as const } : grant);
  f.profile.profile.digest = hashInstallationProfilePayload({ ...f.profile, profile: { id: f.profile.profile.id, version: f.profile.profile.version } });
  await writeFile(f.path, JSON.stringify(f.profile));
  let observed = false;
  try { await f.run(['init', 'preview', '--profile', f.path, '--json']); }
  catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    expect(failure.code).toBe(78); expect(failure.stdout).toBe('');
    expect(JSON.parse(failure.stderr)).toMatchObject({ code: 'INSTALLATION_PROFILE_APPROVAL_UNSUPPORTED' }); observed = true;
  }
  expect(observed).toBe(true);
  expect(await readdir(f.project)).toEqual([]);
});

it('compiled CLI refuses a require-approval overlay shadowing the narrow shutdown grant with its own typed config-category exit (C12 Q8 follow-up, owner 2026-09-27; RED proven only at composition level, see installation-preview.test.ts)', async () => {
  const f = await fixture(true);
  f.profile.policy.grants.push({ id: 'shutdown-approval', effect: 'require-approval', actions: 'all', scopes: 'all',
    principals: 'all', resource: { kind: 'service', ids: 'all' } });
  f.profile.profile.digest = hashInstallationProfilePayload({ ...f.profile, profile: { id: f.profile.profile.id, version: f.profile.profile.version } });
  await writeFile(f.path, JSON.stringify(f.profile));
  let observed = false;
  try { await f.run(['init', 'preview', '--profile', f.path, '--allow-shutdown', '--json']); }
  catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    expect(failure.code).toBe(78); expect(failure.stdout).toBe('');
    expect(JSON.parse(failure.stderr)).toMatchObject({ code: 'INSTALLATION_PROFILE_APPROVAL_UNSUPPORTED' }); observed = true;
  }
  expect(observed).toBe(true);
  expect(await readdir(f.project)).toEqual([]);
});

});
