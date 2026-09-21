import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { hostname, tmpdir, userInfo } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectConfiguredWorkers } from '../../../src/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '../../../src/composition/core/runs/index.js';
import { executeConfiguredTask, openConfiguredExecution } from '../../../src/composition/core/execution/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { DockerSupervisor } from '#adapters/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
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
  const config = { layout: { root: join(root, 'data') }, inspection: { workers: { heartbeatMs: 100, staleMs: 1000, sources: [] as { id: string; kind: string; path: string; scopeId: string }[] } },
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
  const execute = () => executeConfiguredTask(project, identity, options);
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
    const lease = (await f.runtime.workspaces.openRecorded(f.identity))!;
    for (const extension of ['hb', 'log', 'result']) expect((await readFile(join(dirname(lease.workspace), 'worker.' + extension))).length).toBeGreaterThan(0);
    await other.policy(false); expect((await f.inspect()).sources[1]?.status).toBe('denied');
    await f.policy(true, false); expect((await f.inspect()).sources[0]?.workers[0]?.diagnostics).toContain('output-denied');
    await f.policy(false); await expect(f.inspect()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  }, 30000);
});
