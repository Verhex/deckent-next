import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '../src/composition/core/config/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { getConfigFieldDefault, loadConfig, productResourcePath, resolveProductLayout, prepareProductFile } from '#platform/index.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'config-app-')); roots.push(root);
  const options = { env: { DECKENT_GLOBAL_HOME: join(root, 'global') } };
  await applyPolicyTemplateInstallation(root, 'installation');
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: root }), 'ledger', ['-wal', '-shm', '-journal']);
  openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close();
  const principal = await resolveConfiguredConfigPrincipal(root, 'installation', options);
  const app = createConfiguredConfigApplication(root, options), path = join(root, '.deckent/config.json');
  const command = { principal, scopeId: 'installation', commandId: 'c1' };
  return { root, path, options, principal, app, command };
}
describe('configured config through real policy, ledger audit and atomic writer', () => {
  it('sets, snapshots a versioned backup, records value-free sealed audit and unsets', async () => {
    const f = await setup();
    const first = await f.app.set({ ...f.command, keyPath: 'max_workers', value: 2 });
    expect(first.backupPath).toBeNull(); expect((await loadConfig(f.root, f.options)).max_workers).toBe(2);
    const bytes = await readFile(f.path, 'utf8'); const inspected = await f.app.inspect();
    const result = await f.app.set({ ...f.command, commandId: 'c2', keyPath: 'max_workers', value: 3, expect: inspected.digest });
    expect(result.backupPath).not.toBeNull(); expect(await readFile(result.backupPath!, 'utf8')).toBe(bytes);
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ max_workers: 3 });
    const db = new DatabaseSync(productResourcePath(resolveProductLayout({ projectRoot: f.root }), 'ledger'), { readOnly: true });
    try { const rows = db.prepare('SELECT record FROM audit_events').all(); expect(rows).toHaveLength(2); const recorded = JSON.stringify(rows); expect(recorded).toContain('config-change'); expect(recorded).not.toContain('"value"'); } finally { db.close(); }
    await f.app.unset({ ...f.command, commandId: 'c3', keyPath: 'max_workers' }); expect((await loadConfig(f.root, f.options)).max_workers).toBe('auto');
  });
  it('refuses invalid value, stale preimage, secrets and denied authority without file changes', async () => {
    const f = await setup(); await f.app.set({ ...f.command, keyPath: 'max_workers', value: 2 });
    const inspected = await f.app.inspect(), bytes = await readFile(f.path, 'utf8');
    await expect(f.app.set({ ...f.command, keyPath: 'max_workers', value: -1 })).rejects.toThrow(); expect(await readFile(f.path, 'utf8')).toBe(bytes);
    await writeFile(f.path, `${JSON.stringify({ schema_version: 4, max_workers: 3 })}\n`); const changed = await readFile(f.path, 'utf8');
    await expect(f.app.set({ ...f.command, keyPath: 'max_workers', value: 4, expect: inspected.digest })).rejects.toMatchObject({ code: 'CONFIG_CONCURRENT_REVISION_HOLD' });
    await expect(f.app.set({ ...f.command, keyPath: 'secrets.backend', value: 'should-never-print' })).rejects.toMatchObject({ code: 'CONFIG_SECRET_SECTION_REFUSED' });
    await expect(f.app.set({ ...f.command, principal: { ...f.principal, subject: 'other' }, keyPath: 'max_workers', value: 4 })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await readFile(f.path, 'utf8')).toBe(changed); expect((await readdir(join(f.root, '.deckent'))).filter(name => name.includes('.bak.'))).toHaveLength(0);
  });
  it('identifies env overrides and leaves project value explicitly overridden', async () => {
    const f = await setup(); const app = createConfiguredConfigApplication(f.root, { env: { ...f.options.env, DECKENT_LANGUAGE: 'tr' } });
    expect(await app.explain({ keyPath: 'language' })).toMatchObject({ source: 'env', value: 'tr' });
    const result = await app.set({ ...f.command, keyPath: 'language', value: 'en' }); expect(result.overridden).toBe(true);
    expect(JSON.parse(await readFile(f.path, 'utf8')).language).toBe('en');
  });
});

it('sets a sparse project override over globally declared execution without copying siblings, and rejects bad leaves before audit', async () => {
  const f = await setup();
  const execution = { docker: { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}`, memoryBytes: 2147483648, pids: 128, cpus: 2,
    logMaxSizeKiB: 1024, logMaxFiles: 2, tmpBytes: 1048576, deadlineMs: 60000, controlTimeoutMs: 5000, outputBytes: 65536 },
    git: { gitExecutable: 'git', timeoutMs: 5000 } };
  await f.app.set({ ...f.command, keyPath: 'execution', value: execution, layer: 'global' });
  await f.app.set({ ...f.command, commandId: 'sparse', keyPath: 'execution.docker.memoryBytes', value: 1073741824 });
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ execution: { docker: { memoryBytes: 1073741824 } } });
  expect(JSON.parse(await readFile(f.path, 'utf8')).execution.docker.executable).toBeUndefined();
  expect((await loadConfig(f.root, f.options)).execution?.docker.executable).toBe('docker');
  expect(await f.app.explain({ keyPath: 'execution.docker.memoryBytes' })).toMatchObject({ source: 'project', value: 1073741824 });
  const before = await readFile(f.path, 'utf8'); const db = new DatabaseSync(productResourcePath(resolveProductLayout({ projectRoot: f.root }), 'ledger'), { readOnly: true });
  try { const count = db.prepare('SELECT count(*) as count FROM audit_events').get();
    await expect(f.app.set({ ...f.command, keyPath: 'execution.docker.memoryBytes', value: -1 })).rejects.toThrow();
    expect(await readFile(f.path, 'utf8')).toBe(before); expect(db.prepare('SELECT count(*) as count FROM audit_events').get()).toEqual(count);
  } finally { db.close(); }
});

it('validates sparse discriminated-union overlays against the selected original branch', async () => {
  const f = await setup();
  const execution = { docker: { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}`, memoryBytes: 2147483648, pids: 128, cpus: 2,
    logMaxSizeKiB: 1024, logMaxFiles: 2, tmpBytes: 1048576, deadlineMs: 60000, controlTimeoutMs: 5000, outputBytes: 65536 },
    git: { gitExecutable: 'git', timeoutMs: 5000 }, workTargets: { schemaVersion: 1, targets: [{ id: 'main', kind: 'git', path: '/tmp/target', baseRef: 'refs/heads/main' }] } };
  await f.app.set({ ...f.command, keyPath: 'execution', value: execution, layer: 'global' });
  await f.app.set({ ...f.command, commandId: 'union-overlay', keyPath: 'execution.workTargets.schemaVersion', value: 2 });
  expect((await loadConfig(f.root, f.options)).execution?.workTargets).toMatchObject({ schemaVersion: 2, targets: execution.workTargets.targets });
  expect(JSON.parse(await readFile(f.path, 'utf8')).execution.workTargets).toEqual({ schemaVersion: 2 });
  const before = await readFile(f.path, 'utf8');
  for (const [keyPath, value] of [['execution.workTargets.schemaVersion', 999], ['execution.workTargets', null], ['storage.sqlite', null]] as const) {
    await expect(f.app.set({ ...f.command, keyPath, value })).rejects.toThrow(); expect(await readFile(f.path, 'utf8')).toBe(before);
  }
});
