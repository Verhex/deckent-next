import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { applyRunLifecycle } from '../../../src/index.js';
import { FileInstallationIdentityStore, readLocalOsIdentity } from '#adapters/index.js';
import { inspectConfiguredRun } from '#composition/core/runs/index.js';
import { InstallationIdentityError, RunDecisionApprovalBroker, type RunQuery } from '#engine/index.js';
import { clearConfigCache, productResourcePath, type ConfigLoadOptions } from '#platform/index.js';
import { main } from '#surfaces/index.js';
import { main as cliMain } from '#composition/core/cli/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import * as monitor from '#composition/core/monitor/index.js';
import * as cards from '#surfaces/core/cli-human/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { openConfiguredAttemptStore } from '../support/configured-open.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
  const configure = (data: string) => writeFile(join(root, '.deckent/config.json'), JSON.stringify({
    layout: { root: join(root, data) }, installation,
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
  const cli = (args: string[], tty: boolean, locale: 'en' | 'tr', entry: object = {}) => main(args, {
    root, env: options.env, locale, stdin: { isTTY: tty },
    stdout: { isTTY: tty, write: () => true }, stderr: { write: (line: string) => { errors.push(line); return true; } },
    applyRunLifecycle, inspectSurfaceRunIds: async () => [runId],
    inspectRun: inspectConfiguredRun,
    inspectRunControl: (project: string, query: RunQuery, config: ConfigLoadOptions) => inspectConfiguredRun(project, query, config, true), ...entry,
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
  // The same picker through the real CLI after a real entry repair (owner decision): the scope's Runs are listed under the repaired binding,
  // the person picks, the card shows the Run and a project that moved meanwhile stops it with the binding change; no Run row changes.
  await f.configure('selected');
  const { issuer, subject } = readLocalOsIdentity(), principals = [{ issuer, subject }];
  for (const data of ['attached', 'selected']) { // listing a scope's Runs reads its output collection
    await f.configure(data);
    await writeFile(productResourcePath((await loadComposedConfig(f.root, f.options)).productLayout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'local-control',
      restrictions: [], grants: [{ id: 'run', effect: 'allow', principals, scopes: [scopeId], actions: ['inspect', 'cancel'], resource: { kind: 'run', ids: [runId] } },
        { id: 'collection', effect: 'allow', principals, scopes: [scopeId], actions: ['read-output'], resource: { kind: 'attempt', ids: 'all' } }] }), { mode: 0o600 });
  }
  vi.spyOn(process, 'cwd').mockReturnValue(f.root);
  for (const [key, value] of Object.entries(f.options.env)) vi.stubEnv(key, value);
  for (const key of [...(await loadComposedConfig(f.root, f.options)).cli.agentEnvironment, 'CI']) vi.stubEnv(key, undefined);
  const rows = f.state().map(tables => tables.slice(0, 3));
  const relocated = vi.spyOn(FileInstallationIdentityStore.prototype, 'read').mockImplementationOnce(async () => { throw new InstallationIdentityError('INSTALLATION_IDENTITY_RELOCATED'); });
  const listed = vi.spyOn(monitor, 'inspectSurfaceRunIds');
  ask.mockReset();
  ask.mockImplementationOnce(async () => 'run-fixture').mockImplementationOnce(async () => {
    await f.configure('attached');
    return 'yes';
  });
  let output = '';
  const screen = Object.assign(new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } }), { isTTY: true });
  const stdio = [vi.spyOn(process, 'stdin', 'get').mockReturnValue(Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream),
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(screen as NodeJS.WriteStream), vi.spyOn(process, 'stderr', 'get').mockReturnValue(screen as NodeJS.WriteStream)];
  try { expect(await cliMain([...argv.slice(0, 4), '--lang', 'en'])).toBe(1); }
  finally { stdio.forEach(spy => spy.mockRestore()); }
  expect(relocated).toHaveBeenCalled();
  expect(listed.mock.calls[0]?.[3]).toEqual(expect.any(String));
  expect(ask).toHaveBeenCalledTimes(2);
  expect(ask.mock.calls[1]![0].body!.join('\n')).toContain('State running · revision 1');
  expect(output).toContain(english);
  expect(f.state().map(tables => tables.slice(0, 3))).toEqual(rows);
});

it.skipIf(process.platform === 'win32')('refuses SDK, typed CLI and JSON hold when the installation changes after the decision', async () => {
  const f = await fixture(), before = f.state();
  const authorize = RunDecisionApprovalBroker.prototype.authorize;
  const switchAfterDecision = () => vi.spyOn(RunDecisionApprovalBroker.prototype, 'authorize').mockImplementationOnce(async function (this: RunDecisionApprovalBroker, ...args) {
    const decision = await authorize.apply(this, args);
    await f.configure('attached');
    return decision;
  });
  // The first read is refused for a reason a repair may resolve and the project then points to another healthy installation with the same
  // scope, Run and revision. The SDK keeps its read-only refusal; the real CLI entry (owner 2026-11-27 repair path) stops with the binding
  // change before any write in either installation.
  const relocatedOnce = () => vi.spyOn(FileInstallationIdentityStore.prototype, 'read').mockImplementationOnce(async () => {
    await f.configure('attached');
    throw new InstallationIdentityError('INSTALLATION_IDENTITY_RELOCATED');
  });
  let relocated = relocatedOnce();
  await expect(applyRunLifecycle(f.root, command, f.options)).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
  expect(relocated).toHaveBeenCalled();
  relocated.mockRestore();
  expect(f.state()).toEqual(before);
  await f.configure('selected');
  vi.spyOn(process, 'cwd').mockReturnValue(f.root);
  for (const [key, value] of Object.entries(f.options.env)) vi.stubEnv(key, value);
  let output = '';
  const writes = [process.stdout, process.stderr].map(stream => vi.spyOn(stream, 'write').mockImplementation(((text: string) => { output += text; return true; }) as typeof stream.write));
  relocated = relocatedOnce();
  try { expect(await cliMain([...argv, '--command-id', command.commandId, '--expected-revision', '1', '--reason', command.holdReason, '--lang', 'en'])).toBe(1); }
  finally { writes.forEach(write => write.mockRestore()); }
  expect(relocated).toHaveBeenCalled();
  relocated.mockRestore();
  expect(output).toContain(english);
  expect(f.state()).toEqual(before);
  await f.configure('selected');
  // The entry's repaired binding reaches the control: one the control does not find stops the typed hold and the card before any write.
  const repairedElsewhere = { loadInstallationIdentity: async () => ({}), preflightRunControl: async () => 'repaired:elsewhere' };
  const asked = vi.spyOn(cards, 'askCliCard').mockResolvedValue('no');
  for (const [args, tty] of [[[...argv, '--command-id', command.commandId, '--expected-revision', '1', '--reason', command.holdReason], false], [argv, true]] as const) {
    await expect(f.cli([...args], tty, 'en', repairedElsewhere)).resolves.toBe(1);
    expect(f.errors.splice(0).join('')).toContain(english);
    expect(f.state()).toEqual(before);
  }
  expect(asked).not.toHaveBeenCalled();
  asked.mockRestore();
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
  // A short id after a real entry repair resolves only under the repaired binding: a list read while the project points elsewhere stops the
  // call, even when the project points back before the control. Runs, receipts and audit rows stay as they were in both databases (the
  // repair's own scope pin is the accepted cost, so it runs last).
  await f.configure('selected');
  const kept = () => f.state().map(tables => tables.slice(0, 3));
  const rows = kept(), listIds = monitor.inspectSurfaceRunIds;
  relocated = vi.spyOn(FileInstallationIdentityStore.prototype, 'read').mockImplementationOnce(async () => { throw new InstallationIdentityError('INSTALLATION_IDENTITY_RELOCATED'); });
  const listed = vi.spyOn(monitor, 'inspectSurfaceRunIds').mockImplementationOnce(async (...args: Parameters<typeof listIds>) => {
    await f.configure('attached');
    try { return await listIds(...args); } finally { await f.configure('selected'); }
  });
  output = '';
  const captured = [process.stdout, process.stderr].map(stream => vi.spyOn(stream, 'write').mockImplementation(((text: string) => { output += text; return true; }) as typeof stream.write));
  try { expect(await cliMain(['run', 'hold', '--scope', scopeId, '--id', 'run-fix', '--command-id', 'hold-prefix', '--expected-revision', '1', '--reason', 'wait', '--lang', 'en'])).toBe(1); }
  finally { captured.forEach(write => write.mockRestore()); }
  expect(relocated).toHaveBeenCalled();
  expect(listed).toHaveBeenCalledOnce();
  relocated.mockRestore(); listed.mockRestore();
  expect(output).toContain(english);
  expect(kept()).toEqual(rows);
  // The person's card after a real entry repair: a Run absent where the project now points is the binding change, not "not found"; under the
  // repaired binding a Run that is really absent stays RUN_NOT_FOUND. No card is asked and no row changes.
  for (const key of [...(await loadComposedConfig(f.root, f.options)).cli.agentEnvironment, 'CI']) vi.stubEnv(key, undefined);
  const { issuer, subject } = readLocalOsIdentity();
  for (const data of ['attached', 'selected']) { // the absent Run may be inspected in both installations, so its absence is what is read
    await f.configure(data);
    await writeFile(productResourcePath((await loadComposedConfig(f.root, f.options)).productLayout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'local-control',
      restrictions: [], grants: [{ id: 'run', effect: 'allow', principals: [{ issuer, subject }], scopes: [scopeId], actions: ['inspect', 'cancel'],
        resource: { kind: 'run', ids: [runId, 'no-such-run'] } }] }), { mode: 0o600 });
  }
  for (const elsewhere of [true, false]) {
    await f.configure('selected');
    relocated = vi.spyOn(FileInstallationIdentityStore.prototype, 'read').mockImplementationOnce(async () => { throw new InstallationIdentityError('INSTALLATION_IDENTITY_RELOCATED'); });
    const resolved = vi.spyOn(monitor, 'inspectSurfaceRunIds').mockImplementationOnce(async (...args: Parameters<typeof listIds>) => {
      try { return await listIds(...args); } finally { if (elsewhere) await f.configure('attached'); }
    });
    const asked = vi.spyOn(cards, 'askCliCard').mockResolvedValue('no');
    output = '';
    const screen = Object.assign(new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } }), { isTTY: true });
    const stdio = [vi.spyOn(process, 'stdin', 'get').mockReturnValue(Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream),
      vi.spyOn(process, 'stdout', 'get').mockReturnValue(screen as NodeJS.WriteStream), vi.spyOn(process, 'stderr', 'get').mockReturnValue(screen as NodeJS.WriteStream)];
    try { expect(await cliMain(['run', 'hold', '--scope', scopeId, '--id', 'no-such-run', '--lang', 'en'])).not.toBe(0); }
    finally { stdio.forEach(spy => spy.mockRestore()); }
    expect(relocated).toHaveBeenCalled();
    expect(resolved).toHaveBeenCalledOnce();
    expect(asked).not.toHaveBeenCalled();
    relocated.mockRestore(); resolved.mockRestore(); asked.mockRestore();
    if (elsewhere) expect(output).toContain(english);
    else { expect(output).not.toContain(english); expect(output).toContain('no-such-run'); }
    expect(kept()).toEqual(rows);
  }
});
