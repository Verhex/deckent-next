import { access, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { composeCore } from '#composition/core/root/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { childEnv } from '../support/child-env.js';
import { owned } from '../support/owned.js';

// ENTERPRISE-EXT-1 acceptance (owner K7 = A): tests/fixtures/overlay-package is a non-Core package that imports only `deckent/extensions`
// (lint-arch G-j). Installed next to the built Core, its own executable registers an effect target and runs `deckent operation execute`
// through Core's command line, policy and ledger; Core's own executable, unchanged, does not know the adapter.
const dist = resolve('dist'), fixture = resolve('tests/fixtures/overlay-package'), coreCli = join(dist, 'composition/core/cli/internal/entry.js');
// The package.json line the lead adds (docs-delta); until then the installed copy's manifest carries it so the bare specifier resolves.
const EXTENSIONS_EXPORT = { types: './dist/extensions.d.ts', import: './dist/extensions.js' };
afterEach(() => { clearConfigCache(); });

/** One CLI process, owned and bounded (a hang is a typed TEST_CHILD_DEADLINE failure; teardown reaps the group). */
function run(entry: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  return owned().run(process.execPath, [entry, ...args], { cwd, env, deadlineMs: 20_000, label: `${entry.endsWith('bin.mjs') ? 'overlay' : 'core'} ${args[0]}` });
}

it.skipIf(process.platform !== 'linux')('[requires Linux live OS session and a build] an installed overlay package registers a target through deckent/extensions only and runs it with `deckent operation`', async () => {
  await access(join(dist, 'extensions.js')).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const root = await owned().root('deckent-overlay-');
  // Install: node_modules/deckent is the built Core (dist linked; Node resolves the real path, so Core's own `#` imports stay Core's).
  const installed = join(root, 'node_modules/deckent'), overlay = join(root, 'overlay');
  await mkdir(installed, { recursive: true }); await mkdir(overlay);
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { exports: Record<string, unknown> };
  manifest.exports['./extensions'] ??= EXTENSIONS_EXPORT;
  await writeFile(join(installed, 'package.json'), JSON.stringify(manifest));
  await symlink(dist, join(installed, 'dist'), 'dir');
  for (const file of ['package.json', 'module.mjs', 'bin.mjs']) await copyFile(join(fixture, file), join(overlay, file));

  const project = join(root, 'project'), ledgerDir = join(root, 'erp');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(ledgerDir);
  const env = childEnv({ HOME: join(root, 'home'), DECKENT_LANGUAGE: 'en', NO_COLOR: '1' }); delete env['DECKENT_GLOBAL_HOME'];
  const configPath = join(project, '.deckent/config.json'), layout = { root: join(root, 'data') };
  await writeFile(configPath, JSON.stringify({ layout }));
  composeCore();
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'overlay', restrictions: [], grants: [
    { id: 'ops', effect: 'allow', actions: ['execute'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'operation', ids: 'all' } }] }), { mode: 0o600 });
  // The installation selects the module's adapter by registry id; the operation itself comes from the module's manifest, not from config.
  await writeFile(configPath, JSON.stringify({ layout, operations: { catalog: [], targets: [{ adapter: 'overlay.ledger-file', options: { kind: 'overlay-ledger', directory: ledgerDir } }] } }));
  clearConfigCache();
  const command = { schemaVersion: 1, commandId: 'c1', scopeId: 's', operation: { id: 'overlay.post-entry', version: 1 }, target: { kind: 'overlay-ledger', id: 'INV-1' },
    idempotencyKey: 'k1', input: { amount: 42 }, expectedVersion: null };
  await writeFile(join(project, 'command.json'), JSON.stringify(command));

  const first = await run(join(overlay, 'bin.mjs'), ['operation', 'execute', '--input', 'command.json', '--json'], project, env);
  expect(first.code, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ status: 'settled', operation: { id: 'overlay.post-entry', version: 1 }, target: { kind: 'overlay-ledger', id: 'INV-1' }, version: '"v1"' });
  const ledger = () => readFile(join(ledgerDir, 'overlay-ledger.json'), 'utf8').then(text => JSON.parse(text) as { records: Record<string, number>; applied: Record<string, unknown> });
  // Core hands the target its own scoped idempotency key (a digest), never the caller's raw key.
  const applied = await ledger();
  expect(applied.records).toEqual({ 'INV-1': 1 });
  expect(Object.values(applied.applied)).toEqual([{ version: '"v1"', input: { amount: 42 } }]);
  // A second process with the same command is the recorded settlement, not a second effect.
  const replay = await run(join(overlay, 'bin.mjs'), ['operation', 'execute', '--input', 'command.json', '--json'], project, env);
  expect(replay.code, replay.stderr).toBe(0);
  expect(JSON.parse(replay.stdout)).toMatchObject({ status: 'settled', version: '"v1"' });
  expect(await ledger()).toEqual(applied);

  // Negative: Core's own executable never loaded the overlay, so the same configuration is a typed refusal and nothing is applied.
  await writeFile(join(project, 'command.json'), JSON.stringify({ ...command, commandId: 'c2', idempotencyKey: 'k2' }));
  const core = await run(coreCli, ['operation', 'execute', '--input', 'command.json', '--json'], project, env);
  expect(core.code).not.toBe(0);
  expect(JSON.parse(core.stderr)).toMatchObject({ code: 'CONFIG_VALIDATION', message: expect.stringContaining('OPERATIONS_INVALID') });
  expect(await ledger()).toEqual(applied);
}, 60_000);
