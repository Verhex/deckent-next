import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { executeBackup, clearConfigCache, loadConfig, resolveProductLayout, productResourcePath, startConfiguredRuntimeService } from '../../../src/index.js';
import { FileInstallationIdentityStore } from '#adapters/core/installation-files/index.js';
import { openLocalIntegrityAuthority } from '#adapters/core/local-keyring/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { readLocalOsIdentity } from '#adapters/core/local-principal/index.js';
import { firstRunPolicyTemplate } from '#domain/index.js';
import { restoreHoldPath } from '#platform/index.js';
import { openConfiguredArtifactStore } from '#composition/core/artifacts/index.js';
import { inspectConfiguredRecoveryFiles } from '#composition/core/backup/index.js';
import { runKernelCommand } from '#surfaces/core/cli/index.js';

/** Astra 2471 R1: every publication rename of a restore can fail (or the process can die); the installation then stays held. */
const gate = vi.hoisted(() => ({ failAt: 0, seen: 0, under: [] as string[], mkdirs: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, mkdir: (async (path: Parameters<typeof real.mkdir>[0], options?: Parameters<typeof real.mkdir>[1]) => { gate.mkdirs.push(String(path)); return real.mkdir(path, options); }) as typeof real.mkdir,
    rename: async (from: Parameters<typeof real.rename>[0], to: Parameters<typeof real.rename>[1]) => {
    const path = String(to);
    if (gate.failAt && gate.under.some(root => path.startsWith(root + '/')) && !path.endsWith('restore-hold.json') && ++gate.seen === gate.failAt)
      throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
    return real.rename(from, to);
  } };
});
const roots: string[] = [], phrase = 'CANARY-restore-hold-passphrase';
afterEach(async () => { gate.failAt = 0; clearConfigCache(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'deckent-restore-hold-')); roots.push(base);
  const root = join(base, 'project'), data = join(base, 'data'), env = { HOME: join(base, 'home'), DECKENT_GLOBAL_HOME: join(base, 'global'), NO_COLOR: '1' };
  const layout = resolveProductLayout({ projectRoot: root, root: data });
  for (const dir of [root, join(root, '.deckent'), data, join(data, 'state'), join(data, 'artifacts')]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = (path: string, value: unknown) => writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  await file(join(root, '.deckent/config.json'), { layout: { root: data }, backup: { schedule: 'off' },
    cancellation: { maxConcurrentDeliveries: 1 }, cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { identity: { scopeId: 'scope', serviceId: 'restore-hold-host' } }, toolchains: { update: { atStartup: false, intervalMs: 0 } } });
  await new FileInstallationIdentityStore(layout, 2000).loadOrCreate();
  await openLocalIntegrityAuthority(layout, 'authority.key', true);
  const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: readLocalOsIdentity(), readToolNames: ['read_file'], scratchToolNames: ['write_scratch'],
    scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['edit_file', 'run_shell'], writeOperationId: 'workspace.file.write', shellOperationId: 'shell.execute',
    proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' });
  await file(productResourcePath(layout, 'policy'), template.policy); await file(productResourcePath(layout, 'bindings'), template.bindings);
  await file(join(data, 'artifacts/result.txt'), 'retained artifact');
  const ledger = productResourcePath(layout, 'ledger'), db = openSqliteLedger(ledger, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' });
  db.exec('CREATE TABLE restore_marker(n INTEGER NOT NULL); INSERT INTO restore_marker VALUES(1);'); db.close(); await chmod(ledger, 0o600);
  const set = join(base, 'set');
  await executeBackup(root, { schemaVersion: 1, scopeId: 'scope', action: 'create', set }, phrase, { env });
  return { base, root, data, env, set, hold: restoreHoldPath(root) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const restore = (f: Fixture) => executeBackup(f.root, { schemaVersion: 1, scopeId: 'scope', action: 'restore', set: f.set, target: f.root, confirmTarget: f.root }, phrase, { env: f.env });
const present = (path: string) => lstat(path).then(() => true, () => false);
async function startsAndStops(f: Fixture) {
  if (process.platform !== 'linux') return;
  const service = await startConfiguredRuntimeService(f.root, { async onPage() {}, async onError() {} }, { env: f.env });
  await service.stop(); await service.done;
}
async function heldAgainstNormalAdmission(f: Fixture) {
  expect(await present(f.hold)).toBe(true); clearConfigCache();
  await expect(loadConfig(f.root, { env: f.env })).rejects.toMatchObject({ code: 'BACKUP_RESTORE_HOLD' });
  await expect(executeBackup(f.root, { schemaVersion: 1, scopeId: 'scope', action: 'verify', set: f.set }, phrase, { env: f.env })).rejects.toMatchObject({ code: 'BACKUP_RESTORE_HOLD' });
  if (process.platform === 'linux') await expect(startConfiguredRuntimeService(f.root, { async onPage() {}, async onError() {} }, { env: f.env }))
    .rejects.toMatchObject({ code: 'BACKUP_RESTORE_HOLD' });
}

it('an injected failure at every publication step leaves a durable hold that refuses normal admission until a rerun restore completes', async () => {
  const f = await fixture(); gate.under = [f.root, f.data];
  let failAt = 1;
  for (; ; failAt++) {
    gate.failAt = failAt; gate.seen = 0;
    const outcome = await restore(f).then(() => 'completed', (error: { code?: string }) => error.code); gate.failAt = 0;
    if (outcome === 'completed') break;
    if (failAt === 1) {
      // The first rename preserves the old config: nothing published yet, so this attempt withdraws its own hold.
      expect(outcome).toBe('BACKUP_IO'); expect(await present(f.hold)).toBe(false); await startsAndStops(f); continue;
    }
    expect(outcome).toBe('BACKUP_RESTORE_INCOMPLETE');
    await heldAgainstNormalAdmission(f);
    await restore(f); expect(await present(f.hold)).toBe(false); clearConfigCache();
    await expect(loadConfig(f.root, { env: f.env })).resolves.toMatchObject({ projectRoot: resolve(f.root) });
    await startsAndStops(f);
  }
  // config, installation/project identity, policy, bindings, audit, artifacts, authority key and ledger: each replaces an existing entry.
  expect(failAt - 1).toBeGreaterThanOrEqual(18);
}, 300_000);

it('a rerun restore of a held installation keeps the layout of the interrupted attempt, not the archived map (Astra 2471 R1 + R2)', async () => {
  const f = await fixture(), path = join(f.root, '.deckent/config.json'), config = JSON.parse(await readFile(path, 'utf8'));
  config.layout.resources = { artifacts: 'artifacts-v2' }; await writeFile(path, JSON.stringify(config));
  await rename(join(f.data, 'artifacts'), join(f.data, 'artifacts-v2')); clearConfigCache(); gate.under = [f.root, f.data];
  // Renames 1–2 publish the restored config (naming artifacts-v2); rename 3 fails while preserving the installation identity.
  gate.failAt = 3; gate.seen = 0;
  await expect(restore(f)).rejects.toMatchObject({ code: 'BACKUP_RESTORE_INCOMPLETE' }); gate.failAt = 0;
  await heldAgainstNormalAdmission(f);
  await restore(f); clearConfigCache();
  const reopened = await openConfiguredArtifactStore(f.root, { env: f.env });
  expect(reopened.path).toBe(join(f.data, 'artifacts-v2'));
  expect(await readFile(join(reopened.path, 'result.txt'), 'utf8')).toBe('retained artifact');
  await startsAndStops(f);
}, 60_000);

it.skipIf(process.platform !== 'linux')('a process killed between publications leaves the hold; the restart is refused and a rerun restore admits the service again', async () => {
  const f = await fixture(), preload = join(f.base, 'kill-at.cjs');
  await writeFile(preload, `const fsp = require('node:fs/promises'); const { syncBuiltinESMExports } = require('node:module');
    const real = fsp.rename, at = Number(process.env.KILL_AT), under = JSON.parse(process.env.KILL_UNDER); let seen = 0;
    fsp.rename = async (from, to) => { const path = String(to);
      if (under.some(root => path.startsWith(root + '/')) && !path.endsWith('restore-hold.json') && ++seen === at) process.kill(process.pid, 'SIGKILL');
      return real(from, to); };
    syncBuiltinESMExports();`, { mode: 0o600 });
  const script = `const m = await import(${JSON.stringify(pathToFileURL(resolve('dist/index.js')).href)});
    await m.executeBackup(${JSON.stringify(f.root)}, { schemaVersion: 1, scopeId: 'scope', action: 'restore', set: ${JSON.stringify(f.set)}, target: ${JSON.stringify(f.root)}, confirmTarget: ${JSON.stringify(f.root)} }, ${JSON.stringify(phrase)}, { env: ${JSON.stringify(f.env)} });`;
  // Step 8 replaces the policy: config and identities are already the restored ones, the ledger is still the old one.
  const killed = await promisify(execFile)(process.execPath, ['--require', preload, '--input-type=module', '-e', script],
    { env: { ...process.env, ...f.env, KILL_AT: '8', KILL_UNDER: JSON.stringify([f.root, f.data]) }, timeout: 60_000 }).then(() => null, (error: { signal?: string }) => error.signal);
  expect(killed).toBe('SIGKILL');
  await heldAgainstNormalAdmission(f);
  await restore(f); expect(await present(f.hold)).toBe(false);
  await startsAndStops(f);
}, 120_000);

async function walkFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) out.push(...await walkFiles(path)); else out.push(path);
  }
  return out;
}
const stagesIn = async (directory: string) => (await readdir(directory)).filter(name => name.startsWith('.backup-restore-'));
it('an interrupted restore stages in the private .deckent area without the decrypted key; doctor names leftovers and the next restore removes them (S1 D4)', async () => {
  const f = await fixture(), key = await readFile(join(f.data, 'approvals/authority.key')), area = join(f.root, '.deckent');
  gate.under = [f.root, f.data]; gate.failAt = 2; gate.seen = 0;
  await expect(restore(f)).rejects.toMatchObject({ code: 'BACKUP_RESTORE_INCOMPLETE' }); gate.failAt = 0;
  expect(await stagesIn(f.root)).toEqual([]);
  const [stage] = await stagesIn(area); expect(stage).toMatch(/^\.backup-restore-[0-9a-f-]{36}$/);
  expect((await lstat(join(area, stage!))).mode & 0o777).toBe(0o700);
  expect(await readFile(join(area, stage!, '.gitignore'), 'utf8')).toBe('*\n');
  const staged = await walkFiles(join(area, stage!)); expect(staged.length).toBeGreaterThan(0);
  for (const file of staged) expect((await readFile(file)).equals(key)).toBe(false);
  await restore(f); expect(await stagesIn(area)).toEqual([]);
  // Process loss during staging leaves a stage without a hold; alpha.18 staged in the project root and also left a pending key.
  const uuid = () => crypto.randomUUID(), planted = [join(area, `.backup-restore-${uuid()}`), join(f.root, `.backup-restore-${uuid()}`)];
  for (const dir of planted) { await mkdir(dir, { mode: 0o700 }); await writeFile(join(dir, 'ledger.db'), 'plain', { mode: 0o600 }); }
  const keyTemp = join(f.data, `approvals/.authority.key.restore-${uuid()}`), pendingHold = `${f.hold}.${uuid()}`;
  await writeFile(keyTemp, key, { mode: 0o600 }); await writeFile(pendingHold, '{}', { mode: 0o600 });
  await mkdir(join(area, '.backup-restore-not-a-uuid'), { mode: 0o700 });
  const doctor = async (args: string[]) => { let text = ''; clearConfigCache();
    await runKernelCommand(['doctor', ...args], { root: f.root, env: f.env, stdout: { write: (chunk: string) => { text += chunk; return true; } }, inspectRecoveryFiles: inspectConfiguredRecoveryFiles });
    return text; };
  expect(JSON.parse(await doctor(['--json'])).recoveryFiles.leftovers.sort()).toEqual([...planted, keyTemp, pendingHold].sort());
  expect(await doctor(['--lang', 'en'])).toContain('Interrupted backup restore files remain');
  expect(await doctor(['--lang', 'tr'])).toContain('Yarım kalan yedek geri yüklemesinin dosyaları duruyor');
  await restore(f);
  for (const path of [...planted, keyTemp, pendingHold]) expect(await present(path)).toBe(false);
  expect(await present(join(area, '.backup-restore-not-a-uuid'))).toBe(true);
  expect(JSON.parse(await doctor(['--json'])).recoveryFiles).toEqual({ leftovers: [], installationDirectory: { path: area, mode: '0700' } });
  await startsAndStops(f);
}, 60_000);

it('a .deckent readable by others (0755) restores in place without a manual step; one others can write is refused before staging with the path and chmod 700 (S1 D2)', async () => {
  const f = await fixture(), area = join(f.root, '.deckent');
  await chmod(area, 0o755); await writeFile(join(f.root, '.deckent/config.json'), '{broken'); clearConfigCache();
  await restore(f); expect((await lstat(area)).mode & 0o777).toBe(0o755); clearConfigCache();
  await expect(loadConfig(f.root, { env: f.env })).resolves.toMatchObject({ projectRoot: resolve(f.root) });
  let text = ''; await runKernelCommand(['doctor', '--json'], { root: f.root, env: f.env, stdout: { write: (chunk: string) => { text += chunk; return true; } }, inspectRecoveryFiles: inspectConfiguredRecoveryFiles });
  expect(JSON.parse(text).recoveryFiles.installationDirectory).toEqual({ path: area, mode: '0755' });
  text = ''; await runKernelCommand(['doctor', '--lang', 'en'], { root: f.root, env: f.env, stdout: { write: (chunk: string) => { text += chunk; return true; } }, inspectRecoveryFiles: inspectConfiguredRecoveryFiles });
  expect(text).toContain(`The installation directory ${area} has mode 0755`); expect(text).toContain(`chmod 700 ${area}`);
  await chmod(area, 0o775); gate.mkdirs = [];
  const refused = await restore(f).then(() => null, (error: { code?: string; params?: Record<string, string>; message?: string }) => error);
  expect(refused).toMatchObject({ code: 'BACKUP_DIRECTORY_UNSAFE', params: { path: area } }); expect(refused?.message).toContain(`chmod 700 ${area}`);
  expect(gate.mkdirs.filter(path => path.includes('.backup-restore-'))).toEqual([]);
  expect(await present(f.hold)).toBe(false); expect((await lstat(area)).mode & 0o777).toBe(0o775);
  await chmod(area, 0o700); await restore(f); await startsAndStops(f);
}, 60_000);
