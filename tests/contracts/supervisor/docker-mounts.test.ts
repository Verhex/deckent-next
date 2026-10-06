import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { DockerSupervisor } from '#adapters/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const imageId = 'sha256:' + 'b'.repeat(64);
type Mount = { Type: string; Source: string; Destination: string; RW: boolean };

/** Fake daemon: the created container reports whatever `.Mounts` the case dictates; the test records whether `start` ever ran. */
async function run(mutate: (mounts: Mount[], workspace: string) => Mount[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docker-mounts-'))); roots.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const request = { protocolVersion: 1 as const, identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' }, workspace, argv: ['node', 'x'] };
  let label = '', state = 'missing', mounts: Mount[] = []; const verbs: string[] = [];
  const runner = async ({ args }: { args: readonly string[] }) => {
    const at = args[0] === '--host' ? 2 : 0, verb = args[at]!; verbs.push(verb);
    if (verb === 'context') return { stdout: JSON.stringify({ Host: 'unix:///var/run/docker.sock' }), stderr: '' };
    if (verb === 'inspect') {
      if (state === 'missing') throw { stderr: 'No such object: ' + args[at + 1] };
      return { stdout: JSON.stringify([{ Id: 'c'.repeat(64), Image: imageId, Config: { Labels: { 'deckent.request': label } }, Mounts: mounts,
        State: { Status: state, ExitCode: 0 } }]), stderr: '' };
    }
    if (verb === 'create') {
      label = args[args.indexOf('--label') + 1]!.slice('deckent.request='.length); state = 'created';
      mounts = mutate([{ Type: 'bind', Source: workspace, Destination: '/workspace', RW: true }], workspace); return { stdout: 'c'.repeat(64), stderr: '' };
    }
    if (verb === 'start') { state = 'exited'; return { stdout: '', stderr: '' }; }
    throw new Error('unexpected Docker command ' + verb);
  };
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId, uid: 1000, gid: 1000, cpus: 1,
    memoryBytes: 268435456, pids: 64, tmpBytes: 16777216, logMaxSizeKiB: 64, logMaxFiles: 2, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 }, runner);
  return { supervisor, request, verbs, workspace };
}

it('starts only a container whose realised mounts equal the requested set', async () => {
  const f = await run(mounts => mounts);
  expect((await f.supervisor.execute(f.request)).result).toEqual({ kind: 'exited', exitCode: 0 }); expect(f.verbs).toContain('start');
});

it.for([
  ['an extra mount (image VOLUME or daemon-added)', (m: Mount[]) => [...m, { Type: 'volume', Source: '/var/lib/docker/volumes/x', Destination: '/data', RW: true }]],
  ['a missing workspace mount', () => []],
  ['a re-sourced workspace', (m: Mount[]) => m.map(x => ({ ...x, Source: '/etc' }))],
  ['a re-targeted workspace', (m: Mount[]) => m.map(x => ({ ...x, Destination: '/' }))],
  ['a duplicated entry', (m: Mount[]) => [...m, ...m]],
  ['a volume instead of a bind', (m: Mount[]) => m.map(x => ({ ...x, Type: 'volume' }))],
] as const)('refuses before start when the daemon reports %s', async ([, mutate]) => {
  const f = await run(mutate as (m: Mount[]) => Mount[]);
  await expect(f.supervisor.execute(f.request)).rejects.toMatchObject({ code: 'SUPERVISOR_IDENTITY_CONFLICT' });
  expect(f.verbs).not.toContain('start');
});
