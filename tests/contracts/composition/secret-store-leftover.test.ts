import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { inspectConfiguredSecretStore } from '#composition/core/secrets/index.js';
import { createInstallationSecretStoreSelection, openRegisteredSecretStore, registerProviderConfig } from '#adapters/index.js';
import { renderDoctorReport } from '#surfaces/core/doctor/index.js';

// Astra 2456 N2: a store that is not selected and cannot be listed now is reported as unverified, never counted as empty; doctor names it.
const FILE = 'core.secret-store.file@1', SEALED = 'core.secret-store.encrypted-file@1';
const roots: string[] = [];
beforeAll(() => { registerProviderConfig(); });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(process.platform !== 'linux')('leftover copies are counted; an unreadable non-selected store is unverified, not empty; doctor shows both', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-secret-leftover-')); roots.push(root);
  const home = join(root, 'home'), global = join(home, 'global'), project = join(root, 'project');
  await mkdir(global, { recursive: true, mode: 0o700 }); await mkdir(project);
  const env = { HOME: home, USERPROFILE: home, DECKENT_GLOBAL_HOME: global, DECKENT_LANGUAGE: 'en' };
  const selection = createInstallationSecretStoreSelection(env, 'linux');
  await selection.publish(SEALED, (await selection.read()).digest);
  await openRegisteredSecretStore(FILE, env, 'linux').set('A_KEY', 'synthetic-a');
  expect((await inspectConfiguredSecretStore(project, { env, platform: 'linux' })).leftover).toEqual({ backends: [FILE], entries: 1, unverified: [] });
  // The file store's document becomes unreadable (corrupt): its copies can be neither counted nor ruled out.
  await writeFile(join(global, 'secrets.json'), '{', { mode: 0o600 });
  const view = await inspectConfiguredSecretStore(project, { env, platform: 'linux' });
  expect(view).toMatchObject({ backend: SEALED, leftover: { backends: [], entries: 0, unverified: [FILE] } });
  const text = renderDoctorReport({ platform: 'linux', host: { cpuCores: 1, totalMemMB: 1, recommendedMaxWorkers: 1 }, company: { companyId: 'c' },
    principal: { id: 'p' }, secretStore: view, imageRefresh: null, installationBinding: null, shellRealm: null }, [], 'en');
  expect(text).toContain(`could not be read now (${FILE})`);
  expect(text).not.toContain('remain in a store that is not selected');
});
