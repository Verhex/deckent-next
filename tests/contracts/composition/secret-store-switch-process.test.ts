import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearConfigCache, resolveGlobalConfigPaths } from '#platform/index.js';
import { createEncryptedFileSecretStore, registerProviderConfig } from '#adapters/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { cliChildEnv } from '../support/child-env.js';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';

// SECRET-STORE-SWITCH on the shipped processes (owner 2026-10-08, option B): compiled `runtime serve` + compiled `deckent secret store`. A key in
// the plaintext file store is moved into the encrypted store, read back, the selection published and the plaintext copy removed; the switch is
// decided by the template v6 `first-run-secret-switch` grant and audited as `secret-store-switch`. A synthetic canary is searched afterwards.
type Child = ChildProcess & { stdout: NonNullable<ChildProcess['stdout']>; stderr: NonNullable<ChildProcess['stderr']>; stdin: NonNullable<ChildProcess['stdin']> };
const CANARY = 'synthetic-canary-7e1a20-not-a-real-key', SEALED = 'core.secret-store.encrypted-file@1', FILE = 'core.secret-store.file@1';
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const children = new Set<Child>(), cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all([...children].map(child => child.exitCode !== null ? undefined : new Promise(done => child.once('close', done))));
  children.clear(); clearConfigCache();
  for (const close of cleanup.splice(0).reverse()) await close();
});
function ready(child: Child): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += String(chunk);
      for (const line of buffer.split('\n')) { try { if ((JSON.parse(line) as { event?: string }).event === 'ready') resolveReady(); } catch { /* partial line */ } }
    });
    child.once('close', code => reject(new Error(`SERVICE_CLOSED_${code}`)));
  });
}
function run(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }) as Child;
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject); child.once('close', code => resolveRun({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

it.skipIf(process.platform !== 'linux')('compiled CLI + service: file → encrypted moves the key, removes the plain text, selects the sealed store live; a downgrade needs confirmation', async () => {
  registerProviderConfig();
  const root = await mkdtemp(join(tmpdir(), 'deckent-store-switch-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), home = join(root, 'home');
  await mkdir(project, { recursive: true }); await mkdir(home, { mode: 0o700 });
  const env = cliChildEnv({ HOME: home, DECKENT_LANGUAGE: 'en', NO_COLOR: '1' }); delete env['DECKENT_HOME']; delete env['DECKENT_GLOBAL_HOME'];
  await applyPolicyTemplateInstallation(project, 'installation');
  await writeFile(join(project, '.deckent', 'config.json'), JSON.stringify({ terminal: { scopeId: 'installation' },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['installation'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 262144, responseMaxBytes: 65536, maxConnections: 8, maxConcurrentRequests: 4, maxConcurrentExecutions: 1,
      headerTimeoutMs: 1000, responseTimeoutMs: 5000, shutdownGraceMs: 1000 } }), { mode: 0o600 });
  const globalPath = resolveGlobalConfigPaths(env).platformPath, globalRoot = dirname(globalPath);
  await mkdir(globalRoot, { recursive: true, mode: 0o700 }); await chmod(globalRoot, 0o700);
  await writeFile(globalPath, JSON.stringify({ secrets: { store: FILE } }), { mode: 0o600 });
  const opened = await openConfiguredAttemptStore(project, { env }); const ledger = opened.path;
  opened.store.close(); clearConfigCache();
  const service = spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] }) as Child;
  children.add(service); let serviceOut = ''; service.stdout.on('data', chunk => { serviceOut += String(chunk); }); service.stderr.on('data', chunk => { serviceOut += String(chunk); });
  await ready(service);
  const printed: string[] = [];
  const set = await run(['secret', 'set', 'PROVIDER_TOKEN', '--json'], project, env, `${CANARY}\n`); printed.push(set.stdout, set.stderr);
  expect(set.code, set.stderr).toBe(0);
  expect((await readFile(join(globalRoot, 'secrets.json'))).includes(Buffer.from(CANARY))).toBe(true);

  const listed = await run(['secret', 'store', '--list', '--json'], project, env); printed.push(listed.stdout, listed.stderr);
  expect(JSON.parse(listed.stdout)).toEqual({ schemaVersion: 1, current: FILE, stores: ['core.secret-store.env@1', FILE, SEALED] });
  const switched = await run(['secret', 'store', '--to', SEALED, '--json'], project, env); printed.push(switched.stdout, switched.stderr);
  expect(switched.code, switched.stderr).toBe(0);
  expect(JSON.parse(switched.stdout)).toEqual({ schemaVersion: 1, scopeId: 'installation', status: 'switched', from: FILE, to: SEALED, entries: 1, downgrade: false, cleaned: true });
  // The plaintext copy is gone; the installation config selects the sealed store (other keys kept); the key opens with the installation key.
  expect(JSON.parse(await readFile(join(globalRoot, 'secrets.json'), 'utf8'))).toEqual({ schemaVersion: 1, secrets: {} });
  expect(JSON.parse(await readFile(globalPath, 'utf8'))).toMatchObject({ secrets: { store: SEALED } });
  expect(await createEncryptedFileSecretStore({ root: globalRoot, platform: 'linux' }).get('PROVIDER_TOKEN')).toBe(CANARY);
  // The running service uses the new selection without a restart: the next change lands in the sealed store.
  const next = await run(['secret', 'set', 'SECOND_TOKEN', '--json'], project, env, 'synthetic-second-value\n'); printed.push(next.stdout, next.stderr);
  expect(JSON.parse(next.stdout)).toMatchObject({ action: 'set', backend: SEALED });
  // The same switch again is current (nothing left to clean); a downgrade without confirmation moves nothing.
  const again = await run(['secret', 'store', '--to', SEALED, '--json'], project, env); printed.push(again.stdout, again.stderr);
  expect(JSON.parse(again.stdout)).toMatchObject({ status: 'current', cleaned: true });
  const downgrade = await run(['secret', 'store', '--to', FILE, '--json'], project, env); printed.push(downgrade.stdout, downgrade.stderr);
  expect(downgrade.code).not.toBe(0);
  expect(downgrade.stdout + downgrade.stderr).toContain('SECRET_STORE_DOWNGRADE_UNCONFIRMED');
  expect(JSON.parse(await readFile(globalPath, 'utf8'))).toMatchObject({ secrets: { store: SEALED } });

  const db = new DatabaseSync(ledger, { readOnly: true });
  let subjects: { kind: string }[];
  try { subjects = db.prepare('SELECT record FROM audit_events ORDER BY sequence').all().map(row => (JSON.parse(String(row['record'])) as { event: { subject: { kind: string } } }).event.subject); }
  finally { db.close(); }
  expect(subjects.filter(subject => subject.kind === 'secret-store-switch')).toEqual([{ kind: 'secret-store-switch', from: FILE, to: SEALED, entries: 1, downgrade: false,
    decision: { effect: 'allow', ruleId: 'first-run-secret-switch' } }]);
  service.kill('SIGTERM'); await new Promise(done => service.once('close', done));
  expect(printed.join('\n') + serviceOut).not.toContain(CANARY);
  for (const entry of await readdir(globalRoot, { recursive: true })) {
    const bytes = await readFile(join(globalRoot, String(entry))).catch(() => null);
    expect(bytes?.includes(Buffer.from(CANARY)) ?? false, String(entry)).toBe(false);
  }
}, 60_000);

it.skipIf(process.platform !== 'linux')('compiled env guard and direct runtime client block missing refs; confirmed switch never copies env values', async () => {
  registerProviderConfig();
  const root = await mkdtemp(join(tmpdir(), 'deckent-env-switch-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), home = join(root, 'home');
  await mkdir(project, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  const env = cliChildEnv({ HOME: home, DECKENT_GLOBAL_HOME: join(home, 'global'), DECKENT_LANGUAGE: 'en', NO_COLOR: '1', PROVIDER_TOKEN: CANARY });
  await applyPolicyTemplateInstallation(project, 'installation');
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ projectName: '$DECK:PROVIDER_TOKEN', terminal: { scopeId: 'installation' },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['installation'], pollIntervalMs: 1000, failureBackoffMs: 1000 } }), { mode: 0o600 });
  await mkdir(env['DECKENT_GLOBAL_HOME']!, { recursive: true, mode: 0o700 });
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close(); clearConfigCache();
  const service = spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] }) as Child;
  children.add(service); let printed = '';
  service.stdout.on('data', chunk => { printed += String(chunk); }); service.stderr.on('data', chunk => { printed += String(chunk); });
  await ready(service).catch(error => { throw new Error(`${(error as Error).message}: ${printed.split(CANARY).join('[canary]')}`); });
  const blocked = await run(['secret', 'store', '--to', SEALED, '--json'], project, env);
  expect(blocked.code).toBe(1); expect(blocked.stderr).toContain('PROVIDER_TOKEN'); printed += blocked.stdout + blocked.stderr;
  const client = createConfiguredRuntimeClient(project, { env });
  await expect(client.switchSecretStore({ schemaVersion: 1, scopeId: 'installation', to: SEALED, confirmDowngrade: false }))
    .rejects.toMatchObject({ code: 'SECRET_STORE_ENV_UNCONFIRMED' });
  const switched = await run(['secret', 'store', '--to', SEALED, '--confirm-env-missing', '--json'], project, env);
  expect(switched.code, switched.stderr).toBe(0); expect(JSON.parse(switched.stdout)).toMatchObject({ status: 'switched', entries: 0 });
  printed += switched.stdout + switched.stderr;
  expect(await createEncryptedFileSecretStore({ root: env['DECKENT_GLOBAL_HOME']!, platform: 'linux' }).get('PROVIDER_TOKEN')).toBeUndefined();
  service.kill('SIGTERM'); await new Promise(done => service.once('close', done));
  expect(printed).not.toContain(CANARY);
  for (const base of [env['DECKENT_GLOBAL_HOME']!, join(project, '.deckent')]) {
    for (const entry of await readdir(base, { recursive: true })) {
      const bytes = await readFile(join(base, String(entry))).catch(() => null);
      expect(bytes?.includes(Buffer.from(CANARY)) ?? false, String(entry)).toBe(false);
    }
  }
}, 60_000);
