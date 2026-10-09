import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { clearConfigCache, loadConfig, registerConfigSection } from '#platform/index.js';
import { openRegisteredSecretStore, registerProviderConfig } from '#adapters/index.js';
import { inspectConfiguredSecretStore, listConfiguredSecretStores, missingEnvironmentReferenceNames } from '#composition/core/secrets/index.js';
import { main, runKernelCommand } from '#surfaces/core/cli/index.js';

registerProviderConfig();
registerConfigSection('w2_guard_probe', z.object({ refs: z.array(z.string()) }).strict(), { optional: true, metadata: {
  descriptionKey: 'config.section', tier: 'core', since: '1.0.0-alpha.1', apply: 'live', binding: { state: 'bound', consumers: ['src/platform/core/config'] } } });
const roots: string[] = [], CANARY = 'W2_CANARY_ENV_SECRET_VALUE', FILE = 'core.secret-store.file@1', SEALED = 'core.secret-store.encrypted-file@1';
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const capture = () => { let value = ''; return { sink: { write: (text: string) => { value += text; return true; } }, text: () => value }; };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-w2-env-')); roots.push(root);
  const project = join(root, 'project'), global = join(root, 'global');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(global, { mode: 0o700 });
  const env = { HOME: root, DECKENT_GLOBAL_HOME: global, DECKENT_LANGUAGE: 'en', NO_COLOR: '1', A_KEY: CANARY, B_KEY: CANARY, EMPTY_KEY: '' };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ w2_guard_probe: {
    refs: ['$DECK:B_KEY', '$DECK:A_KEY', '$DECK:A_KEY', '$DECK:ABSENT_KEY', '$DECK:EMPTY_KEY', 'unreferenced'] } }), { mode: 0o600 });
  await openRegisteredSecretStore(FILE, env, 'linux').set('B_KEY', CANARY);
  return { project, env };
}

it.skipIf(process.platform === 'win32')('names only: sorted/deduplicated env references, excluding empty/absent env and target-held names; doctor shares the list in JSON and text', async () => {
  const f = await fixture();
  // Populate the config cache with resolved values first; the collection must still observe raw references.
  await loadConfig(f.project, { env: f.env });
  const view = await listConfiguredSecretStores(f.project, { env: f.env, platform: 'linux' });
  expect(view.envGuard?.[FILE]).toEqual({ names: ['A_KEY'], code: null });
  expect(view.envGuard?.[SEALED]).toEqual({ names: ['A_KEY', 'B_KEY'], code: null });
  const target = openRegisteredSecretStore(FILE, f.env, 'linux');
  const noValueTarget = { ...target, get: async () => { throw new Error('VALUE_READ_FORBIDDEN'); } };
  expect(await missingEnvironmentReferenceNames(f.project, { env: f.env }, noValueTarget)).toEqual(['A_KEY']);
  const json = capture(), text = capture();
  await runKernelCommand(['doctor', '--json'], { root: f.project, env: f.env, stdout: json.sink, inspectSecretStore: inspectConfiguredSecretStore });
  await runKernelCommand(['doctor'], { root: f.project, env: f.env, stdout: text.sink, inspectSecretStore: inspectConfiguredSecretStore });
  expect(JSON.parse(json.text()).secretStore.envGuard).toEqual(view.envGuard);
  expect(text.text()).toContain(`Env references missing in ${FILE}: A_KEY`);
  expect(JSON.stringify(view) + json.text() + text.text()).not.toContain(CANARY);
});

it.skipIf(process.platform === 'win32')('CLI blocks non-TTY without its explicit flag; yes/no works with --to on a TTY; no values in output', async () => {
  const f = await fixture();
  for (const answer of [undefined, 'no', 'yes', 'flag', 'eof']) {
    const stdin = new PassThrough() as PassThrough & { isTTY: boolean }; stdin.isTTY = answer === 'yes' || answer === 'no' || answer === 'eof';
    const out = capture(), err = capture(), calls: unknown[] = [];
    const stderr = { write(text: string) { err.sink.write(text); if (text.includes('[yes/no]')) setImmediate(() => answer === 'eof' ? stdin.end() : stdin.write(`${answer}\n`)); return true; } };
    const status = await main(['secret', 'store', '--to', FILE, '--scope', 's', '--json', ...(answer === 'flag' ? ['--confirm-env-missing'] : [])], {
      root: f.project, env: f.env, stdin, stdout: out.sink, stderr, listSecretStores: listConfiguredSecretStores,
      switchSecretStore: async (_root, command) => { calls.push(command); return { schemaVersion: 1, scopeId: 's', status: 'switched',
        from: 'core.secret-store.env@1', to: FILE, entries: 0, downgrade: false, cleaned: true }; } });
    const accepted = answer === 'yes' || answer === 'flag';
    expect(calls).toHaveLength(accepted ? 1 : 0); expect(status).toBe(accepted ? 0 : 1);
    if (accepted) expect(calls[0]).toMatchObject({ confirmEnvMissing: true });
    expect(out.text() + err.text()).not.toContain(CANARY); stdin.destroy();
  }
});

it.skipIf(process.platform === 'win32')('an unreadable target is unverified, not reported as empty', async () => {
  const f = await fixture();
  await writeFile(join(f.env.DECKENT_GLOBAL_HOME, 'secrets.json'), '{', { mode: 0o600 });
  expect((await listConfiguredSecretStores(f.project, { env: f.env })).envGuard?.[FILE]).toEqual({ names: [], code: 'SECRET_STORE_CORRUPT' });
});
