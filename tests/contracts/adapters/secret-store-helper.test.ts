import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { createSecretHelperFactory, type SecretHelperOptions } from '#adapters/index.js';
import { ErrorRegistry } from '#platform/index.js';

const CANARY = 'synthetic-helper-canary-192fc3-not-a-real-key';
const ID = 'custom.secret-store.test-helper@1';
const roots: string[] = [];
const supported = process.platform === 'linux' || process.platform === 'darwin';
const context = { env: { PROVIDER_TOKEN: CANARY }, platform: process.platform, root: null };
const allow = async () => ({ effect: 'allow' as const, policyRevision: 'fixture-policy', ruleId: 'helper-read' });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(body: string, changes: Partial<SecretHelperOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-secret-helper-')); roots.push(root);
  const script = join(root, 'helper.cjs');
  // Approved helper reads the real requested name from stdin. Negative cases keep their original failing command.
  await writeFile(script, `const name = require('node:fs').readFileSync(0, 'utf8'); ${body}`);
  const options: SecretHelperOptions = { id: ID, executable: process.execPath, args: [script], cwd: root,
    timeoutMs: 5_000, maxOutputBytes: 65_538, authorize: allow, ...changes };
  const factory = createSecretHelperFactory(options);
  return { root, script, options, factory, store: factory.create(context) };
}
function visible(error: unknown) {
  const e = error as Error & { code: string; params: unknown; localize?: (lang: 'en' | 'tr') => unknown };
  return JSON.stringify({ json: error, message: e.message, stack: e.stack, cause: e.cause, params: e.params,
    english: e.localize?.('en'), turkish: e.localize?.('tr'), catalog: ErrorRegistry.get(e.code, 'tr') });
}

it.skipIf(!supported)('success: exact name over stdin, no secret or inherited environment in argv/env, trusted cwd and fresh rotation', async () => {
  const f = await fixture(`require('node:fs').writeSync(1, JSON.stringify({ name, argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }) + '\\n');`);
  // Registration snapshots arguments; later edits of the registrant's mutable object cannot change the selected command.
  (f.options.args as string[])[0] = join(f.root, 'unregistered-command.cjs');
  const value = JSON.parse((await f.store.get('PROVIDER_TOKEN'))!);
  expect(value).toEqual({ name: 'PROVIDER_TOKEN\n', argv: [], env: {}, cwd: f.root });
  expect(JSON.stringify(value)).not.toContain(CANARY);
  await writeFile(f.script, `require('node:fs').readFileSync(0); require('node:fs').writeSync(1, '${CANARY}\\r\\n');`);
  expect(await f.store.get('PROVIDER_TOKEN')).toBe(CANARY);
  await writeFile(f.script, `require('node:fs').readFileSync(0); require('node:fs').writeSync(1, 'rotated-synthetic');`);
  expect(await f.store.get('PROVIDER_TOKEN')).toBe('rotated-synthetic');
});

it.skipIf(!supported)('missing name: empty output is undefined; never falls back to context env', async () => {
  const f = await fixture(`if (name === 'OTHER_TOKEN\\n') require('node:fs').writeSync(1, '${CANARY}');`);
  expect(await f.store.get('PROVIDER_TOKEN')).toBeUndefined();
});

it.skipIf(!supported).each(['deny', 'require-approval'] as const)('policy %s: original command cannot execute and no output reaches a surface', async effect => {
  const f = await fixture(`require('node:fs').writeFileSync('executed', 'yes'); require('node:fs').writeSync(1, '${CANARY}');`,
    { authorize: async request => { expect(request).toEqual({ backend: ID, name: 'PROVIDER_TOKEN' }); return { effect, policyRevision: 'p', ruleId: 'rule' }; } });
  const error = await f.store.get('PROVIDER_TOKEN').catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: 'SECRET_HELPER_DENIED' });
  expect(visible(error)).not.toContain(CANARY);
  await expect(readFile(join(f.root, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(!supported)('authorization failure is sanitized; late authorization after the deadline cannot spawn', async () => {
  const f = await fixture(`require('node:fs').writeFileSync('executed', 'yes');`, { authorize: async () => { throw new Error(CANARY); } });
  const error = await f.store.get('PROVIDER_TOKEN').catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: 'SECRET_HELPER_DENIED' }); expect(visible(error)).not.toContain(CANARY);
  let authorize!: (value: Awaited<ReturnType<typeof allow>>) => void;
  const pending = await fixture(`require('node:fs').writeFileSync('executed', 'yes');`,
    { timeoutMs: 30, authorize: () => new Promise(resolve => { authorize = resolve; }) });
  await expect(pending.store.get('PROVIDER_TOKEN')).rejects.toMatchObject({ code: 'SECRET_HELPER_TIMEOUT' });
  authorize(await allow()); await delay(50);
  await expect(readFile(join(pending.root, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(!supported)('timeout: approved original hanging command is killed, including descendants holding stdout after parent exit', async () => {
  const f = await fixture(`const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync('escaped', 'yes'), 1200)"], { stdio: ['ignore', 'inherit', 'inherit'] });`, { timeoutMs: 500 });
  await expect(f.store.get('PROVIDER_TOKEN')).rejects.toMatchObject({ code: 'SECRET_HELPER_TIMEOUT' });
  await delay(1500);
  await expect(readFile(join(f.root, 'escaped'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(!supported).each(['stdout', 'stderr'] as const)('oversized %s: approved original flood is stopped and has no late effect', async stream => {
  const f = await fixture(`require('node:fs').writeSync(${stream === 'stdout' ? 1 : 2}, '${CANARY}'.repeat(1000));
    setTimeout(() => require('node:fs').writeFileSync('escaped', 'yes'), 500);`, { maxOutputBytes: 64 });
  const error = await f.store.get('PROVIDER_TOKEN').catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: 'SECRET_HELPER_OUTPUT_LIMIT' }); expect(visible(error)).not.toContain(CANARY);
  await delay(700); await expect(readFile(join(f.root, 'escaped'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(!supported)('stdout and stderr share one output bound', async () => {
  const f = await fixture(`require('node:fs').writeSync(1, '123456'); require('node:fs').writeSync(2, '789012');`, { maxOutputBytes: 10 });
  await expect(f.store.get('PROVIDER_TOKEN')).rejects.toMatchObject({ code: 'SECRET_HELPER_OUTPUT_LIMIT' });
});

it.skipIf(!supported)('non-zero exit: stdout/stderr/cause never reach the typed error, even after a valid-looking value', async () => {
  const f = await fixture(`require('node:fs').writeSync(1, '${CANARY}'); require('node:fs').writeSync(2, '${CANARY}'); process.exitCode = 23;`);
  const error = await f.store.get('PROVIDER_TOKEN').catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: 'SECRET_HELPER_FAILED' });
  expect(visible(error)).not.toContain(CANARY); expect((error as Error).cause).toBeUndefined();
});

it.skipIf(!supported)('spawn failure is typed and has no command path or cause', async () => {
  const f = await fixture('', { executable: join(tmpdir(), CANARY, 'nonexistent') });
  const error = await f.store.get('PROVIDER_TOKEN').catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: 'SECRET_HELPER_FAILED' }); expect(visible(error)).not.toContain(CANARY);
});

it.skipIf(!supported).each(["'one\\ntwo'", "'one\\0two'", "Buffer.from([0xff])"])( 'malformed single-line UTF-8 output %s is a sanitized refusal', async value => {
  const f = await fixture(`require('node:fs').writeSync(1, ${value});`);
  await expect(f.store.get('PROVIDER_TOKEN')).rejects.toMatchObject({ code: 'SECRET_VALUE_INVALID' });
});

it.skipIf(!supported)('concurrency is bounded across store instances; invalid names, writes and inspection never launch a helper', async () => {
  let authorize!: (value: Awaited<ReturnType<typeof allow>>) => void;
  const f = await fixture(`require('node:fs').writeSync(1, '${CANARY}');`, { authorize: () => new Promise(resolve => { authorize = resolve; }) });
  expect(f.store.descriptor).toEqual({ id: ID, writable: false, enumerable: false });
  await expect(f.store.get(`bad-${CANARY}`)).rejects.toMatchObject({ code: 'SECRET_NAME_INVALID' });
  await expect(f.store.set('PROVIDER_TOKEN', CANARY)).rejects.toMatchObject({ code: 'SECRET_STORE_READ_ONLY' });
  await expect(f.store.delete('PROVIDER_TOKEN')).rejects.toMatchObject({ code: 'SECRET_STORE_READ_ONLY' });
  await expect(f.store.listNames()).rejects.toMatchObject({ code: 'SECRET_STORE_UNSUPPORTED' });
  expect(await f.store.inspect()).toEqual({ status: 'unavailable', code: 'SECRET_STORE_UNAVAILABLE' });
  const pending = f.store.get('PROVIDER_TOKEN');
  await expect(f.factory.create(context).get('OTHER_TOKEN')).rejects.toMatchObject({ code: 'SECRET_STORE_BUSY' });
  authorize(await allow()); expect(await pending).toBe(CANARY);
});

it('unsupported/mismatched platform refuses before authorization or process creation', async () => {
  let authorized = false;
  const f = await fixture('', { authorize: async () => { authorized = true; return allow(); } });
  for (const platform of ['win32', 'unsupported', process.platform === 'linux' ? 'darwin' : 'linux']) {
    await expect(f.factory.create({ ...context, platform }).get('PROVIDER_TOKEN')).rejects.toMatchObject({ code: 'SECRET_STORE_UNAVAILABLE' });
  }
  expect(authorized).toBe(false);
});

it.each([
  { executable: 'relative-helper' }, { cwd: '.' }, { timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: 2_147_483_648 },
  { maxOutputBytes: 65_539 }, { maxOutputBytes: 0 }, { id: 'core.secret-store.fake@1' }, { id: CANARY }, { args: [`${CANARY}\0`] },
])('invalid registered definition is sanitized: %j', async changes => {
  const error = await fixture('', changes).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: 'SECRET_HELPER_INVALID' }); expect(visible(error)).not.toContain(CANARY);
});
