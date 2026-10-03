import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfiguredRun, reserveConfiguredRunTasks, evaluateConfiguredTask, inspectConfiguredRun } from '../../../src/composition/core/runs/index.js';
import { executeConfiguredTask, openConfiguredExecution } from '../../../src/composition/core/execution/index.js';
import { prepareConfiguredWorkspacePatch } from '../../../src/composition/core/workspace-patch/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { FileArtifactStore, DockerSupervisor, GitRunWorkspaceProvider, readWorkspace, SnapshotBudget } from '#adapters/index.js';
import { RunWorkspaceAcquisitionApplication, type WorkspacePatchError } from '#engine/index.js';
import { clearConfigCache, productResourcePath, inspectProductDirectory } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
const exec = promisify(execFile), roots: string[] = [], cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('configured handoff producer to dependent (source only)', () => {
  it.for([false, true, 'unapplicable'] as const)('read-only note/shared mounts, receipt and fixed base with startFrom=%s', async (startFrom, context) => {
    const capability: { code: WorkspacePatchError['code']; reason: string } | null = process.platform === 'linux' ? null
      : { code: 'PATCH_UNSAFE', reason: 'configured Docker producer/patch fixture requires Linux descriptor-relative snapshot custody' };
    if (capability) {
      await expect(readWorkspace(join(tmpdir(), 'aof-never-created'), new SnapshotBudget({ maxBytes: 65536, maxEntries: 100, maxDepth: 10, maxPathBytes: 256 }, Date.now() + 10000))).rejects.toMatchObject({ code: capability.code });
      context.skip(`${capability.code}: ${capability.reason}; real refusal before path access verified; portable default/empty rules remain in handoff-graph and handoff-patch-start`);
    }
    if (!process.env.DECKENT_TEST_DOCKER_IMAGE) context.skip('SUPERVISOR_OPTIONS_INVALID: DECKENT_TEST_DOCKER_IMAGE is not configured; configured Docker producer verify-not-run');
    const root = await mkdtemp(join(tmpdir(), 'aof-execution-')); roots.push(root);
    const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
    const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', project, ...args])).stdout.trim();
    await git('init'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(project, 'input'), 'fixed-base\n'); await git('add', 'input'); await git('commit', '-m', 'base'); const base = await git('rev-parse', 'HEAD');
    await writeFile(join(project, 'input'), 'owner-wip\n');
    const registry = fixtureDockerRegistry(['producer', 'consumer']);
    const producer = "const fs=require('node:fs'),crypto=require('node:crypto');fs.writeFileSync('result','accepted artifact');fs.writeFileSync('input','predecessor-patch\\n');const digest=crypto.createHash('sha256').update('accepted artifact').digest('hex');console.log(JSON.stringify({schemaVersion:1,kind:'native-worker-report',status:'reported',report:{schemaVersion:1,summary:'done',changedFiles:['input','result'],checks:[],openIssues:[],handoff:{toTask:'b',summary:'Use accepted result',artifacts:[{name:'code',digest}],openQuestions:['Check integration']},sharedNotes:['Only this accepted Run']}}));";
    const consumer = `const fs=require('node:fs');const paths=['/deckent/inputs/_handoff/a.json','/deckent/inputs/_shared.json'];for(const p of paths){let ro=false;try{fs.writeFileSync(p,'overwrite')}catch(e){ro=e.code==='EROFS'}if(!ro)process.exit(71)}const note=JSON.parse(fs.readFileSync(paths[0],'utf8'));if(note.summary!=='Use accepted result')process.exit(72);const shared=JSON.parse(fs.readFileSync(paths[1],'utf8'));if(shared[0].text!=='Only this accepted Run')process.exit(73);if(fs.readFileSync('input','utf8')!==${JSON.stringify(startFrom ? 'predecessor-patch\n' : 'fixed-base\n')})process.exit(74);console.log('handoff received');`;
    registry.profiles[0]!.parameters = { ...registry.profiles[0]!.parameters, imageId: process.env.DECKENT_TEST_DOCKER_IMAGE!, argv: ['node', '-e', producer], outputFiles: { maxBytes: 1024, maxFiles: 1, files: [{ name: 'code', path: 'result', maxBytes: 1024 }] } };
    const { outputFiles: _producerOutput, ...consumerParameters } = registry.profiles[0]!.parameters; void _producerOutput;
    registry.profiles.push({ ...registry.profiles[0]!, id: 'consumer', parameters: { ...consumerParameters, argv: ['node', '-e', consumer] } });
    registry.kinds = [{ kind: 'producer', profile: { id: registry.profiles[0]!.id, version: 1 } }, { kind: 'consumer', profile: { id: 'consumer', version: 1 } }];
    const { argv: _argv, outputFiles: _files, ...docker } = registry.profiles[0]!.parameters; void _argv; void _files;
    const options = { env: { HOME: join(root, 'home') } };
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, artifacts: { maxBytes: 16_777_216 }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry }, execution: { docker: { executable: '/usr/bin/docker', ...docker }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
    const opened = await openConfiguredAttemptStore(project, options); await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); opened.store.close();
    const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
    await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'handoff', restrictions: [], grants: [
      { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
      { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
      { id: 'attempt', effect: 'allow', actions: ['execute', 'evaluate', 'read-output', 'recover-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } } ] }), { mode: 0o600 });
    const graph = { schemaVersion: 4 as const, revision: 1, tasks: [{ id: 'a', kind: 'producer', dependencies: [], acceptanceCriteria: ['exit'] }, { id: 'b', kind: 'consumer', dependencies: startFrom ? [{ taskId: 'a', startFrom: 'accepted-patch' as const }] : ['a'], acceptanceCriteria: ['exit'] }], criterionDefinitions: [{ id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
    await createConfiguredRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'create', graph }, options);
    const source = (await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve-a', expectedRevision: 0 }, options)).reservation.identities[0]!;
    const runtime = await openConfiguredExecution(project, project, options);
    const identities = [source];
    cleanup.push(async () => { try { for (const identity of identities) { const dispatch = await runtime.store.loadBoundDispatch(identity); if (dispatch) { const supervisor = await DockerSupervisor.restoreProfile(dispatch.profile); await supervisor.cancel(dispatch.request); await supervisor.release(dispatch.request); } } } finally { runtime.store.close(); } });
    expect((await executeConfiguredTask(project, source, options)).execution.terminal?.exitCode).toBe(0);
    if (startFrom) await prepareConfiguredWorkspacePatch(project, source, options);
    const accepted = await evaluateConfiguredTask(project, { schemaVersion: 1, commandId: 'eval-a', identity: source, expectedRevision: (await runtime.store.loadRun('s', 'r'))!.revision }, options);
    expect(accepted.evaluation.run.tasks[0]!.phase).toBe('accepted');
    const target = (await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve-b', expectedRevision: accepted.evaluation.run.revision }, options)).reservation.identities[0]!; identities.push(target);
    if (startFrom === 'unapplicable') {
      const lease = await new RunWorkspaceAcquisitionApplication(runtime.store, new GitRunWorkspaceProvider(runtime.workspaces)).acquire(target);
      await writeFile(join(lease.workspace, 'input'), 'conflicting-start\n');
      await expect(executeConfiguredTask(project, target, options)).rejects.toMatchObject({ code: 'HANDOFF_PATCH_UNAPPLICABLE' });
      expect(await runtime.store.loadBoundDispatch(target)).toBeNull();
      const refused = await runtime.store.loadRun('s', 'r');
      expect(refused!.progress[1]!.phase).toBe('failed'); expect(refused!.state.kind).toBe('parked');
      expect((await runtime.store.load('s', target.attemptId))!.lastObservation!.result).toEqual({ kind: 'handoff-refused', code: 'HANDOFF_PATCH_UNAPPLICABLE' });
      expect(await readFile(join(project, 'input'), 'utf8')).toBe('owner-wip\n'); return;
    }
    expect((await executeConfiguredTask(project, target, options)).execution.terminal?.exitCode).toBe(0);
    const inspected = await inspectConfiguredRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, options);
    expect(inspected.run!.tasks[1]!.handoffs).toHaveLength(1);
    const lease = await runtime.workspaces.openRecorded(target); expect(lease!.baseCommit).toBe(base);
    expect(await readFile(join(project, 'input'), 'utf8')).toBe('owner-wip\n');
    const output = (await runtime.store.loadBoundDispatch(target))!.output!;
    const artifacts = new FileArtifactStore({ root: await inspectProductDirectory(opened.layout, 'artifacts'), maxBytes: 16_777_216 });
    expect(JSON.parse(Buffer.from(await artifacts.read('s', output)).toString()).stdout).toContain('handoff received');
  });
});
