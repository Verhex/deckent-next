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

// SECRET-WRITE on the shipped processes: compiled `runtime serve` + compiled `deckent secret set|delete|list`. The value is piped on stdin
// (never argv); the change is decided by the fresh install's template v2 grant, audited in the ledger and stored in the file backend. A
// synthetic canary is searched in every byte the processes printed, in the ledger files and in the installation's state directory.
type Child = ChildProcess & { stdout: NonNullable<ChildProcess['stdout']>; stderr: NonNullable<ChildProcess['stderr']>; stdin: NonNullable<ChildProcess['stdin']> };
const CANARY = 'synthetic-canary-0b4d9f-not-a-real-key';
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

it.skipIf(process.platform !== 'linux').each(['core.secret-store.file@1', 'core.secret-store.encrypted-file@1'])('compiled CLI + service (%s): secret set/delete over the socket, value from stdin only, never printed, logged or recorded', async backend => {
  const sealed = backend === 'core.secret-store.encrypted-file@1';
  registerProviderConfig();
  const root = await mkdtemp(join(tmpdir(), 'deckent-secret-process-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
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
  await writeFile(globalPath, JSON.stringify({ secrets: { store: backend } }), { mode: 0o600 });
  const opened = await openConfiguredAttemptStore(project, { env }); const ledger = opened.path, dataRoot = opened.layout.root;
  opened.store.close(); clearConfigCache();

  const service = spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] }) as Child;
  children.add(service); let serviceOut = ''; service.stdout.on('data', chunk => { serviceOut += String(chunk); }); service.stderr.on('data', chunk => { serviceOut += String(chunk); });
  await ready(service);

  const printed: string[] = [];
  const set = await run(['secret', 'set', 'PROVIDER_TOKEN', '--json'], project, env, `${CANARY}\n`); printed.push(set.stdout, set.stderr);
  expect(set.code, set.stderr).toBe(0);
  expect(JSON.parse(set.stdout)).toEqual({ schemaVersion: 1, scopeId: 'installation', name: 'PROVIDER_TOKEN', action: 'set', backend, removed: null });
  if (sealed) {
    // SECRET-AT-REST: the service wrote a sealed store that opens with the installation key; no file of the root holds the value or the name.
    expect(await createEncryptedFileSecretStore({ root: globalRoot, platform: 'linux' }).get('PROVIDER_TOKEN')).toBe(CANARY);
    for (const entry of await readdir(globalRoot, { recursive: true })) {
      const bytes = await readFile(join(globalRoot, String(entry))).catch(() => null);
      expect(bytes?.includes(Buffer.from(CANARY)) ?? false, String(entry)).toBe(false);
      if (String(entry) === 'secrets.sealed.json') expect(bytes!.includes(Buffer.from('PROVIDER_TOKEN'))).toBe(false);
    }
    await expect(readFile(join(globalRoot, 'secrets.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } else {
    const stored = JSON.parse(await readFile(join(globalRoot, 'secrets.json'), 'utf8')) as { secrets: Record<string, string> };
    expect(stored.secrets).toEqual({ PROVIDER_TOKEN: CANARY });
  }
  const listed = await run(['secret', 'list', '--json'], project, env); printed.push(listed.stdout, listed.stderr);
  expect(JSON.parse(listed.stdout)).toMatchObject({ names: ['PROVIDER_TOKEN'] });
  // A value on argv is a usage refusal before anything is sent.
  const argv = await run(['secret', 'set', 'OTHER', CANARY, '--json'], project, env); printed.push(argv.stdout, argv.stderr);
  expect(argv.code).toBe(2);
  const removed = await run(['secret', 'delete', 'PROVIDER_TOKEN', '--json'], project, env); printed.push(removed.stdout, removed.stderr);
  expect(JSON.parse(removed.stdout)).toMatchObject({ action: 'delete', removed: true });
  if (sealed) expect(await createEncryptedFileSecretStore({ root: globalRoot, platform: 'linux' }).listNames()).toEqual([]);
  else expect(JSON.parse(await readFile(join(globalRoot, 'secrets.json'), 'utf8'))).toEqual({ schemaVersion: 1, secrets: {} });

  const db = new DatabaseSync(ledger, { readOnly: true });
  let subjects: unknown[];
  try { subjects = db.prepare('SELECT record FROM audit_events ORDER BY sequence').all().map(row => (JSON.parse(String(row['record'])) as { event: { subject: unknown } }).event.subject); }
  finally { db.close(); }
  expect(subjects).toEqual(['set', 'delete'].map(action => ({ kind: 'secret-change', action, name: 'PROVIDER_TOKEN', backend,
    decision: { effect: 'allow', ruleId: 'first-run-secret-store' } })));

  service.kill('SIGTERM'); await new Promise(done => service.once('close', done));
  // Canary scan: process output, the ledger files, and every file under the installation's data root (policy, audit, state, sockets).
  expect(printed.join('\n') + serviceOut).not.toContain(CANARY);
  const hits: string[] = [];
  for (const directory of [dirname(ledger), dataRoot]) {
    for (const entry of await readdir(directory, { recursive: true }).catch(() => [] as string[])) {
      const bytes = await readFile(join(directory, String(entry))).catch(() => null);
      if (bytes?.includes(Buffer.from(CANARY))) hits.push(join(directory, String(entry)));
    }
  }
  expect(hits).toEqual([]);
}, 60_000);
