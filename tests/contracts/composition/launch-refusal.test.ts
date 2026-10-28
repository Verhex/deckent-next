import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi, type TestContext } from 'vitest';
import { bindSiwcWorker, compileNativeCodingDockerProfile, DockerSupervisor, GitWorkspaceBroker, readLocalOsIdentity, yamaPtraceScope } from '#adapters/index.js';
import { applyModelCatalog } from '../../../src/index.js';
import { seedCatalog } from '../support/model-catalog.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { advanceConfiguredRun, prepareConfiguredRunRuntime } from '#composition/core/run-progression/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

const roots: string[] = [], exec = promisify(execFile);
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const query = { schemaVersion: 1 as const, scopeId: 's', runId: 'r' };
/** Configured Run whose installation has no `execution` section: every start of its pinned attempt is refused the same way. */
async function fixture(context: TestContext, grants: readonly string[] = ['execute', 'evaluate', 'read-output']) {
  const root = await mkdtemp(join(tmpdir(), 'launch-refusal-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const options = { env: { HOME: home, USERPROFILE: home } }, registry = fixtureDockerRegistry(['fixture']);
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p',
    executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry } }));
  if (process.platform === 'win32') {
    await expect(openConfiguredAttemptStore(project, options)).rejects.toMatchObject({ code: 'MANAGED_FILE_UNSUPPORTED' });
    await expect(stat(data)).rejects.toMatchObject({ code: 'ENOENT' });
    context.skip('MANAGED_FILE_UNSUPPORTED: configured refusal receipt requires POSIX private ledger');
  }
  const opened = await openConfiguredAttemptStore(project, options), store = opened.store;
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  const principal = { ...readLocalOsIdentity(), scopeIds: ['s'] }, principals = [{ issuer: principal.issuer, subject: principal.subject }];
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'fixture', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect', 'cancel'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r', 'relay'] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'catalog', effect: 'allow', actions: ['activate'], scopes: 'all', principals, resource: { kind: 'model-activation', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: grants, scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
  ] }), { mode: 0o600 });
  const graph = { schemaVersion: 4 as const, revision: 1, tasks: [
    { id: 'a', kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'] },
    { id: 'b', kind: 'fixture', dependencies: ['a'], acceptanceCriteria: ['exit'] },
  ], criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  await createConfiguredRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'create', graph }, options);
  return { project, options, store, workspaces: productResourcePath(opened.layout, 'workspaces') };
}

/** A Run 'relay' with one task on a compiled native Codex profile (catalog channel registered and activated); `bind` may turn it into the relay route. */
async function nativeCodexRun(f: Awaited<ReturnType<typeof fixture>>, bind: (compiled: ReturnType<typeof compileNativeCodingDockerProfile>, modelId: string) => ReturnType<typeof compileNativeCodingDockerProfile>,
  execution?: object) {
  const channelId = 'codex-siwc-fixture', modelId = 'exact-siwc-fixture';
  const template = { id: 'relay', version: 1, adapter: { id: 'docker', version: 2 }, parameters: { ...fixtureDockerRegistry(['x']).profiles[0]!.parameters, argv: ['unused'] } };
  const compiled = compileNativeCodingDockerProfile(template, { schemaVersion: 4, provider: 'codex', cliVersion: 'codex-cli 0.164.0', discovery: { schemaVersion: 1, mode: 'repository' },
    permissionMode: 'unattended', model: { channelId, modelId, auxiliaryModelIds: [] }, composition: { schemaVersion: 1, task: 'Edit note.txt', scope: 'note.txt', acceptance: 'Zero exit' } });
  const seed = await seedCatalog(), provider = seed.providers[0];
  await applyModelCatalog(f.project, { schemaVersion: 1, commandId: 'catalog', scopeId: 's', action: 'register', catalog: { schemaVersion: 3, revision: 'siwc-hold', providers: [{ ...provider, id: channelId,
    channel: { ...provider.channel, cli: 'codex', client: 'codex', protocolFamily: 'fixture', aliases: [], aliasesRefused: [] }, models: [{ ...provider.models[0], id: modelId, nativeId: modelId,
      channelModelId: modelId, canonicalModelId: modelId, aliases: [], minCliVersion: null, minClientVersion: null, protocols: [{ family: 'fixture', version: 'v1', capabilities: [] }],
      lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null } }] }] } }, f.options);
  for (const id of [null, modelId]) await applyModelCatalog(f.project, { schemaVersion: 1, commandId: `activate-${id}`, scopeId: 's', action: 'activate', channelId, modelId: id, expectedRevision: 0 }, f.options);
  const config = join(f.project, '.deckent/config.json'), written = JSON.parse(await readFile(config, 'utf8'));
  written.admission.registry = { ...written.admission.registry, profiles: [bind(compiled, modelId)], kinds: [{ kind: 'relay', profile: { id: 'relay', version: 1 } }] };
  if (execution) written.execution = execution;
  await writeFile(config, JSON.stringify(written)); clearConfigCache();
  const graph = { schemaVersion: 4 as const, revision: 1, tasks: [{ id: 't', kind: 'relay', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  await createConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'relay', commandId: 'create-relay', graph }, f.options);
  return (await reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId: 'relay', commandId: 'reserve-relay', expectedRevision: 0 }, f.options)).reservation.identities[0]!;
}

it('a permanent pre-launch refusal closes the attempt once: 10 turns start it once, the task fails and its dependent is skipped', async context => {
  const f = await fixture(context);
  try {
    const worker = vi.spyOn(DockerSupervisor.prototype, 'execute'), allocate = vi.spyOn(GitWorkspaceBroker.prototype, 'allocate');
    const signal = new AbortController().signal; let attempted = 0, failures = 0;
    for (let turn = 0; turn < 10; turn++) {
      try { attempted += (await advanceConfiguredRun(f.project, query, signal, f.options)).attempted; }
      catch (error) { failures++; attempted++; expect(error).toMatchObject({ code: 'EXECUTION_NOT_CONFIGURED' }); }
    }
    expect({ attempted, failures }).toEqual({ attempted: 1, failures: 1 });
    expect(worker).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    const run = (await f.store.loadRun('s', 'r'))!, identity = run.bindings[0]!.identity;
    expect(run.progress.map(task => task.phase)).toEqual(['failed', 'skipped']);
    expect(run.progress[0]!.unresolvedEffects).toBe(false); expect(run.bindings[0]).toMatchObject({ observedKind: 'launch-refused' });
    expect(run.state).toMatchObject({ kind: 'parked', reason: 'dependency-failed' });
    expect(await f.store.loadBoundDispatch(identity)).toBeNull();
    const receipt = await f.store.receipt('s', 'launch-refused-' + createHash('sha256').update(JSON.stringify(identity)).digest('hex'));
    expect(receipt?.snapshot.lastObservation?.result).toEqual({ kind: 'launch-refused', code: 'EXECUTION_NOT_CONFIGURED' });
    // A direct restart of the closed attempt is refused by terminal selection and rewrites nothing.
    await expect(executeConfiguredTask(f.project, identity, f.options)).rejects.toMatchObject({ code: 'RUN_STORE_CONFLICT' });
    expect(await f.store.loadRun('s', 'r')).toEqual(run);
  } finally { f.store.close(); }
});

it('a transient refusal (policy denial before the ledger is touched) is not recorded and is retried on the next turn', async context => {
  const f = await fixture(context, ['evaluate', 'read-output']);
  try {
    const identity = (await reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve', expectedRevision: 0 }, f.options)).reservation.identities[0]!;
    for (let turn = 0; turn < 3; turn++) await expect(executeConfiguredTask(f.project, identity, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const run = (await f.store.loadRun('s', 'r'))!;
    expect(run.progress[0]).toMatchObject({ phase: 'active', unresolvedEffects: false }); expect(run.bindings[0]).toMatchObject({ observedKind: null });
    expect((await f.store.load('s', identity.attemptId))!.lastObservation).toBeNull();
  } finally { f.store.close(); }
});

it('a Run frozen on the SIWC relay route while activation is held closes launch-refused with zero launches and no other Codex route (U9-7)', async context => {
  const f = await fixture(context), owner = { issuer: readLocalOsIdentity().issuer, subject: readLocalOsIdentity().subject };
  try {
    const identity = await nativeCodexRun(f, (compiled, modelId) => {
      const relay = bindSiwcWorker(compiled, [{ scopeId: 's', connectionId: '00000000-0000-4000-8000-000000000001', owner, modelId, consentAtMs: 1 }], 's');
      expect(relay.parameters).toHaveProperty('siwcWorker.schemaVersion', 1); return relay;
    });
    const worker = vi.spyOn(DockerSupervisor.prototype, 'execute'), probe = vi.spyOn(DockerSupervisor.prototype, 'probe'), allocate = vi.spyOn(GitWorkspaceBroker.prototype, 'allocate');
    const held = process.platform === 'linux' && (yamaPtraceScope() ?? 0) >= 1;
    const refused = await executeConfiguredTask(f.project, identity, f.options).then(() => null, (error: { code: string }) => error);
    expect(refused).toMatchObject(held ? { code: 'SIWC_APP_SERVER_AUTH_UNAVAILABLE', params: { reason: 'activation-hold' } } : { code: 'SIWC_WORKER_ISOLATION_UNAVAILABLE' });
    // No container, probe or workspace for any route: not the relay, not the host, not the native Codex credential route.
    expect(worker).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    const receipt = await f.store.receipt('s', 'launch-refused-' + createHash('sha256').update(JSON.stringify(identity)).digest('hex'));
    expect(receipt?.snapshot.lastObservation?.result).toEqual({ kind: 'launch-refused', code: refused!.code });
    expect((await f.store.loadRun('s', 'relay'))!.bindings[0]).toMatchObject({ observedKind: 'launch-refused' });
  } finally { f.store.close(); }
});

// BeUser D-05: a native worker's connection is opened after its live `worker.events` sink. On the person's install the data path made the gateway
// socket longer than sun_path (NATIVE_CONNECTION_UNAVAILABLE) and the sink's handle was left open; Node 26 ends the whole service when such a
// FileHandle is collected, and every restart resumed the Run into the same death. Now the socket is placed under /tmp and the handle is closed on
// every path; a refusal stays the typed error the runtime's bounded failure path parks the Run with.
async function nativeFixture(context: TestContext) {
  const f = await fixture(context), git = (...args: string[]) => exec('/usr/bin/git', ['-C', f.project, ...args]);
  await git('init', '-q'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(f.project, 'note.txt'), 'note\n'); await git('add', '--', 'note.txt'); await git('commit', '-q', '-m', 'base');
  const { argv: _argv, ...docker } = fixtureDockerRegistry(['x']).profiles[0]!.parameters; void _argv;
  const identity = await nativeCodexRun(f, compiled => compiled, { docker: { executable: '/usr/bin/docker', ...docker }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } });
  vi.spyOn(DockerSupervisor.prototype, 'probe').mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);
  // The proof: one live sink was opened for the attempt and no descriptor of this process still points at it.
  const sinkClosed = async () => {
    expect((await readdir(f.workspaces, { recursive: true })).filter(path => path.endsWith('worker.events'))).toHaveLength(1);
    expect((await readdir('/proc/self/fd')).map(fd => { try { return readlinkSync(join('/proc/self/fd', fd)); } catch { return ''; } }).filter(target => target.endsWith('/worker.events'))).toEqual([]);
  };
  return { ...f, identity, sinkClosed };
}
it.skipIf(process.platform !== 'linux')('NEGATIVE: a native connection that cannot open (no local credential) closes the live worker.events handle and refuses typed', async context => {
  const f = await nativeFixture(context);
  try {
    const worker = vi.spyOn(DockerSupervisor.prototype, 'execute');
    await expect(executeConfiguredTask(f.project, f.identity, f.options)).rejects.toMatchObject({ code: 'NATIVE_CREDENTIAL_UNAVAILABLE' });
    expect(worker).not.toHaveBeenCalled(); await f.sinkClosed();
  } finally { f.store.close(); }
});
it.skipIf(process.platform !== 'linux')('NEGATIVE: the service loop parks a Run whose native connection keeps failing, naming the code, instead of resuming it forever', async context => {
  const f = await nativeFixture(context);
  try {
    const config = join(f.project, '.deckent/config.json'), written = JSON.parse(await readFile(config, 'utf8'));
    await writeFile(config, JSON.stringify({ ...written, runRuntime: { pollIntervalMs: 20, failureBackoffMs: 20, maxConsecutiveFailures: 3 } })); clearConfigCache();
    const errors: string[] = [], controller = new AbortController();
    const loop = await prepareConfiguredRunRuntime(f.project, { onError: (query, error) => { if (query?.runId === 'relay') errors.push(error.code); } }, work => work(), f.options);
    const running = loop.run(controller.signal);
    const deadline = Date.now() + 20000; let run = await f.store.loadRun('s', 'relay');
    while (run?.state.kind !== 'parked' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); run = await f.store.loadRun('s', 'relay'); }
    controller.abort(); await running;
    expect(run?.state).toMatchObject({ kind: 'parked', reason: 'progression-failed', failureCode: 'NATIVE_CREDENTIAL_UNAVAILABLE' });
    expect(errors.filter(code => code === 'NATIVE_CREDENTIAL_UNAVAILABLE')).toHaveLength(3); expect(errors).toContain('RUN_PROGRESSION_PARKED');
    await f.sinkClosed();
  } finally { f.store.close(); }
}, 30000);
