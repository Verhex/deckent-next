import { createLayoutPolicySource } from '../../../src/composition/core/policy/index.js';
import { LocalOsPrincipalVerifier } from '#adapters/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { openConfiguredExecution } from '../../../src/composition/core/execution/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { createAttempt } from '#domain/index.js';
import { DispatchApplication, DispatchPolicyAuthorization } from '#engine/index.js';
const exec = promisify(execFile); const roots: string[] = []; const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-composed-execution-')); roots.push(root);
  const project = join(root, 'project'); const source = join(root, 'source'); const data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(source);
  const configPath = join(project, '.deckent/config.json'); const env = { HOME: join(root, 'home') };
  return { root, project, source, data, configPath, env };
}
it('keeps execution disabled without explicit runtime settings and rejects mutable image tags before data writes', async () => {
  const f = await fixture(); await writeFile(f.configPath, JSON.stringify({ layout: { root: f.data } }));
  await expect(openConfiguredExecution(f.project, f.source, { env: f.env })).rejects.toThrow('EXECUTION_NOT_CONFIGURED');
  await expect(stat(f.data)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(f.configPath, JSON.stringify({ layout: { root: f.data }, execution: { docker: { imageId: 'node:latest' }, git: {} } })); clearConfigCache();
  await expect(openConfiguredExecution(f.project, f.source, { env: f.env })).rejects.toThrow();
  await expect(stat(f.data)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.skipIf(!imageId)('uses one configured snapshot for separate source repo, Git workspace, Docker, ledger and retained output', async () => {
  const f = await fixture();
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', f.source, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(f.source, 'input'), 'base'); await git('add', 'input'); await git('commit', '-m', 'fixture');
  const baseCommit = await git('rev-parse', 'HEAD'); await writeFile(join(f.source, 'input'), 'owner-wip');
  await writeFile(f.configPath, JSON.stringify({ layout: { root: f.data }, artifacts: { maxBytes: 1048576 }, execution: {
    docker: { executable: '/usr/bin/docker', imageId, logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 268435456, pids: 64,
      cpus: 1, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 },
    git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 },
  } }));
  const runtime = await openConfiguredExecution(f.project, f.source, { env: f.env });
  const identity = { runId: 'r', taskId: 't', attemptId: randomUUID(), scopeId: 's', generation: 1, layoutRevision: runtime.layout.revision };
  const workspaceRequest = { schemaVersion: 1 as const, identity, baseCommit };
  const lease = await runtime.workspaces.allocate(workspaceRequest);
  const request = { protocolVersion: 1 as const, identity, workspace: lease.workspace, argv: ['node', '-e', "console.log(require('node:fs').readFileSync('/workspace/input','utf8'))"] };
  const verifier = new LocalOsPrincipalVerifier(['s']); const principal = await verifier.verify(undefined);
  const policyPath = productResourcePath(runtime.layout, 'policy');
  const writePolicy = async (actions: string[], revision: string) => {
    const document = { schemaVersion: 1, revision, restrictions: [], grants: [{ id: 'local-owner', effect: 'allow', actions, scopes: ['s'],
      principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'attempt', ids: [identity.attemptId] } }] };
    await writeFile(policyPath + '.next', JSON.stringify(document), { mode: 0o600 }); await rename(policyPath + '.next', policyPath);
  };
  await writePolicy(['execute', 'release'], 'initial');
  const policy = new DispatchPolicyAuthorization(createLayoutPolicySource(runtime.layout, process.getuid!(), 65536));
  const app = new DispatchApplication(runtime.store, runtime.supervisor, verifier, policy, 'runner', runtime.artifacts);
  try {
    await writeFile(f.configPath, JSON.stringify({ layout: { root: join(f.root, 'changed') } })); clearConfigCache();
    await runtime.store.commit({ commandId: 'admit', command: 'test-admission', expectedRevision: null, snapshot: createAttempt(identity) });
    const result = await app.execute(request); expect(result.record.terminal?.exitCode).toBe(0);
    const output = JSON.parse(new TextDecoder().decode(await runtime.artifacts.read('s', result.record.output!)));
    expect(output.stdout).toBe('base\n'); expect(runtime.layout.root).toBe(f.data);
    expect(await readFile(join(f.source, 'input'), 'utf8')).toBe('owner-wip');
    await expect(stat(join(f.root, 'changed'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writePolicy(['release'], 'revoked');
    await expect(app.execute(request)).rejects.toThrow('POLICY_DENIED');
    await app.release(request);
  } finally { await runtime.supervisor.release(request); await runtime.workspaces.release(workspaceRequest); runtime.store.close(); }
}, 20000);
