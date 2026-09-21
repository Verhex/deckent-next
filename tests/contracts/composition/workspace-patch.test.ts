import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, link, chmod, stat } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkConfiguredWorkspaceIntegration, prepareConfiguredWorkspaceIntegration, prepareConfiguredWorkspacePatch, previewConfiguredWorkspacePatch } from '../../../src/index.js';
import { executeConfiguredTask, openConfiguredExecution } from '../../../src/composition/core/execution/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '../../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { DockerSupervisor, GitIntegrationTarget } from '#adapters/index.js';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteAttemptStore, validateDockerSupervisorProfile } from '#adapters/index.js';
import { WorkspacePatchApplication, patchPathSchema } from '#engine/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
const exec = promisify(execFile); const roots: string[] = []; const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  clearConfigCache(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(restartable = false) {
  const root = await mkdtemp(join(tmpdir(), 'dn-patch-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', project, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(project, 'note.txt'), 'before\n'); await writeFile(join(project, 'removed.txt'), 'remove\n');
  await git('add', 'note.txt', 'removed.txt'); await git('commit', '-m', 'base'); const base = await git('rev-parse', 'HEAD');
  await writeFile(join(project, 'note.txt'), 'owner-wip\n');
  const registry = fixtureDockerRegistry(['coding']); registry.profiles[0]!.parameters.argv = ['node', '-e',
    "const fs=require('node:fs');fs.writeFileSync('note.txt','after\\n');fs.unlinkSync('removed.txt');fs.writeFileSync('added.txt','new\\n');fs.mkdirSync('.codex');fs.writeFileSync('.codex/auth.json','synthetic-private');fs.appendFileSync('.git/config','\\n[diff]\\n external = touch /workspace/hook-fired\\n');"];
  if (restartable) registry.profiles[0]!.parameters.argv = ['node', '-e', "const fs=require('node:fs');if(fs.existsSync('.git/restarted'))setInterval(()=>{},1000);else fs.writeFileSync('.git/restarted','1')"];
  registry.profiles[0]!.parameters.imageId = process.env.DECKENT_TEST_DOCKER_IMAGE!;
  const { argv: _argv, ...bounds } = registry.profiles[0]!.parameters; void _argv;
  const configPath = join(project, '.deckent/config.json'); const options = { env: { HOME: join(root, 'home') } };
  await writeFile(configPath, JSON.stringify({ layout: { root: join(root, 'data') }, artifacts: { maxBytes: 65536 },
    admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry },
    execution: { docker: { executable: '/usr/bin/docker', ...bounds }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  const opened = await openConfiguredAttemptStore(project, options);
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); opened.store.close();
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  const policy = async (actions = ['execute', 'read-output', 'recover-output']) => writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'patch', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions, scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
  ] }), { mode: 0o600 });
  await policy();
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  await createConfiguredRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'create', graph }, options);
  const identity = (await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve', expectedRevision: 0 }, options)).reservation.identities[0]!;
  const runtime = await openConfiguredExecution(project, project, options);
  cleanup.push(async () => { try {
    const record = await runtime.store.loadBoundDispatch(identity);
    if (record) { const supervisor = await DockerSupervisor.restoreProfile(record.profile); await supervisor.cancel(record.request); await supervisor.release(record.request); }
  } finally { runtime.store.close(); } });
  const run = async () => {
    expect((await executeConfiguredTask(project, identity, options)).execution.terminal?.exitCode).toBe(0);
    return (await runtime.workspaces.openRecorded(identity))!.workspace;
  };
  const prepare = () => prepareConfiguredWorkspacePatch(project, identity, options);
  const preview = () => previewConfiguredWorkspacePatch(project, identity, options);
  const cli = async (action: string, extra: string[] = []) => {
    const result = await exec(process.execPath, [resolve('dist/composition/core/cli/internal/entry.js'), 'task', action, '--scope', identity.scopeId,
      '--run', identity.runId, '--task', identity.taskId, '--attempt', identity.attemptId, '--generation', String(identity.generation),
      '--layout-revision', identity.layoutRevision, '--json', ...extra], { cwd: project, env: { ...process.env, ...options.env } });
    return JSON.parse(result.stdout) as Awaited<ReturnType<typeof prepare>>;
  };
  return { project, root, identity, options, run, prepare, preview, cli, policy, runtime, base, git, configPath };
}
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
    const db = new DatabaseSync(path); db.exec('DROP TABLE IF EXISTS workspace_integrations; PRAGMA user_version=28;'); db.close();
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
