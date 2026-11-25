import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { applyRunLifecycle } from '../../../src/index.js';
import { readLocalOsIdentity } from '#adapters/index.js';
import { inspectConfiguredRun } from '#composition/core/runs/index.js';
import { RunDecisionApprovalBroker, type RunQuery } from '#engine/index.js';
import { clearConfigCache, productResourcePath, t, withConfigWriteLock, type ConfigLoadOptions } from '#platform/index.js';
import { main } from '#surfaces/index.js';
import * as cards from '#surfaces/core/cli-human/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { openConfiguredAttemptStore } from '../support/configured-open.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  clearConfigCache();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const runId = 'run-fixture', scopeId = 's', code = 'RUN_CONTROL_BINDING_CHANGED';
const english = 'The target or authority facts read for this operation changed. Read the work again in the project you mean and confirm.';
const turkish = 'Bu işlem için okunan hedef veya yetki bilgileri değişti. İstediğiniz projede işi yeniden okuyup onaylayın.';
const command = { schemaVersion: 1, scopeId, runId, commandId: 'hold-selected', expectedRevision: 1, action: 'hold', holdReason: 'wait' };
const argv = ['run', 'hold', '--scope', scopeId, '--id', runId];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-local-control-'));
  roots.push(root);
  const home = join(root, 'home'), options = { env: { HOME: home, USERPROFILE: home, TERM: 'xterm', NO_COLOR: '1' } };
  const installation = { machineIdentity: { source: join(root, 'machine-id') } };
  await writeFile(installation.machineIdentity.source, 'local-control-fixture', { mode: 0o600 });
  await mkdir(join(root, '.deckent'), { mode: 0o700 });
  const configure = (data: string, writeLockTimeoutMs?: number) => writeFile(join(root, '.deckent/config.json'), JSON.stringify({
    layout: { root: join(root, data) }, installation, ...(writeLockTimeoutMs ? { configFile: { writeLockTimeoutMs } } : {}),
  }), { mode: 0o600 });
  const { issuer, subject } = readLocalOsIdentity(), files: string[] = [];
  for (const data of ['selected', 'attached']) {
    await configure(data);
    const { store, layout, path } = await openConfiguredAttemptStore(root, options);
    try { await admitRunAttempts(store, [{ scopeId, runId, taskId: 't', attemptId: 'a', layoutRevision: 'fixture', generation: 1 }]); }
    finally { store.close(); }
    await writeFile(productResourcePath(layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'local-control', restrictions: [],
      grants: [{ id: 'run', effect: 'allow', principals: [{ issuer, subject }], scopes: [scopeId], actions: ['inspect', 'cancel'],
        resource: { kind: 'run', ids: [runId] } }] }), { mode: 0o600 });
    files.push(path);
  }
  await configure('selected');
  const state = () => files.map(path => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return ['runs', 'run_receipts', 'audit_events', 'scope_registry'].map(table => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    } finally { database.close(); }
  });
  const errors: string[] = [];
  const cli = (args: string[], tty: boolean, locale: 'en' | 'tr') => main(args, {
    root, env: options.env, locale, stdin: { isTTY: tty },
    stdout: { isTTY: tty, write: () => true }, stderr: { write: (line: string) => { errors.push(line); return true; } },
    applyRunLifecycle, inspectSurfaceRunIds: async () => [runId],
    inspectRun: inspectConfiguredRun,
    inspectRunControl: (project: string, query: RunQuery, config: ConfigLoadOptions) => inspectConfiguredRun(project, query, config, true),
  } as Parameters<typeof main>[1]);
  return { root, options, configure, state, cli, errors };
}

it.skipIf(process.platform === 'win32')('refuses a CLI picker card when the project changes installations before confirmation', async () => {
  const f = await fixture(), before = f.state();
  const ask = vi.spyOn(cards, 'askCliCard').mockImplementationOnce(async () => 'run-fixture').mockImplementationOnce(async () => {
    await f.configure('attached');
    return 'yes';
  });
  await expect(f.cli(argv.slice(0, 4), true, 'en')).resolves.toBe(1);
  expect(ask).toHaveBeenCalledTimes(2);
  expect(ask.mock.calls[1]![0].body!.join('\n')).toContain('State running · revision 1');
  expect(f.errors.join('')).toContain(english);
  expect(f.state()).toEqual(before);
});

it.skipIf(process.platform === 'win32')('refuses SDK, typed CLI and JSON hold when the installation changes after the decision', async () => {
  const f = await fixture(), before = f.state();
  const authorize = RunDecisionApprovalBroker.prototype.authorize;
  const switchAfterDecision = () => vi.spyOn(RunDecisionApprovalBroker.prototype, 'authorize').mockImplementationOnce(async function (this: RunDecisionApprovalBroker, ...args) {
    const decision = await authorize.apply(this, args);
    await f.configure('attached');
    return decision;
  });
  const sdk = switchAfterDecision();
  await expect(applyRunLifecycle(f.root, command, f.options)).rejects.toMatchObject({ code });
  sdk.mockRestore();
  expect(f.state()).toEqual(before);
  for (const json of [false, true]) {
    await f.configure('selected');
    const broker = switchAfterDecision();
    const flags = ['--command-id', command.commandId, '--expected-revision', '1', '--reason', command.holdReason];
    await expect(f.cli([...argv, ...flags, ...(json ? ['--json'] : [])], false, 'tr')).resolves.toBe(1);
    expect(broker).toHaveBeenCalledOnce();
    broker.mockRestore();
    expect(f.errors.splice(0).join('')).toContain(turkish);
    expect(f.state()).toEqual(before);
  }
  // Owner 196: the hold takes the project settings lock before its last bound read, on the configured budget (1 ms here: one try). Busy,
  // it is refused before any effect with the existing lock sentence; a refused Run control exits 1 (owner 155), --json included.
  const settings = join(f.root, '.deckent/config.json'), flags = ['--command-id', command.commandId, '--expected-revision', '1', '--reason', command.holdReason];
  await f.configure('selected', 1);
  await withConfigWriteLock(settings, async () => {
    await expect(applyRunLifecycle(f.root, command, f.options)).rejects.toMatchObject({ code: 'CONFIG_WRITE_LOCKED', params: { path: `${settings}.write-lock`, pid: process.pid } });
    for (const json of [false, true]) {
      await expect(f.cli([...argv, ...flags, ...(json ? ['--json'] : [])], false, 'tr')).resolves.toBe(1);
      expect(f.errors.splice(0).join('')).toContain(`Config kilidi ${settings}.write-lock, pid ${process.pid} tarafından tutuluyor`);
    }
  });
  expect(t('error.CONFIG_WRITE_LOCKED', { path: 'P', pid: 7, ageSeconds: 0 }, 'en')).toBe('Configuration lock P is held by pid 7 (age 0s).');
  expect(f.state()).toEqual(before);
  // Point 5(a): the lock cannot be created (no write access where the settings live): refused before any Run effect.
  if (process.getuid?.() !== 0) {
    await chmod(dirname(settings), 0o500);
    try { await expect(applyRunLifecycle(f.root, command, f.options)).rejects.toMatchObject({ code: 'CONFIG_READ_IO_HOLD' }); }
    finally { await chmod(dirname(settings), 0o700); }
    expect(f.state()).toEqual(before);
  }
  // An SDK caller may pass the project as a relative path: the lock is the one the initial read resolved, so the hold completes.
  await expect(applyRunLifecycle(relative(process.cwd(), f.root), command, f.options)).resolves.toMatchObject({ lifecycle: { commandId: command.commandId } });
});
