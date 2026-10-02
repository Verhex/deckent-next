import { readdir, readFile, mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { clearConfigCache, configDisplayView, configuredSecretResolver, loadConfig, registerConfigSection, resolveGlobalConfigPaths } from '#platform/index.js';
import { createFileSecretStore, registerProviderConfig } from '#adapters/index.js';
import { inspectConfiguredSecretStore, listConfiguredSecretNames } from '#composition/core/secrets/index.js';
import { main, runKernelCommand } from '#surfaces/core/cli/index.js';

registerProviderConfig();
registerConfigSection('k1_secret_probe', z.object({ token: z.string() }).strict(), { metadata: { descriptionKey: 'config.section', tier: 'core', since: '1.0.0-alpha.1', binding: { state: 'bound', consumers: ['src/platform/core/config'] }, apply: 'live' }, optional: true });

// Synthetic canary only: never a real credential.
const CANARY = 'synthetic-canary-71be0d-not-a-real-key';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-secret-wiring-')); roots.push(root);
  const home = join(root, 'home'), project = join(root, 'project');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const env: Record<string, string> = { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  const globalPath = resolveGlobalConfigPaths(env).platformPath, globalRoot = dirname(globalPath);
  await mkdir(globalRoot, { recursive: true, mode: 0o700 }); await chmod(globalRoot, 0o700);
  const projectPath = join(project, '.deckent', 'config.json');
  await writeFile(projectPath, JSON.stringify({ k1_secret_probe: { token: '$DECK:PROVIDER_TOKEN' } }), { mode: 0o600 });
  const selectFile = () => writeFile(globalPath, JSON.stringify({ secrets: { store: 'core.secret-store.file@1' } }), { mode: 0o600 });
  return { root, home, project, env, globalPath, globalRoot, projectPath, selectFile, file: createFileSecretStore({ root: globalRoot, platform: 'linux' }) };
}
const capture = () => { const lines: string[] = []; return { lines, sink: { write: (text: string) => { lines.push(text); return true; } } }; };

describe.skipIf(process.platform === 'win32')('requires POSIX private file secret store; SECRET_STORE_UNAVAILABLE', () => {
it('env stays the default backend: the production resolver reads own environment properties exactly as before', async () => {
  const f = await fixture();
  const config = await loadConfig(f.project, { env: { ...f.env, PROVIDER_TOKEN: CANARY } });
  expect(config['k1_secret_probe']).toEqual({ token: CANARY });
  expect(await configuredSecretResolver(config, { env: { ...f.env, PROVIDER_TOKEN: 'from-env' } })('PROVIDER_TOKEN')).toBe('from-env');
  // An explicit resolver (tests, SDK callers) still wins over the configured backend.
  expect(await configuredSecretResolver(config, { env: f.env, secretResolver: async () => 'explicit' })('PROVIDER_TOKEN')).toBe('explicit');
});

it('an explicitly selected file backend resolves $DECK references and never falls back to the environment', async () => {
  const f = await fixture(); await f.selectFile(); await f.file.set('PROVIDER_TOKEN', CANARY);
  const env = { ...f.env, PROVIDER_TOKEN: 'environment-must-not-win' };
  const config = await loadConfig(f.project, { env });
  expect(config['k1_secret_probe']).toEqual({ token: CANARY });
  expect(config['secrets']).toEqual({ store: 'core.secret-store.file@1' });
  expect(JSON.stringify(configDisplayView(config))).not.toContain(CANARY);
  await f.file.delete('PROVIDER_TOKEN'); clearConfigCache();
  const warnings: string[] = [];
  const missing = await loadConfig(f.project, { env, onWarning: warning => warnings.push(warning.code) });
  expect(missing['k1_secret_probe']).toEqual({ token: '$DECK:PROVIDER_TOKEN' });
  expect(warnings).toContain('CONFIG_SECRET_UNRESOLVED');
});

it('an unsafe store is a typed refusal at load, with no value in the error', async () => {
  const f = await fixture(); await f.selectFile(); await f.file.set('PROVIDER_TOKEN', CANARY);
  await chmod(join(f.globalRoot, 'secrets.json'), 0o644);
  const error = await loadConfig(f.project, { env: f.env }).then(() => null, (caught: unknown) => caught);
  expect(error).toMatchObject({ code: 'SECRET_STORE_UNSAFE' });
  expect(JSON.stringify({ message: (error as Error).message, params: (error as { params?: unknown }).params })).not.toContain(CANARY);
});

it('only the installation (global) layer selects the backend; unknown backends and references are refused', async () => {
  const f = await fixture();
  await writeFile(f.projectPath, JSON.stringify({ secrets: { store: 'core.secret-store.file@1' } }), { mode: 0o600 });
  await expect(loadConfig(f.project, { env: f.env })).rejects.toMatchObject({ issues: [expect.objectContaining({ path: 'secrets', reason: 'SECRETS_PROJECT_LAYER_FORBIDDEN' })] });
  await writeFile(f.projectPath, '{}', { mode: 0o600 });
  await writeFile(f.globalPath, JSON.stringify({ secrets: { store: 'enterprise.secret-store.vault@1' } }), { mode: 0o600 }); clearConfigCache();
  await expect(loadConfig(f.project, { env: f.env })).rejects.toMatchObject({ code: 'SECRET_STORE_UNKNOWN' });
  await writeFile(f.globalPath, JSON.stringify({ secrets: { store: '$DECK:STORE' } }), { mode: 0o600 }); clearConfigCache();
  await expect(loadConfig(f.project, { env: f.env })).rejects.toThrow();
});

it('doctor names the active backend and its state; secret list shows names only', async () => {
  const f = await fixture(); const out = capture();
  await runKernelCommand(['doctor', '--json'], { root: f.project, env: f.env, stdout: out.sink, inspectSecretStore: inspectConfiguredSecretStore });
  expect(JSON.parse(out.lines.join(''))).toMatchObject({ secretStore: { backend: 'core.secret-store.env@1', writable: false, enumerable: false, status: 'ready', code: null } });
  await f.selectFile(); await f.file.set('PROVIDER_TOKEN', CANARY); clearConfigCache();
  const second = capture();
  await runKernelCommand(['doctor', '--json'], { root: f.project, env: f.env, stdout: second.sink, inspectSecretStore: inspectConfiguredSecretStore });
  const report = JSON.parse(second.lines.join(''));
  expect(report).toMatchObject({ secretStore: { backend: 'core.secret-store.file@1', writable: true, enumerable: true, status: 'ready', code: null } });
  expect(second.lines.join('')).not.toContain(CANARY);
  const list = capture();
  expect(await main(['secret', 'list', '--json'], { root: f.project, env: f.env, stdout: list.sink, listSecretNames: listConfiguredSecretNames })).toBe(0);
  expect(JSON.parse(list.lines.join(''))).toEqual({ schemaVersion: 1, backend: 'core.secret-store.file@1', names: ['PROVIDER_TOKEN'] });
  expect(list.lines.join('')).not.toContain(CANARY);
  // Unwired or unsupported handler: never silent.
  const unwired = capture(), err = capture();
  expect(await main(['secret', 'list', '--json'], { root: f.project, env: f.env, stdout: unwired.sink, stderr: err.sink })).not.toBe(0);
});

it('without the service handlers secret set/delete are usage refusals; a value given on argv is refused and never echoed or stored', async () => {
  const f = await fixture(); await f.selectFile();
  for (const argv of [['secret', 'set', 'PROVIDER_TOKEN', CANARY], ['secret', 'delete', 'PROVIDER_TOKEN']]) {
    const out = capture(), err = capture();
    expect(await main([...argv, '--json'], { root: f.project, env: f.env, stdout: out.sink, stderr: err.sink, listSecretNames: listConfiguredSecretNames })).toBe(2);
    expect(out.lines.join('') + err.lines.join('')).not.toContain(CANARY);
  }
  expect(await readdir(f.globalRoot)).not.toContain('secrets.json');
  // No crash artifact holds it either.
  const deckent = join(f.project, '.deckent');
  for (const name of await readdir(deckent, { recursive: true })) {
    const path = join(deckent, String(name));
    const text = await readFile(path, 'utf8').catch(() => '');
    expect(text).not.toContain(CANARY);
  }
});

it('every production credential read goes through the one configured resolver (no direct environment fallback left)', async () => {
  const sources = ['src/composition/core/model-invocation/internal/credential.ts', 'src/composition/core/agent-turn/internal/mcp.ts', 'src/platform/core/config/internal/layers.ts'];
  for (const path of sources) {
    const text = await readFile(path, 'utf8');
    expect(text, path).toContain('configuredSecretResolver(');
    // A conditional or nullish fallback on the option (`secretResolver ? … : env` / `secretResolver ?? …`); the optional field `secretResolver?:` is allowed.
    expect(text, path).not.toMatch(/secretResolver\s*(?:\?\?|\?(?!:))/);
  }
});

});
