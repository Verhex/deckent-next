import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile, symlink, link, chmod, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverConfiguredWorkspaceIntegration, inspectConfiguredWorkspaceIntegration, checkConfiguredWorkspaceIntegration, prepareConfiguredWorkspaceIntegration, previewConfiguredWorkspacePatch } from '../../../src/index.js';
import { DockerSupervisor, GitIntegrationTarget, GitIntegrationDelivery } from '#adapters/index.js';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteAttemptStore, validateDockerSupervisorProfile } from '#adapters/index.js';
import { WorkspacePatchApplication, patchPathSchema } from '#engine/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { workspacePatchFixture, readyDeliveryFixture as readyDeliveryFixtureFor } from '../support/workspace-patch-fixture.js';
const exec = promisify(execFile); const roots: string[] = []; const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  clearConfigCache(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = (restartable = false) => workspacePatchFixture({ roots, cleanup }, { restartable });
it('rejects path traversal, control characters and protected metadata in patch documents', () => {
  for (const path of ['../escape', '/absolute', 'a//b', 'a/./b', 'a\\b', 'a\nb', '.codex/auth.json', 'x/.env.local', '.git/config']) expect(patchPathSchema.safeParse(path).success).toBe(false);
});
describe.skipIf(process.platform !== 'linux' || !process.env.DECKENT_TEST_DOCKER_IMAGE)('configured workspace patch', () => {
  it('prepares and previews real edit/add/delete through SDK and binary CLI, keeps owner HEAD/WIP, survives release and detects corrupted bytes', async () => {
    const f = await fixture(); const workspace = await f.run();
    await f.git('commit', '--allow-empty', '-m', 'owner advances');
    const prepared = await f.cli('patch-prepare');
    expect(prepared.patch.baseCommit).toBe(f.base); expect(prepared.application).toBe('not-applied');
    expect(prepared.patch.changes.map(x => x.path)).toEqual(['added.txt', 'note.txt', 'removed.txt']);
    expect(prepared.patch.changes[1]).toMatchObject({ before: { text: 'before\n' }, after: { text: 'after\n' } });
    expect(JSON.stringify(prepared)).not.toContain('synthetic-private');
    expect(await readFile(join(f.project, 'note.txt'), 'utf8')).toBe('owner-wip\n');
    await expect(readFile(join(workspace, 'hook-fired'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await Promise.all([f.prepare(), f.prepare()])).toEqual([prepared, prepared]);
    expect(await f.preview()).toEqual(prepared); expect(await f.cli('patch-preview')).toEqual(prepared);
    const record = (await f.runtime.store.loadBoundDispatch(f.identity))!;
    await (await DockerSupervisor.restoreProfile(record.profile)).release(record.request);
    expect(await f.preview()).toEqual(prepared);
    const artifact = await f.runtime.artifacts.prepareReadOnlyFile('s', prepared.receipt);
    await writeFile(artifact.path, 'broken', { mode: 0o600 });
    await expect(f.preview()).rejects.toMatchObject({ code: 'PATCH_CORRUPT' });
  });
  it('rejects changed snapshots without replacing the first producer receipt, authorizes every read, and binds exact identity', async () => {
    const f = await fixture(); const workspace = await f.run(); const first = await f.prepare();
    await writeFile(join(workspace, 'added.txt'), 'changed\n');
    await expect(f.prepare()).rejects.toMatchObject({ code: 'PATCH_CONFLICT' }); expect(await f.preview()).toEqual(first);
    await f.policy(['read-output']); await expect(f.prepare()).rejects.toMatchObject({ code: 'POLICY_DENIED' }); expect(await f.preview()).toEqual(first);
    await f.policy(['execute']); await expect(f.preview()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await f.policy(); await expect(previewConfiguredWorkspacePatch(f.project, { ...f.identity, taskId: 'other' }, f.options)).rejects.toMatchObject({ code: 'RUN_STORE_CONFLICT' });
    await expect(previewConfiguredWorkspacePatch(f.project, { ...f.identity, scopeId: 'other' }, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
  it.each(['symlink', 'hardlink', 'fifo', 'binary', 'depth', 'size'] as const)('rejects unsafe or unsupported %s without a receipt', async kind => {
    const f = await fixture(); const workspace = await f.run(); const path = join(workspace, 'unsafe');
    if (kind === 'symlink') await symlink('/etc/passwd', path);
    if (kind === 'hardlink') await link(join(workspace, 'note.txt'), path);
    if (kind === 'fifo') await exec('/usr/bin/mkfifo', [path]);
    if (kind === 'binary') await writeFile(path, Buffer.from([0, 255]));
    if (kind === 'size') await writeFile(path, 'x'.repeat(70000));
    if (kind === 'depth') { const directory = join(workspace, ...Array.from({ length: 33 }, () => 'd')); await mkdir(directory, { recursive: true }); }
    await expect(f.prepare()).rejects.toMatchObject({ code: kind === 'binary' ? 'PATCH_UNSUPPORTED' : ['depth', 'size'].includes(kind) ? 'PATCH_LIMIT' : 'PATCH_UNSAFE' });
    expect((await f.runtime.store.loadBoundDispatch(f.identity))!.patch).toBeUndefined();
  });
  it('does not expose an artifact when ledger binding fails; retry links complete bytes', async () => {
    const f = await fixture(); await f.run(); const prepared = await f.prepare();
    // A new isolated attempt store with no published patch simulates failure between put and receipt binding.
    const original = (await f.runtime.store.loadBoundDispatch(f.identity))!;
    const { patch: _patch, ...unbound } = original; void _patch;
    let record = unbound as typeof original;
    const store = { async loadBoundDispatch() { return record; }, async retainDispatchPatch() { throw new Error('simulated-ledger-failure'); } };
    const principal = { id: 'test', issuer: 'test', subject: 'test', assurance: 'os-user' as const, scopeIds: ['s'] };
    const app = new WorkspacePatchApplication(store, f.runtime.artifacts, { async verify() { return principal; } }, { async authorizeIdentity() {} }, 65536);
    await expect(app.prepare(f.identity, { async capture() { return prepared.patch; } }, store)).rejects.toThrow('simulated-ledger-failure');
    await expect(app.preview(f.identity)).rejects.toThrow('PATCH_UNAVAILABLE');
    const writer = { ...store, async retainDispatchPatch(_claim: unknown, receipt: typeof prepared.receipt) { record = { ...unbound, patch: receipt }; return record; } };
    expect(await app.prepare(f.identity, { async capture() { return prepared.patch; } }, writer)).toEqual(prepared);
    expect(await app.preview(f.identity)).toEqual(prepared);
  });
  it('rejects a running container even when an older terminal receipt exists', async () => {
    const f = await fixture(true); await f.run(); const record = (await f.runtime.store.loadBoundDispatch(f.identity))!;
    await exec('/usr/bin/docker', ['start', record.terminal!.handle]);
    await expect(f.prepare()).rejects.toMatchObject({ code: 'PATCH_UNAVAILABLE' });
    expect((await f.runtime.store.loadBoundDispatch(f.identity))!.patch).toBeUndefined();
  });
  it('gates version28 writers, explicitly migrates without changing old records, and enforces configured entry bounds', async () => {
    const f = await fixture(); await f.run(); const before = await f.runtime.store.loadBoundDispatch(f.identity);
    const path = productResourcePath(f.runtime.layout, 'ledger');
    const db = new DatabaseSync(path); db.exec('DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS workspace_adoptions; DROP TABLE IF EXISTS effect_intents; DROP TABLE IF EXISTS agent_turn_tool_calls; DROP TABLE IF EXISTS agent_turns; DROP TABLE IF EXISTS worker_event_logs; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=28;'); db.close();
    // Resolve actual configured storage settings rather than assume adapter defaults.
    const { loadConfig } = await import('#platform/index.js'); const config = await loadConfig(f.project, f.options);
    await expect(openSqliteAttemptStore(path, config.storage.sqlite, 'forbid', { validate: validateDockerSupervisorProfile })).rejects.toThrow('ATTEMPT_STORE_VERSION');
    const untouched = new DatabaseSync(path, { readOnly: true }); expect(untouched.prepare('PRAGMA user_version').get()?.user_version).toBe(28); untouched.close();
    const migrated = await openSqliteAttemptStore(path, config.storage.sqlite, 'allow', { validate: validateDockerSupervisorProfile });
    expect(await migrated.loadBoundDispatch(f.identity)).toEqual(before); migrated.close();
    expect((await f.prepare()).patch.baseCommit).toBe(f.base);
    const value = JSON.parse(await readFile(f.configPath, 'utf8')); value.artifacts.patchPreview = { maxEntries: 1 };
    await writeFile(f.configPath, JSON.stringify(value)); clearConfigCache();
    await expect(f.prepare()).rejects.toMatchObject({ code: 'PATCH_LIMIT' });
  });
  it('requires terminal execution before preparation', async () => {
    const f = await fixture(); await expect(f.prepare()).rejects.toMatchObject({ code: 'PATCH_UNAVAILABLE' });
  });
});

describe.skipIf(process.platform !== 'linux' || !process.env.DECKENT_TEST_DOCKER_IMAGE)('isolated integration candidates', () => {
  it('checks touched WIP, prepares a separate candidate through the real CLI, replays, and rejects candidate drift and revoked policy', async () => {
    const f = await fixture(); const worker = await f.run(); await f.prepare();
    const check = () => checkConfiguredWorkspaceIntegration(f.project, f.identity, f.options);
    await expect(check()).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    await writeFile(join(f.project, 'note.txt'), 'before\n');
    await writeFile(join(f.project, 'unrelated.txt'), 'owner-only\n');
    const before = { head: await f.git('rev-parse', 'HEAD'), status: await f.git('status', '--porcelain'), index: await readFile(join(f.project, '.git/index')) };
    const checked = await check(); expect(checked.proposal).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
    const command = { schemaVersion: 1 as const, commandId: 'candidate', identity: f.identity, proposal: checked.proposal };
    await expect(prepareConfiguredWorkspaceIntegration(f.project, command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await f.policy(['read-output', 'recover-output', 'prepare-integration']);
    const output = await f.cli('integration-prepare', ['--command-id', command.commandId, '--proposal', command.proposal]) as unknown as Awaited<ReturnType<typeof prepareConfiguredWorkspaceIntegration>>;
    expect(output.status).toBe('candidate-prepared'); expect(output.manifest.workspace).not.toBe(worker);
    expect(await readFile(join(output.manifest.workspace, 'note.txt'), 'utf8')).toBe('after\n');
    expect(await readFile(join(output.manifest.workspace, 'added.txt'), 'utf8')).toBe('new\n');
    await expect(readFile(join(output.manifest.workspace, 'removed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(output.manifest.workspace, 'unrelated.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const candidateGit = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', output.manifest.workspace, ...args])).stdout.trim();
    expect(await candidateGit('rev-parse', 'HEAD')).toBe(f.base); expect(await candidateGit('remote')).toBe('');
    expect(await prepareConfiguredWorkspaceIntegration(f.project, command, f.options)).toEqual(output);
    expect({ head: await f.git('rev-parse', 'HEAD'), status: await f.git('status', '--porcelain'), index: await readFile(join(f.project, '.git/index')) }).toEqual(before);
    await writeFile(join(output.manifest.workspace, 'added.txt'), 'external-edit\n');
    await expect(prepareConfiguredWorkspaceIntegration(f.project, command, f.options)).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    await f.policy(['read-output']);
    await expect(prepareConfiguredWorkspaceIntegration(f.project, command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
  it('rejects staged, untracked, unsafe and changed-HEAD source states and checks scope', async () => {
    const f = await fixture(); await f.run(); await f.prepare(); await writeFile(join(f.project, 'note.txt'), 'before\n');
    const check = () => checkConfiguredWorkspaceIntegration(f.project, f.identity, f.options);
    const initial = await check();
    await writeFile(join(f.project, 'note.txt'), 'staged\n'); await f.git('add', 'note.txt'); await writeFile(join(f.project, 'note.txt'), 'before\n');
    await expect(check()).rejects.toMatchObject({ code: 'PATCH_CONFLICT' }); await f.git('restore', '--staged', 'note.txt');
    await writeFile(join(f.project, 'added.txt'), 'untracked\n'); await expect(check()).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    await rm(join(f.project, 'added.txt')); await symlink('/etc/passwd', join(f.project, 'added.txt')); await expect(check()).rejects.toMatchObject({ code: 'PATCH_UNSAFE' });
    await rm(join(f.project, 'added.txt')); await link(join(f.project, 'note.txt'), join(f.project, 'added.txt'));
    await expect(check()).rejects.toMatchObject({ code: 'PATCH_UNSAFE' }); await rm(join(f.project, 'added.txt'));
    expect(await check()).toEqual(initial);
    await expect(checkConfiguredWorkspaceIntegration(f.project, { ...f.identity, scopeId: 'other' }, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await f.git('commit', '--allow-empty', '-m', 'advance'); await expect(check()).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
  });
  it('serializes separate CLI writers and holds a durable incomplete intent without adopting its directory', async () => {
    const f = await fixture(); await f.run(); await f.prepare(); await writeFile(join(f.project, 'note.txt'), 'before\n');
    await f.policy(['read-output', 'prepare-integration']);
    const check = await checkConfiguredWorkspaceIntegration(f.project, f.identity, f.options);
    const command = { schemaVersion: 1 as const, commandId: 'concurrent', identity: f.identity, proposal: check.proposal };
    const results = await Promise.allSettled([f.cli('integration-prepare', ['--command-id', command.commandId, '--proposal', command.proposal]),
      f.cli('integration-prepare', ['--command-id', command.commandId, '--proposal', command.proposal])]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    const complete = await prepareConfiguredWorkspaceIntegration(f.project, command, f.options);
    const db = new DatabaseSync(productResourcePath(f.runtime.layout, 'ledger'));
    const row = db.prepare('SELECT intent FROM workspace_integrations WHERE scope_id=? AND command_id=?').get('s', 'concurrent')!;
    const intent = JSON.parse(String(row.intent)); intent.command.commandId = 'interrupted';
    db.prepare('INSERT INTO workspace_integrations(scope_id,command_id,intent,manifest) VALUES(?,?,?,NULL)').run('s', 'interrupted', JSON.stringify(intent)); db.close();
    await expect(prepareConfiguredWorkspaceIntegration(f.project, { ...command, commandId: 'interrupted' }, f.options)).rejects.toMatchObject({ code: 'PATCH_INTEGRATION_PENDING' });
    expect(await readFile(join(complete.manifest.workspace, 'note.txt'), 'utf8')).toBe('after\n');
    await expect(prepareConfiguredWorkspaceIntegration(f.project, { ...command, proposal: '00000000000000000000' }, f.options)).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    const artifact = await f.runtime.artifacts.prepareReadOnlyFile('s', complete.receipt); await writeFile(artifact.path, 'corrupt');
    await expect(prepareConfiguredWorkspaceIntegration(f.project, command, f.options)).rejects.toMatchObject({ code: 'PATCH_CORRUPT' });
  });
});

describe.skipIf(process.platform !== 'linux' || !process.env.DECKENT_TEST_DOCKER_IMAGE)('integration finalization boundary', () => {
  it('preserves executable mode and holds an interrupted finalization and a changed source without a manifest', async () => {
    const f = await fixture(); const worker = await f.run(); await chmod(join(worker, 'note.txt'), 0o755); await f.prepare();
    await writeFile(join(f.project, 'note.txt'), 'before\n'); await f.policy(['read-output', 'prepare-integration']);
    const checked = await checkConfiguredWorkspaceIntegration(f.project, f.identity, f.options);
    const command = { schemaVersion: 1 as const, commandId: 'interrupted-verify', identity: f.identity, proposal: checked.proposal };
    const verify = GitIntegrationTarget.prototype.verify;
    const spy = vi.spyOn(GitIntegrationTarget.prototype, 'verify').mockImplementationOnce(async function (manifest, patch) {
      await verify.call(this, manifest, patch);
      expect((await stat(join(manifest.workspace, 'note.txt'))).mode & 0o111).not.toBe(0);
      await writeFile(join(f.project, 'note.txt'), 'intervening-owner-write\n');
    });
    try { await expect(prepareConfiguredWorkspaceIntegration(f.project, command, f.options)).rejects.toMatchObject({ code: 'PATCH_CONFLICT' }); }
    finally { spy.mockRestore(); }
    expect(await readFile(join(f.project, 'note.txt'), 'utf8')).toBe('intervening-owner-write\n');
    await writeFile(join(f.project, 'note.txt'), 'before\n');
    await expect(prepareConfiguredWorkspaceIntegration(f.project, command, f.options)).rejects.toMatchObject({ code: 'PATCH_INTEGRATION_PENDING' });
    const next = { ...command, commandId: 'crashed-verify' };
    const crash = vi.spyOn(GitIntegrationTarget.prototype, 'verify').mockRejectedValueOnce(new Error('injected-interruption'));
    try { await expect(prepareConfiguredWorkspaceIntegration(f.project, next, f.options)).rejects.toBeDefined(); } finally { crash.mockRestore(); }
    await expect(prepareConfiguredWorkspaceIntegration(f.project, next, f.options)).rejects.toMatchObject({ code: 'PATCH_INTEGRATION_PENDING' });
    const db = new DatabaseSync(productResourcePath(f.runtime.layout, 'ledger'), { readOnly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspace_integrations WHERE manifest IS NULL').get()?.n).toBe(2); db.close();
  });
});

describe.skipIf(process.platform !== 'linux' || !process.env.DECKENT_TEST_DOCKER_IMAGE)('read-only integration inspection', () => {
  it('exposes absent, pending and recorded through SDK/CLI without execution config, candidate repair or source checks', async () => {
    const f = await fixture(); await f.run(); await f.prepare(); await writeFile(join(f.project, 'note.txt'), 'before\n');
    const query = { schemaVersion: 1 as const, identity: f.identity, commandId: 'inspect-candidate' };
    expect(await inspectConfiguredWorkspaceIntegration(f.project, query, f.options)).toMatchObject({ status: 'absent', intent: null, manifest: null });
    await f.policy(['read-output', 'prepare-integration']);
    const checked = await checkConfiguredWorkspaceIntegration(f.project, f.identity, f.options);
    const prepared = await prepareConfiguredWorkspaceIntegration(f.project, { ...query, proposal: checked.proposal }, f.options);
    const pending = { ...query, commandId: 'inspect-pending' };
    const crash = vi.spyOn(GitIntegrationTarget.prototype, 'verify').mockRejectedValueOnce(new Error('test interruption'));
    try { await expect(prepareConfiguredWorkspaceIntegration(f.project, { ...pending, proposal: checked.proposal }, f.options)).rejects.toBeDefined(); }
    finally { crash.mockRestore(); }
    await f.policy(['read-output']);
    const config = JSON.parse(await readFile(f.configPath, 'utf8')); delete config.execution;
    await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    await writeFile(join(f.project, 'note.txt'), 'new-owner-work\n');
    await writeFile(join(prepared.manifest.workspace, 'note.txt'), 'new-candidate-work\n');
    const ledgerPath = productResourcePath(f.runtime.layout, 'ledger'), before = await readFile(ledgerPath);
    const recorded = await inspectConfiguredWorkspaceIntegration(f.project, query, f.options);
    expect(recorded).toMatchObject({ status: 'manifest-recorded', candidateVerification: 'not-performed', manifest: prepared.manifest, receipt: prepared.receipt });
    expect(await f.cli('integration-inspect', ['--command-id', query.commandId])).toEqual(recorded);
    expect(await inspectConfiguredWorkspaceIntegration(f.project, pending, f.options)).toMatchObject({ status: 'pending', receipt: null, manifest: null });
    expect(await readFile(ledgerPath)).toEqual(before);
    expect(await readFile(join(f.project, 'note.txt'), 'utf8')).toBe('new-owner-work\n');
    expect(await readFile(join(prepared.manifest.workspace, 'note.txt'), 'utf8')).toBe('new-candidate-work\n');
    await expect(inspectConfiguredWorkspaceIntegration(f.project, { ...query, identity: { ...f.identity, scopeId: 'other' } }, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(inspectConfiguredWorkspaceIntegration(f.project, { ...query, identity: { ...f.identity, generation: 2 } }, f.options)).rejects.toMatchObject({ code: 'RUN_STORE_CONFLICT' });
    const artifact = await f.runtime.artifacts.prepareReadOnlyFile('s', prepared.receipt); await writeFile(artifact.path, 'broken');
    await expect(inspectConfiguredWorkspaceIntegration(f.project, query, f.options)).rejects.toMatchObject({ code: 'PATCH_CORRUPT' });
    await f.policy(['execute']);
    await expect(inspectConfiguredWorkspaceIntegration(f.project, pending, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
  it('refuses an older ledger without creating the integration table or migrating bytes', async () => {
    const f = await fixture(); await f.run();
    const path = productResourcePath(f.runtime.layout, 'ledger'); const db = new DatabaseSync(path);
    db.exec('DROP TABLE workspace_integrations; PRAGMA user_version=29;'); db.close();
    const before = await readFile(path);
    await expect(inspectConfiguredWorkspaceIntegration(f.project, { schemaVersion: 1, identity: f.identity, commandId: 'absent' }, f.options)).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
    expect(await readFile(path)).toEqual(before);
    const reader = new DatabaseSync(path, { readOnly: true });
    expect(reader.prepare('PRAGMA user_version').get()?.user_version).toBe(29);
    expect(reader.prepare("SELECT name FROM sqlite_master WHERE name='workspace_integrations'").get()).toBeUndefined(); reader.close();
  });
});

const readyDeliveryFixture = () => readyDeliveryFixtureFor({ roots, cleanup });
async function pausedWriter(f: Awaited<ReturnType<typeof readyDeliveryFixture>>, mode: 'candidate' | 'delivery', command: unknown) {
  const marker = join(f.root, mode + '-marker.json');
  const script = join(f.root, mode + '-writer.mjs');
  const method = mode === 'candidate' ? 'verify' : 'publish';
  const type = mode === 'candidate' ? 'GitIntegrationTarget' : 'GitIntegrationDelivery';
  const call = mode === 'candidate' ? 'prepareConfiguredWorkspaceIntegration' : 'deliverConfiguredWorkspaceIntegration';
  await writeFile(script, `import { ${type} } from ${JSON.stringify(resolve('dist/adapters/index.js'))};
import { ${call} } from ${JSON.stringify(resolve('dist/index.js'))};
import { writeFile } from 'node:fs/promises';
const original = ${type}.prototype.${method};
${type}.prototype.${method} = async function(...args) { await original.apply(this,args); await writeFile(${JSON.stringify(marker)},JSON.stringify(args[0])); await new Promise(()=>{setInterval(()=>{},1000);}); };
await ${call}(${JSON.stringify(f.project)},${JSON.stringify(command)},${JSON.stringify(f.options)});`);
  const child = spawn(process.execPath, [script], { cwd: f.project, env: { ...process.env, ...f.options.env }, stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', resolve));
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; };
  try {
    for (let n = 0; n < 100; n++) {
      try { return { child, stop, marker: JSON.parse(await readFile(marker, 'utf8')) }; } catch { /* wait for exact owned writer */ }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('DELIVERY_WRITER_EXITED');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('DELIVERY_WRITER_TIMEOUT');
  } catch (error) { await stop(); throw error; }
}
describe.skipIf(process.platform !== 'linux' || !process.env.DECKENT_TEST_DOCKER_IMAGE)('safe Git reference delivery and replacement', () => {
  it('delivers an exact commit through competing SDK/CLI with source HEAD/index/WIP unchanged', async () => {
    const f = await readyDeliveryFixture();
    const candidate = await prepareConfiguredWorkspaceIntegration(f.project, f.command, f.options);
    await writeFile(join(f.project, 'unrelated.txt'), 'staged-owner\n'); await f.git('add', 'unrelated.txt');
    await writeFile(join(f.project, 'unrelated.txt'), 'unstaged-owner\n');
    const index = await readFile(join(f.project, '.git/index'));
    const command = { schemaVersion: 1 as const, commandId: 'delivery', identity: f.identity, integrationCommandId: 'candidate' };
    const [sdk, cli] = await Promise.all([deliverConfiguredWorkspaceIntegration(f.project, command, f.options),
      f.cli('integration-deliver', ['--command-id', 'delivery', '--candidate-command-id', 'candidate'])]);
    expect(cli).toEqual(sdk); expect(sdk.application).toBe('reference-only');
    expect(await f.git('show', sdk.plan.ref + ':note.txt')).toBe('after');
    expect(await f.git('show', sdk.plan.ref + ':added.txt')).toBe('new');
    await expect(f.git('show', sdk.plan.ref + ':removed.txt')).rejects.toBeDefined();
    expect(await f.git('rev-parse', sdk.plan.ref + '^')).toBe(f.base);
    expect(await f.git('rev-parse', 'HEAD')).toBe(f.base);
    expect(await readFile(join(f.project, '.git/index'))).toEqual(index);
    expect(await readFile(join(f.project, 'unrelated.txt'), 'utf8')).toBe('unstaged-owner\n');
    expect(await readFile(join(f.project, 'note.txt'), 'utf8')).toBe('before\n');
    expect(await deliverConfiguredWorkspaceIntegration(f.project, command, f.options)).toEqual(sdk);
    await f.policy(['read-output', 'prepare-integration']);
    await expect(deliverConfiguredWorkspaceIntegration(f.project, command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(candidate.manifest.snapshotDigest).toBe(sdk.plan.snapshotDigest);
  });
  it('replaces a live held writer with a separate linked candidate and preserves the old bytes/state', async () => {
    const f = await readyDeliveryFixture(); const paused = await pausedWriter(f, 'candidate', f.command);
    try {
      const oldBytes = await readFile(join(paused.marker.workspace, 'note.txt'));
      const command = { ...f.command, commandId: 'replacement', replacesCommandId: f.command.commandId };
      const replacement = await prepareConfiguredWorkspaceIntegration(f.project, command, f.options);
      expect(replacement.manifest.workspace).not.toBe(paused.marker.workspace);
      expect(replacement.manifest.command.replacesCommandId).toBe('candidate');
      expect(await readFile(join(paused.marker.workspace, 'note.txt'))).toEqual(oldBytes);
      expect((await inspectConfiguredWorkspaceIntegration(f.project, { schemaVersion: 1, identity: f.identity, commandId: 'candidate' }, f.options)).status).toBe('pending');
      expect(await prepareConfiguredWorkspaceIntegration(f.project, command, f.options)).toEqual(replacement);
      await expect(prepareConfiguredWorkspaceIntegration(f.project, { ...command, commandId: 'bad', replacesCommandId: 'missing' }, f.options)).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    } finally { await paused.stop(); }
  });
  it('reconciles real SIGKILL after Git publication before ledger settlement without reapplying or moving newer HEAD', async () => {
    const f = await readyDeliveryFixture(); await prepareConfiguredWorkspaceIntegration(f.project, f.command, f.options);
    const command = { schemaVersion: 1 as const, commandId: 'interrupted-delivery', identity: f.identity, integrationCommandId: 'candidate' };
    const paused = await pausedWriter(f, 'delivery', command); await paused.stop();
    expect(paused.child.signalCode).toBe('SIGKILL');
    const db = new DatabaseSync(productResourcePath(f.runtime.layout, 'ledger'));
    expect(db.prepare('SELECT delivered FROM workspace_deliveries WHERE command_id=?').get(command.commandId)?.delivered).toBe(0); db.close();
    await f.git('commit', '--allow-empty', '-m', 'owner moves after publication'); const head = await f.git('rev-parse', 'HEAD');
    const result = await deliverConfiguredWorkspaceIntegration(f.project, command, f.options);
    expect(result.plan).toEqual(paused.marker); expect(await f.git('rev-parse', 'HEAD')).toBe(head);
    expect(await f.git('rev-parse', result.plan.ref)).toBe(result.plan.commit);
    expect(await deliverConfiguredWorkspaceIntegration(f.project, command, f.options)).toEqual(result);
  });
  it('rejects drift and atomically refuses a changed HEAD at publication', async () => {
    const f = await readyDeliveryFixture(); const candidate = await prepareConfiguredWorkspaceIntegration(f.project, f.command, f.options);
    const command = { schemaVersion: 1 as const, commandId: 'guarded', identity: f.identity, integrationCommandId: 'candidate' };
    await writeFile(join(candidate.manifest.workspace, 'note.txt'), 'drift\n');
    await expect(deliverConfiguredWorkspaceIntegration(f.project, command, f.options)).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    await writeFile(join(candidate.manifest.workspace, 'note.txt'), 'after\n');
    const publish = GitIntegrationDelivery.prototype.publish;
    const spy = vi.spyOn(GitIntegrationDelivery.prototype, 'publish').mockImplementationOnce(async function(plan) {
      await f.git('commit', '--allow-empty', '-m', 'owner wins'); await publish.call(this, plan);
    });
    try { await expect(deliverConfiguredWorkspaceIntegration(f.project, command, f.options)).rejects.toMatchObject({ code: 'PATCH_CONFLICT' }); }
    finally { spy.mockRestore(); }
    expect(await f.git('for-each-ref', '--format=%(refname)', 'refs/deckent/deliveries')).toBe('');
    expect(await readFile(join(f.project, 'note.txt'), 'utf8')).toBe('before\n');
  });
});
