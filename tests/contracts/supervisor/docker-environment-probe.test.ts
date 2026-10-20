import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { DockerSupervisor, DockerCommandFailure, nativeCodingEnvironmentProbes } from '#adapters/index.js';
import { assertTaskEnvironment } from '#engine/index.js';

// PRE-7 ORTAM-HAZIR: an environment probe runs on the worker's floor (same image, user, no network, sandbox flags, heap env, read-only
// dependency binds), never with the connection or a credential, with argv only from the adapter's probe-kind registry.
const exec = promisify(execFile), roots: string[] = [], MiB = 1024 * 1024;
const dockerImage = process.env.DECKENT_TEST_DOCKER_IMAGE;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const limits = { cpus: 1, pids: 64, tmpBytes: 16777216, logMaxSizeKiB: 64, logMaxFiles: 2, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const request = (workspace: string) => ({ protocolVersion: 1 as const, identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: randomUUID(), generation: 1, layoutRevision: 'l' }, workspace, argv: ['node', 'worker'] });
async function roots2() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docker-env-probe-'))); roots.push(root);
  const workspaces = join(root, 'workspaces'), deps = join(root, 'deps'), workspace = join(workspaces, 'w');
  await mkdir(workspace, { recursive: true }); await mkdir(deps); await writeFile(join(deps, 'marker.txt'), 'present\n');
  return { workspaces, deps, workspace };
}

it('runs a registry probe with the worker floor and without the workspace or the connection; exit codes map to met/unmet, a daemon refusal stays transient', async () => {
  const r = await roots2(), calls: (readonly string[])[] = []; let exit: number | null = 0;
  const runner = async ({ args }: { args: readonly string[] }) => {
    const at = args[0] === '--host' ? 2 : 0;
    if (args[at] === 'context') return { stdout: JSON.stringify({ Host: 'unix:///var/run/docker.sock' }), stderr: '' };
    calls.push(args.slice(at));
    if (args[at] === 'run' && exit !== 0) throw new DockerCommandFailure('', '', exit, false);
    return { stdout: '', stderr: '' };
  };
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: r.workspaces, imageId: 'sha256:' + 'b'.repeat(64), uid: 1000, gid: 1000, memoryBytes: 2048 * MiB, ...limits,
    readOnlyMounts: [{ source: r.deps, target: '/deps' }] }, runner);
  expect(await supervisor.probe(request(r.workspace), ['node', '--version'], 5000)).toBe('met');
  const run = calls[0]!;
  for (const flag of ['--network', 'none', '--read-only', '--cap-drop', 'ALL', 'no-new-privileges', '--user', '1000:1000', `type=bind,src=${r.deps},dst=/deps,readonly`, 'NODE_OPTIONS=--max-old-space-size=1536']) expect(run).toContain(flag);
  expect(run.join(' ')).not.toContain('/workspace'); expect(run.join(' ')).not.toContain('deckent-connection'); expect(run.join(' ')).not.toContain('deckent.request=');
  expect(run.slice(-2)).toEqual(['sha256:' + 'b'.repeat(64), '--version']); expect(run[run.indexOf('--entrypoint') + 1]).toBe('node');
  // The probe container is removed before the answer returns (it holds no evidence).
  expect(calls[1]).toEqual(['rm', '--force', run[run.indexOf('--name') + 1]]);
  exit = 127; expect(await supervisor.probe(request(r.workspace), ['missing-tool', '--version'], 5000)).toBe('unmet');
  exit = 1; expect(await supervisor.probe(request(r.workspace), ['node', '-e', 'process.exit(1)'], 5000)).toBe('unmet');
  exit = 125; await expect(supervisor.probe(request(r.workspace), ['node', '--version'], 5000)).rejects.toMatchObject({ code: 'SUPERVISOR_CONTROL_FAILED' });
});

it('coding probe kinds come from the registry; the declared requirement supplies whole argv elements only, an empty placeholder is unmet without a container', async () => {
  const seen: (readonly string[])[] = [];
  const probes = nativeCodingEnvironmentProbes(async argv => { seen.push(argv); return 'met'; });
  expect([...probes.keys()].sort()).toEqual(['executable', 'node-heap', 'path-readable']);
  expect(await probes.get('executable')!({ id: 'x', kind: 'executable', target: 'tsc; rm -rf /' })).toBe('met');
  expect(seen[0]).toEqual(['tsc; rm -rf /', '--version']);
  expect(await probes.get('node-heap')!({ id: 'heap', kind: 'node-heap', target: 'node' })).toBe('unmet'); expect(seen).toHaveLength(1);
  await expect(assertTaskEnvironment({ schemaVersion: 1, requirements: [{ id: 'x', kind: 'executable', target: 'node', argv: ['sh', '-c', 'id'] }] }, probes)).rejects.toBeTruthy();
});

it.skipIf(process.platform !== 'linux' || !dockerImage)('real Docker on the pinned image: tool present/absent, dependency path readable/absent, heap ceiling from node-heap.json, no probe container left', async () => {
  const r = await roots2();
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: r.workspaces, imageId: dockerImage!, uid: process.getuid!(), gid: process.getgid!(), memoryBytes: 2048 * MiB, ...limits,
    readOnlyMounts: [{ source: r.deps, target: '/deps' }] });
  const req = request(r.workspace), probes = nativeCodingEnvironmentProbes((argv, timeoutMs) => supervisor.probe(req, argv, timeoutMs));
  const check = (kind: string, target: string, expect?: string) => probes.get(kind)!({ id: kind, kind, target, ...(expect ? { expect } : {}) });
  expect(await check('executable', 'node')).toBe('met'); expect(await check('executable', 'deckent-missing-tool')).toBe('unmet');
  expect(await check('path-readable', '/deps/marker.txt')).toBe('met'); expect(await check('path-readable', '/deps/absent.txt')).toBe('unmet');
  // node-heap.json: 75 % of 2 GiB = 1536 MiB, so 1.5 GiB holds and 2 GiB does not.
  expect(await check('node-heap', 'node', String(1536 * MiB))).toBe('met'); expect(await check('node-heap', 'node', String(2048 * MiB))).toBe('unmet');
  // A probe that outlives its bound is killed and counts as unmet.
  expect(await supervisor.probe(req, ['node', '-e', 'setTimeout(() => {}, 60000)'], 1500)).toBe('unmet');
  const { handle } = await supervisor.inspectActivity(req);
  expect((await exec('/usr/bin/docker', ['ps', '-aq', '--filter', `name=${handle}-env-`])).stdout.trim()).toBe('');
}, 120_000);
