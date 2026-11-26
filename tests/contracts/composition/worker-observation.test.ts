import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { hostname, tmpdir, userInfo } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectConfiguredWorkers } from '../../../src/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '../../../src/composition/core/runs/index.js';
import { executeConfiguredTask, openConfiguredExecution } from '../../../src/composition/core/execution/index.js';
import { openConfiguredArtifactStore, openConfiguredAttemptStore } from '../support/configured-open.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { clearConfigCache, createHmacIntegrity, productResourcePath, getConfigKnownSecrets, DeckentError, reportQueryError, SystemTrustedClock } from '#platform/index.js';
import { DockerSupervisor, openSqliteAttemptStore } from '#adapters/index.js';
import { openSqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { AuditApplication, DispatchApplication, MonitorSourceMemo, type ExecutionSupervisor, type WorkerActivity } from '#engine/index.js';
import { inspectMonitor } from '#composition/index.js';
import { main } from '#surfaces/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
// eslint-disable-next-line no-restricted-imports -- Exercise the private Attempt sampler while the Task binding is assembled separately.
import { startConfiguredWorkerObservation } from '../../../src/composition/core/execution/internal/observation.js';
// eslint-disable-next-line no-restricted-imports -- Fault the actual refusal writer without adding a public test port.
import { createRefusalAudit } from '../../../src/composition/core/agent-turn/internal/refusal-audit.js';
import { custodyPrincipal, custodyProfile, custodyProfiles } from '../support/custody.js';
import { fixtureDockerRegistry, fixtureExecution } from '../support/execution-registry.js';
const exec = promisify(execFile); const roots: string[] = []; const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); clearConfigCache(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(delay: number) {
  const root = await mkdtemp(join(tmpdir(), 'dn-monitor-')); roots.push(root); const project = join(root, 'project');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const git = (...args: string[]) => exec('/usr/bin/git', ['-C', project, ...args]);
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(project, 'note'), 'before'); await git('add', 'note'); await git('commit', '-m', 'base');
  const registry = fixtureDockerRegistry(['coding']); const parameters = registry.profiles[0]!.parameters;
  parameters.imageId = process.env.DECKENT_TEST_DOCKER_IMAGE!; parameters.argv = ['node', '-e', `setTimeout(()=>require('node:fs').writeFileSync('note','after'),${delay})`];
  const { argv: _argv, ...bounds } = parameters; void _argv;
  const configPath = join(project, '.deckent/config.json');
  const config = { resourceObservation: { intervalMs: 100 }, layout: { root: join(root, 'data') }, inspection: { workers: { heartbeatMs: 100, staleMs: 1000, sources: [] as { id: string; kind: string; path: string; scopeId: string }[] } },
    admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry },
    execution: { docker: { executable: '/usr/bin/docker', ...bounds }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } };
  await writeFile(configPath, JSON.stringify(config)); const options = { env: { HOME: join(root, 'home') } };
  const opened = await openConfiguredAttemptStore(project, options); await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); opened.store.close();
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  const policy = async (inspect = true, output = true) => writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'monitor', restrictions: [], grants: [
    { id: 'run', effect: 'allow', scopes: ['s'], principals, actions: ['create', 'reserve'], resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', scopes: ['s'], principals, actions: ['use'], resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', scopes: ['s'], principals, actions: ['execute', ...(output ? ['read-output'] : [])], resource: { kind: 'attempt', ids: 'all' } },
    ...(inspect ? [{ id: 'inspect', effect: 'allow', scopes: ['s'], principals, actions: ['inspect'], resource: { kind: 'scope', ids: ['s'] } }] : []),
  ] }), { mode: 0o600 }); await policy();
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'] }], criterionDefinitions: [{ id: 'exit', version: 1, description: 'exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  await createConfiguredRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'create', graph }, options);
  const identity = (await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve', expectedRevision: 0 }, options)).reservation.identities[0]!;
  const runtime = await openConfiguredExecution(project, project, options);
  cleanup.push(async () => { try { const record = await runtime.store.loadBoundDispatch(identity); if (record) { const supervisor = await DockerSupervisor.restoreProfile(record.profile); await supervisor.cancel(record.request); await supervisor.release(record.request); } } finally { runtime.store.close(); } });
  const execute = async () => {
    try { return await executeConfiguredTask(project, identity, options); }
    catch (error) {
      if (error instanceof DeckentError) await reportQueryError(error, async () => getConfigKnownSecrets(await loadComposedConfig(project, options)),
        event => { console.info('worker-execution-diagnostic', JSON.stringify(event)); });
      throw error;
    }
  };
  const inspect = () => inspectConfiguredWorkers(project, { schemaVersion: 1, scopeId: 's' }, options);
  return { root, project, config, configPath, options, policy, identity, runtime, execute, inspect };
}
describe.skipIf(process.platform !== 'linux' || !process.env.DECKENT_TEST_DOCKER_IMAGE)('worker observation surfaces', () => {
  it('observes live and terminal real workers across local projects and legacy files, and stopping CLI watch never cancels execution', async () => {
    const f = await fixture(10000), other = await fixture(10); await other.execute();
    const legacy = join(f.root, 'legacy'); await mkdir(legacy, { mode: 0o700 });
    await writeFile(join(legacy, 'task-old.hb'), JSON.stringify({ status: 'EXECUTING', pid: process.pid }));
    await writeFile(join(legacy, 'task-old.log'), 'rate limit error synthetic-secret');
    await writeFile(join(legacy, 'task-old.result'), JSON.stringify({ selfAssessment: 'GO', notes: 'synthetic-secret' }));
    f.config.inspection.workers.sources = [{ id: 'external', kind: 'next-project', path: other.project, scopeId: 's' }, { id: 'legacy', kind: 'legacy-tasks', path: legacy, scopeId: 's' }];
    await writeFile(f.configPath, JSON.stringify(f.config)); clearConfigCache();
    const execution = f.execute();
    let live: Awaited<ReturnType<typeof f.inspect>> | undefined;
    for (let i = 0; i < 40; i++) { live = await f.inspect(); if (live.sources[0]?.workers[0]?.process === 'running' && live.sources[0]?.workers[0]?.files?.heartbeat.state === 'available') break; await sleep(100); }
    expect(live?.sources[0]?.workers[0]).toMatchObject({ process: 'running', terminal: null, files: { heartbeat: { freshness: 'fresh' } } });
    expect(live?.sources[1]?.workers[0]?.terminal?.exitCode).toBe(0); expect(live?.sources[2]?.workers[0]?.terminal).toBeNull();
    expect(JSON.stringify(live)).not.toContain('synthetic-secret');
    const child = spawn(process.execPath, [resolve('dist/composition/core/cli/internal/entry.js'), 'workers', 'watch', '--project', f.project, '--scope', 's', '--json'],
      { cwd: process.cwd(), env: { ...process.env, ...f.options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: string[] = []; let buffer = ''; const exit = new Promise<number | null>(done => child.once('exit', done));
    await new Promise<void>((done, reject) => { child.once('error', reject); child.stdout.on('data', chunk => { buffer += String(chunk); if (buffer.includes('\n')) { lines.push(buffer.split('\n')[0]!); done(); } }); });
    child.kill('SIGINT'); expect(await exit).toBe(0); expect(JSON.parse(lines[0]!).control).toBe('observe-only');
    const record = (await f.runtime.store.loadBoundDispatch(f.identity))!;
    expect((await (await DockerSupervisor.restoreProfile(record.profile)).inspectActivity(record.request)).state).toBe('running');
    expect((await execution).execution.terminal?.exitCode).toBe(0);
    const final = await f.inspect(); expect(final.sources[0]?.workers[0]).toMatchObject({ process: 'exited', terminal: { exitCode: 0 }, files: { result: { state: 'available', exitCode: 0 } } });
    const resources = final.sources[0]?.workers[0]?.resources;
    console.info('worker-resource-observation', JSON.stringify(resources));
    expect(resources?.sampleCount, JSON.stringify(resources)).toBeGreaterThanOrEqual(2);
    expect(resources?.sampledPeakBytes, JSON.stringify(resources)).toBeGreaterThan(0);
    const lease = (await f.runtime.workspaces.openRecorded(f.identity))!;
    for (const extension of ['hb', 'log', 'result']) expect((await readFile(join(dirname(lease.workspace), 'worker.' + extension))).length).toBeGreaterThan(0);
    await other.policy(false); expect((await f.inspect()).sources[1]?.status).toBe('denied');
    await f.policy(true, false); expect((await f.inspect()).sources[0]?.workers[0]?.diagnostics).toContain('output-denied');
    expect((await f.inspect()).sources[0]?.workers[0]?.resources).toBeUndefined();
    await f.policy(false); await expect(f.inspect()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  }, 30000);
});

it.skipIf(process.platform !== 'linux')('projects an exact Attempt’s failed refusal append from heartbeat and final result, while the sidecars are in custody', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dn-audit-loss-')); roots.push(project);
  await mkdir(join(project, '.deckent'), { mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(project, 'data') } }));
  const options = { env: { HOME: join(project, 'home') } };
  const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
  const sqlite = { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' } as const;
  const store = await openSqliteAttemptStore(opened.path, sqlite, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles);
  cleanup.push(async () => store.close());
  const { store: artifacts } = await openConfiguredArtifactStore(project, options);
  const identity = { scopeId: 's', runId: 'r-audit', taskId: 't', attemptId: 'a-audit', layoutRevision: 'layout', generation: 1 };
  const custody = join(project, 'attempt');
  await mkdir(custody, { mode: 0o700 });
  const request = { protocolVersion: 1, identity, workspace: join(custody, 'tree'), argv: ['fixture'] } as const;
  const capacity = { executionSlots: 1, inFlightSlots: 1 }, graph = { schemaVersion: 2 as const, revision: 1,
    tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'exit', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity });
  const actor = { id: custodyPrincipal.id, issuer: custodyPrincipal.issuer, subject: custodyPrincipal.subject };
  await store.createRun({ commandId: 'create', actor, identity: { scopeId: 's', runId: 'r-audit', layoutRevision: 'layout' },
    graph, execution: fixtureExecution(graph), now: 1, policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: ['t'] } });
  await store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 's', runId: 'r-audit', expectedRevision: 0, now: 2, identities: [identity] });
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  const policy = (output: boolean) => writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: output ? 'allow' : 'deny', restrictions: [], grants: [
    { id: 'inspect', effect: 'allow', scopes: ['s'], principals, actions: ['inspect'], resource: { kind: 'scope', ids: ['s'] } },
    ...(output ? [{ id: 'output', effect: 'allow', scopes: ['s'], principals, actions: ['read-output'], resource: { kind: 'attempt', ids: ['a-audit'] } }] : []),
  ] }), { mode: 0o600 });
  await policy(true);
  const auditStore = await openSqliteAuditStore(opened.path, sqlite);
  cleanup.push(async () => auditStore.close());
  const integrity = createHmacIntegrity('fixture', Buffer.alloc(32, 7)), audit = new AuditApplication(auditStore, integrity);
  const append = vi.spyOn(audit, 'record');
  const db = new DatabaseSync(opened.path);
  try { db.exec("CREATE TRIGGER refuse_fixture_append BEFORE INSERT ON audit_events WHEN NEW.kind='access-refusal-summary' BEGIN SELECT RAISE(ABORT,'fixture'); END"); }
  finally { db.close(); }
  const { scopeId, runId, taskId, attemptId, generation } = identity;
  const writer = createRefusalAudit({ scopeId, attempt: { runId, taskId, attemptId, generation }, turnId: 'worker-turn', principal: principals[0]!,
    installationId: null, companyId: 'fixture', clock: new SystemTrustedClock(), async write(record) { record(audit, integrity); } });
  const lossCode = 'refusal-audit-loss';
  let loss: WorkerActivity['refusalAuditLoss'], processState: 'running' | 'exited' = 'running';
  const inspect = () => inspectConfiguredWorkers(project, { schemaVersion: 1, scopeId: 's' }, options);
  const memo = new MonitorSourceMemo();
  const monitor = () => inspectMonitor(project, options, { schemaVersion: 1 }, memo);
  const monitorAttempt = (snapshot: Awaited<ReturnType<typeof monitor>>) => snapshot.installs[0]!.runs.find(run => run.runId === identity.runId)!.tasks[0]!.lastAttempt!;
  const sidecar = (suffix: string) => join(custody, 'worker.' + suffix);
  const effect = join(project, 'completed-effect');
  const supervisor = {
    async captureProfile() { return custodyProfile; },
    async execute() {
      await writeFile(effect, 'settled');
      const before = audit.list('s', 0, 10);
      writer.observe({ basis: 'agent-tool-policy', reason: 'AGENT_TOOL_POLICY_DENIED', role: 'tool', policyRevision: 'allow' });
      const observed = await writer.flush();
      expect(observed).toBe(lossCode); expect(audit.list('s', 0, 10)).toEqual(before);
      expect(append.mock.results).toEqual([{ type: 'throw', value: expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }) }]);
      if (observed) loss = observed;
      await vi.waitFor(async () => expect((await inspect()).sources[0]!.workers[0]).toMatchObject({
        identity, terminal: null, files: { heartbeat: { phase: 'running' }, result: { state: 'missing' }, refusalAuditLoss: lossCode }, diagnostics: expect.arrayContaining([lossCode]),
      }));
      const live = await monitor();
      expect(monitorAttempt(live).diagnostics).toContain(lossCode);
      expect(JSON.stringify(live.installs[0]!.workers)).not.toContain(lossCode);
      processState = 'exited';
      return { handle: 'fixture', result: { kind: 'exited', exitCode: 0 }, interrupted: false, outputCompleteness: 'complete', stdout: 'done', stderr: '' } as const;
    },
    async inspectActivity() { return { state: processState, handle: 'fixture' }; },
    async observe() { throw new Error('unexpected reconciliation'); }, async cancel() { throw new Error('unexpected cancellation'); },
    async recoverOutput() { throw new Error('unexpected recovery'); }, async release() { throw new Error('unexpected release'); },
  } satisfies ExecutionSupervisor & { captureProfile(): Promise<typeof custodyProfile> };
  const app = new DispatchApplication(store, supervisor, { async verify() { return custodyPrincipal; } }, { async authorize() {} }, 'fixture', artifacts);
  const sample = (maxFileBytes: number) => startConfiguredWorkerObservation({
    supervisor, app, store, request, backend: 'native-cli-worker', provider: 'codex', heartbeatMs: 15, maxFileBytes, stall: undefined, gateway: undefined, refusalAuditLoss: () => loss,
  });
  const observer = await sample(4096);
  try { expect(await app.execute(request, undefined, observer.signal)).toMatchObject({ kind: 'terminal', record: { terminal: { exitCode: 0, interrupted: false } } }); }
  finally { await observer.close(); }
  const terminalOnly = JSON.parse(await readFile(sidecar('result'), 'utf8')) as WorkerActivity;
  await rm(sidecar('hb'));
  const output: string[] = [];
  expect(await main(['workers', '--scope', 's', '--json'], { root: project, env: options.env, inspectWorkers: inspectConfiguredWorkers,
    initialize() {}, stdout: { write(value: string) { output.push(value); } } })).toBe(0);
  expect(JSON.parse(output.join('')).sources[0].workers[0]).toMatchObject({ identity, terminal: { exitCode: 0 },
    files: { heartbeat: { state: 'missing' }, result: { state: 'available' }, refusalAuditLoss: lossCode }, diagnostics: expect.arrayContaining([lossCode]) });
  const final = await monitor();
  expect(monitorAttempt(final)).toMatchObject({ exitCode: 0, diagnostics: [lossCode] });
  const surface = await loadMonitorSurface();
  for (const [locale, message] of [['en', 'a tool refusal could not be recorded in the audit log'], ['tr', 'bir araç reddi denetim günlüğüne kaydedilemedi']] as const) {
    const row = surface.buildMonitorView(final, locale, true).tabs.runs.flatMap(block => block.kind === 'table' ? block.rows : [])
      .find(candidate => candidate.facets?.run === runId)!;
    expect(row.detail().flat().map(span => span.text).join('\n')).toContain(message);
  }
  await policy(false);
  expect((await inspect()).sources[0]!.workers[0]).toMatchObject({ identity, terminal: { exitCode: 0 }, files: null, diagnostics: ['output-denied'] });
  expect(monitorAttempt(await monitor()).diagnostics).toEqual(['output-denied']);
  await policy(true);
  const { refusalAuditLoss, ...ordinary } = terminalOnly;
  expect(refusalAuditLoss).toBe(lossCode);
  const maxBytes = Buffer.byteLength(JSON.stringify(ordinary) + '\n');
  await (await sample(maxBytes)).close();
  for (const suffix of ['hb', 'result']) {
    const bytes = await readFile(sidecar(suffix));
    expect(bytes.length).toBe(maxBytes);
    expect(JSON.parse(bytes.toString())).toEqual({ ...ordinary, observedAt: expect.any(Number) });
  }
  await (await sample(maxBytes + Buffer.byteLength(JSON.stringify(terminalOnly)) - Buffer.byteLength(JSON.stringify(ordinary)))).close();
  expect((await inspect()).sources[0]!.workers[0]!.diagnostics).toContain(lossCode);
  const settled = await store.loadBoundDispatch(identity);
  for (const suffix of ['hb', 'log', 'result']) await rm(sidecar(suffix));
  await rmdir(custody);
  expect((await inspect()).sources[0]!.workers[0]!.diagnostics).not.toContain(lossCode);
  expect(monitorAttempt(await monitor()).diagnostics ?? []).not.toContain(lossCode);
  expect(await store.loadBoundDispatch(identity)).toEqual(settled);
  expect(await readFile(effect, 'utf8')).toBe('settled');
});
