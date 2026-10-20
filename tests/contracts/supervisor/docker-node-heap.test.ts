import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerSupervisor } from '#adapters/index.js';
import type { SandboxRequest } from '#engine/index.js';

// PRE-2 VERIFY-CRASH (2026-10-20): inside a 2 GiB container Node's default old-space ceiling is ~1120 MiB (55 %), below what the
// repository's `tsc --noEmit` needs (~1.17 GiB), so verify-light aborted with exit 134 while the cgroup still had ~0.8 GiB free.
// The adapter derives the Node heap ceiling from the container memory limit it sets, so the two limits agree.
const MiB = 1024 * 1024, twoGiB = 2048 * MiB;
const roots: string[] = []; const releases: (() => Promise<void>)[] = [];
afterEach(async () => { for (const release of releases.splice(0)) await release(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = () => ({ scopeId: 's', runId: 'r', taskId: 't', attemptId: randomUUID(), generation: 1, layoutRevision: 'l' });
const limits = { cpus: 1, pids: 64, tmpBytes: 16777216, logMaxSizeKiB: 64, logMaxFiles: 2, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };

async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docker-node-heap-'))); roots.push(root);
  const path = join(root, 'workspace'); await mkdir(path); return { root, path };
}
/** Fake daemon that records the exact `create` argv and reports a clean exit. */
async function created(memoryBytes: number, argv: string[] = ['node', 'x']) {
  const { root, path } = await workspace(), imageId = 'sha256:' + 'b'.repeat(64);
  let label = '', state = 'missing', create: readonly string[] = [];
  const runner = async ({ args }: { args: readonly string[] }) => {
    const at = args[0] === '--host' ? 2 : 0, verb = args[at]!;
    if (verb === 'context') return { stdout: JSON.stringify({ Host: 'unix:///var/run/docker.sock' }), stderr: '' };
    if (verb === 'inspect') {
      if (state === 'missing') throw { stderr: 'No such object: ' + args[at + 1] };
      return { stdout: JSON.stringify([{ Id: 'c'.repeat(64), Image: imageId, Config: { Labels: { 'deckent.request': label } },
        Mounts: [{ Type: 'bind', Source: path, Destination: '/workspace', RW: true }], State: { Status: state, ExitCode: 0 } }]), stderr: '' };
    }
    if (verb === 'create') { create = args.slice(at); label = args[args.indexOf('--label') + 1]!.slice('deckent.request='.length); state = 'created'; return { stdout: 'c'.repeat(64), stderr: '' }; }
    if (verb === 'start') { state = 'exited'; return { stdout: '', stderr: '' }; }
    throw new Error('unexpected Docker command ' + verb);
  };
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId, uid: 1000, gid: 1000, memoryBytes, ...limits }, runner);
  await supervisor.execute({ protocolVersion: 1, identity: identity(), workspace: path, argv });
  return { create, imageId };
}

describe('Node heap ceiling follows the container memory limit (PRE-2)', () => {
  it('passes a heap ceiling derived from memoryBytes as container environment, before the image and never in the task argv', async () => {
    const { create, imageId } = await created(twoGiB, ['sh', '-c', 'npm run typecheck']);
    const at = create.indexOf('--env');
    expect(at).toBeGreaterThan(0);
    expect(create[at + 1]).toBe('NODE_OPTIONS=--max-old-space-size=1536');
    expect(at).toBeLessThan(create.indexOf(imageId));
    expect(create.slice(create.indexOf(imageId) + 1)).toEqual(['-c', 'npm run typecheck']);
    expect(create.filter(arg => arg === '--env')).toHaveLength(1);
  });
  it('scales with the configured limit (3 GiB → 2304 MiB) and stays below it', async () => {
    const { create } = await created(3072 * MiB);
    expect(create[create.indexOf('--env') + 1]).toBe('NODE_OPTIONS=--max-old-space-size=2304');
  });
  it('sets no ceiling when the limit is too small to derive one whole MiB', async () => {
    const { create } = await created(MiB);
    expect(create).not.toContain('--env');
  });
});

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
describe.skipIf(!imageId)('real Docker: the Node heap ceiling inside a 2 GiB container (explicit pinned test image required)', () => {
  it('reports a V8 heap limit derived from the container limit, not the ~1120 MiB default that aborted verify-light', async () => {
    const { root, path } = await workspace();
    const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
      memoryBytes: twoGiB, ...limits });
    const request: SandboxRequest = { protocolVersion: 1, identity: identity(), workspace: path,
      argv: ['node', '-e', "process.stdout.write(String(require('node:v8').getHeapStatistics().heap_size_limit))"] };
    releases.push(() => supervisor.release(request).then(() => undefined));
    const result = await supervisor.execute(request);
    expect(result.result).toEqual({ kind: 'exited', exitCode: 0 });
    const limit = Number(result.stdout);
    expect(limit).toBeGreaterThanOrEqual(1536 * MiB);
    expect(limit).toBeLessThan(twoGiB);
  });
});
