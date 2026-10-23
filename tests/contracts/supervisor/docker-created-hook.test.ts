import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { DockerSupervisor } from '#adapters/index.js';

// S6R-1 (design §2 F5): the application learns the created container's immutable id after `create` and the mount check, and before
// `start` — a launcher that dies during `start --attach` still leaves that id durable. A hook refusal (fenced, conflicting) starts nothing.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const imageId = 'sha256:' + 'b'.repeat(64), containerId = 'c'.repeat(64);
async function daemon(id = containerId) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docker-created-'))); roots.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const request = { protocolVersion: 1 as const, identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' }, workspace, argv: ['node', 'x'] };
  let label = '', state = 'missing'; const verbs: string[] = [];
  const runner = async ({ args }: { args: readonly string[] }) => {
    const at = args[0] === '--host' ? 2 : 0, verb = args[at]!; verbs.push(verb);
    if (verb === 'context') return { stdout: JSON.stringify({ Host: 'unix:///var/run/docker.sock' }), stderr: '' };
    if (verb === 'inspect') {
      if (state === 'missing') throw { stderr: 'No such object: ' + args[at + 1] };
      return { stdout: JSON.stringify([{ Id: id, Image: imageId, Config: { Labels: { 'deckent.request': label } },
        Mounts: [{ Type: 'bind', Source: workspace, Destination: '/workspace', RW: true }], State: { Status: state, ExitCode: 0, StartedAt: '2026-10-23T03:16:25.075503723Z' } }]), stderr: '' };
    }
    if (verb === 'create') { label = args[args.indexOf('--label') + 1]!.slice('deckent.request='.length); state = 'created'; return { stdout: id, stderr: '' }; }
    if (verb === 'start') { state = 'exited'; return { stdout: '', stderr: '' }; }
    throw new Error('unexpected Docker command ' + verb);
  };
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId, uid: 1000, gid: 1000, cpus: 1,
    memoryBytes: 268435456, pids: 64, tmpBytes: 16777216, logMaxSizeKiB: 64, logMaxFiles: 2, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 }, runner);
  return { supervisor, request, verbs };
}

it('reports the created container id after the mount check and before start', async () => {
  const f = await daemon(), seen: { id: string; verbs: string[] }[] = [];
  const result = await f.supervisor.execute(f.request, undefined, { async created(id) { seen.push({ id, verbs: [...f.verbs] }); } });
  expect(result.result).toEqual({ kind: 'exited', exitCode: 0 });
  expect(seen).toHaveLength(1); expect(seen[0]!.id).toBe(containerId);
  expect(seen[0]!.verbs).toContain('create'); expect(seen[0]!.verbs).not.toContain('start');
});

it('starts nothing when the hook refuses (the record could not be made durable)', async () => {
  const f = await daemon();
  await expect(f.supervisor.execute(f.request, undefined, { async created() { throw Object.assign(new Error('DISPATCH_FENCED'), { code: 'DISPATCH_FENCED' }); } }))
    .rejects.toMatchObject({ code: 'DISPATCH_FENCED' });
  expect(f.verbs).toContain('create'); expect(f.verbs).not.toContain('start');
});

it('refuses a daemon-reported id that is not an immutable 64-hex container id before reporting or starting it', async () => {
  const f = await daemon('not-a-container-id'); let called = false;
  await expect(f.supervisor.execute(f.request, undefined, { async created() { called = true; } })).rejects.toMatchObject({ code: 'SUPERVISOR_IDENTITY_CONFLICT' });
  expect(called).toBe(false); expect(f.verbs).not.toContain('start');
});

it('keeps the hook optional: callers without one launch as before', async () => {
  const f = await daemon();
  expect((await f.supervisor.execute(f.request)).result).toEqual({ kind: 'exited', exitCode: 0 }); expect(f.verbs).toContain('start');
});
