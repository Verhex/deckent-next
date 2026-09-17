import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openConfiguredWorkspaceBroker } from '../../../src/composition/core/workspaces/index.js';
import { clearConfigCache } from '#platform/index.js';
import { DockerSupervisor } from '#adapters/index.js';
const exec = promisify(execFile); const roots: string[] = [];
const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const execution = { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 };
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-layout-workspace-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(project);
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', project, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(project, 'tracked'), 'base'); await git('add', 'tracked'); await git('commit', '-m', 'fixture');
  const baseCommit = await git('rev-parse', 'HEAD');
  await writeFile(join(project, 'tracked'), 'owner-wip');
  await mkdir(join(project, '.deckent'), { mode: 0o700 });
  const data = join(root, 'managed'); const configPath = join(project, '.deckent/config.json');
  await writeFile(configPath, JSON.stringify({ layout: { root: data, resources: { workspaces: 'execution/checkouts' } } }));
  return { root, project, data, configPath, baseCommit, env: { HOME: join(root, 'home') } };
}
describe.skipIf(process.platform === 'win32')('configured workspace composition', () => {
  it('resolves one private configured directory and retains its layout snapshot', async () => {
    const f = await fixture(); const opened = await openConfiguredWorkspaceBroker(f.project, execution, { env: f.env });
    expect(opened.path).toBe(join(f.data, 'execution/checkouts'));
    expect((await stat(opened.path)).mode & 0o777).toBe(0o700);
    expect(opened.layout.bootstrapConfigPath).toBe(f.configPath);
    await writeFile(f.configPath, JSON.stringify({ layout: { root: join(f.root, 'other') } })); clearConfigCache();
    expect(opened.path).toBe(join(f.data, 'execution/checkouts'));
    expect(Object.isFrozen(opened.layout)).toBe(true);
  });
  it('rejects linked workspace directory without creating through it', async () => {
    const f = await fixture(); const outside = join(f.root, 'outside'); await mkdir(outside);
    await mkdir(join(f.data, 'execution'), { recursive: true, mode: 0o700 });
    await symlink(outside, join(f.data, 'execution/checkouts'));
    await expect(openConfiguredWorkspaceBroker(f.project, execution, { env: f.env })).rejects.toThrow('MANAGED_FILE_UNSAFE');
  });
  it.skipIf(!imageId)('runs a broker checkout in Docker without exposing the live managed tree or owner WIP', async () => {
    const f = await fixture(); const opened = await openConfiguredWorkspaceBroker(f.project, execution, { env: f.env });
    const secret = join(f.data, 'sentinel'); await writeFile(secret, 'host-only', { mode: 0o600 });
    const request = { schemaVersion: 1 as const, baseCommit: f.baseCommit, identity: { runId: 'r', taskId: 't', attemptId: randomUUID(), scopeId: 's', generation: 1, layoutRevision: opened.layout.revision } };
    const lease = await opened.broker.allocate(request);
    const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: opened.path, imageId: imageId!,
      uid: process.getuid!(), gid: process.getgid!(), memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216,
      deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 });
    const sandbox = { protocolVersion: 1 as const, identity: request.identity, workspace: lease.workspace,
      argv: ['node', '-e', `const fs=require('node:fs');
        for(const path of process.argv.slice(1)){try{fs.readFileSync(path);process.exit(3)}catch(e){if(e.code!=='ENOENT')throw e}}
        if(fs.readFileSync('/workspace/tracked','utf8')!=='base')process.exit(4);
        fs.writeFileSync('/workspace/tracked','worker');`, secret, f.configPath, '/workspace/.deckent/config.json'] };
    try {
      expect((await supervisor.execute(sandbox)).result).toEqual({ kind: 'exited', exitCode: 0 });
      expect(await readFile(secret, 'utf8')).toBe('host-only');
      expect(await readFile(join(f.project, 'tracked'), 'utf8')).toBe('owner-wip');
      expect(await readFile(join(lease.workspace, 'tracked'), 'utf8')).toBe('worker');
    } finally { await supervisor.release(sandbox); await opened.broker.release(request); }
  });
});
