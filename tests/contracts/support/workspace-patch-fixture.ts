import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import { checkConfiguredWorkspaceIntegration, prepareConfiguredWorkspacePatch, previewConfiguredWorkspacePatch } from '../../../src/index.js';
import { executeConfiguredTask, openConfiguredExecution } from '../../../src/composition/core/execution/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '../../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { DockerSupervisor } from '#adapters/index.js';
import { productResourcePath } from '#platform/index.js';
import { fixtureDockerRegistry } from './execution-registry.js';
const exec = promisify(execFile);
/** Test-owned resources the caller removes in afterEach: temporary roots and cleanup callbacks (reverse order). */
export interface FixtureTracker { readonly roots: string[]; readonly cleanup: (() => Promise<void>)[] }
export interface WorkspacePatchFixtureOptions { readonly restartable?: boolean; readonly adoptionTargets?: readonly string[] }

/** Real Git project, configured Docker execution and one reserved coding attempt whose worker edits note/removed/added files. */
export async function workspacePatchFixture(track: FixtureTracker, { restartable = false, adoptionTargets }: WorkspacePatchFixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-patch-')); track.roots.push(root);
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
    execution: { docker: { executable: '/usr/bin/docker', ...bounds }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 },
      ...(adoptionTargets ? { adoption: { targets: adoptionTargets } } : {}) } }));
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
  track.cleanup.push(async () => { try {
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

/** Executed attempt with a prepared patch, source restored and a check proposal for a candidate command. */
export async function readyDeliveryFixture(track: FixtureTracker, options: WorkspacePatchFixtureOptions = {}) {
  const f = await workspacePatchFixture(track, options); await f.run(); await f.prepare();
  await writeFile(join(f.project, 'note.txt'), 'before\n');
  await f.policy(['read-output', 'prepare-integration', 'deliver-integration']);
  const checked = await checkConfiguredWorkspaceIntegration(f.project, f.identity, f.options);
  const command = { schemaVersion: 1 as const, commandId: 'candidate', identity: f.identity, proposal: checked.proposal };
  return { ...f, command };
}
