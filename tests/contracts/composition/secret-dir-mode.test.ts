import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearConfigCache, resolveGlobalConfigPaths, saveGlobalConfig, writeCrashArtifact, writeJsonAtomic } from '#platform/index.js';
import { createEncryptedFileSecretStore, createFileSecretStore, registerProviderConfig } from '#adapters/index.js';
import { inspectConfiguredSecretStore } from '#composition/core/secrets/index.js';
import { runKernelCommand } from '#surfaces/core/cli/index.js';

registerProviderConfig();
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'deckent-secret-dir-')); roots.push(project);
  const env = { HOME: join(project, 'home'), USERPROFILE: join(project, 'home'), DECKENT_GLOBAL_HOME: join(project, 'installation') };
  const configPath = resolveGlobalConfigPaths(env).platformPath;
  return { project, env, configPath, root: dirname(configPath) };
}

describe.skipIf(process.platform === 'win32')('SECRET-DIR-MODE: POSIX installation custody', () => {
  for (const [backend, create] of [['core.secret-store.file@1', createFileSecretStore], ['core.secret-store.encrypted-file@1', createEncryptedFileSecretStore]] as const) {
    it(`global config first, then ${backend} secret set succeeds on a fresh install`, async () => {
      const f = await fixture();
      await saveGlobalConfig({ language: 'tr', secrets: { store: backend } }, { env: f.env });
      expect((await lstat(f.root)).mode & 0o777).toBe(0o700);
      const store = create({ root: f.root, platform: process.platform });
      await store.set('TEST_TOKEN', 'synthetic-secret-dir-token');
      expect(await store.get('TEST_TOKEN')).toBe('synthetic-secret-dir-token');
      expect(await inspectConfiguredSecretStore(f.project, { env: f.env })).toMatchObject({ backend, status: 'ready' });
    });

    it(`config preserves an existing 0755 directory; ${backend} refuses it and doctor reports unsafe`, async () => {
      const f = await fixture(); await mkdir(f.root, { mode: 0o755 }); await chmod(f.root, 0o755);
      await saveGlobalConfig({ secrets: { store: backend } }, { env: f.env });
      expect((await lstat(f.root)).mode & 0o777).toBe(0o755);
      await expect(create({ root: f.root, platform: process.platform }).set('TEST_TOKEN', 'synthetic-token'))
        .rejects.toMatchObject({ code: 'SECRET_STORE_UNSAFE' });
      const output: string[] = [];
      await runKernelCommand(['doctor', '--json'], { root: f.project, env: f.env,
        stdout: { write: text => { output.push(text); return true; } }, inspectSecretStore: inspectConfiguredSecretStore });
      expect(JSON.parse(output.join(''))).toMatchObject({ secretStore: { backend, status: 'unsafe', code: 'SECRET_STORE_UNSAFE' } });
      expect((await lstat(f.root)).mode & 0o777).toBe(0o755);
    });
  }

  it('atomic JSON publication creates private parents before a secret write', async () => {
    const f = await fixture(); await writeJsonAtomic(f.configPath, { schema_version: 4 });
    expect((await lstat(f.root)).mode & 0o777).toBe(0o700);
    const store = createFileSecretStore({ root: f.root, platform: process.platform });
    await store.set('TEST_TOKEN', 'synthetic-token'); expect(await store.listNames()).toEqual(['TEST_TOKEN']);
  });

  it('crash publication before configuration creates a private installation directory', async () => {
    const f = await fixture();
    expect(await writeCrashArtifact(new Error('synthetic failure'), f.project, ['doctor'], { ...f.env, DECKENT_HOME: f.root })).not.toBeNull();
    expect((await lstat(f.root)).mode & 0o777).toBe(0o700);
    const store = createFileSecretStore({ root: f.root, platform: process.platform });
    await store.set('TEST_TOKEN', 'synthetic-token'); expect(await store.listNames()).toEqual(['TEST_TOKEN']);
  });
});
