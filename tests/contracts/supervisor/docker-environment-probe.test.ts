import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { DockerSupervisor, DockerCommandFailure, nativeCodingEnvironmentProbes } from '#adapters/index.js';
import { assertTaskEnvironment, classifyLaunchRefusal } from '#engine/index.js';

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

/** A fake daemon with state: containers by id (name, labels), and switchable failures of `run` and `rm` (REVISE 2691 F1). */
function fakeDaemon() {
  const containers = new Map<string, { name: string; labels: Record<string, string> }>(), calls: (readonly string[])[] = [];
  const state = { exit: 0 as number | null, deadline: false, signal: false, rmFails: false, rmLeaves: false, inspectFails: false };
  const find = (ref: string) => [...containers.entries()].find(([id, value]) => id === ref || value.name === ref);
  const runner = async ({ args }: { args: readonly string[] }) => {
    const at = args[0] === '--host' ? 2 : 0, a = args.slice(at), ok = (stdout = '') => ({ stdout, stderr: '' });
    if (a[0] === 'context') return ok(JSON.stringify({ Host: 'unix:///var/run/docker.sock' }));
    calls.push(a);
    if (a[0] === 'inspect') {
      if (state.inspectFails) throw new DockerCommandFailure('', 'Cannot connect to the Docker daemon', 1, false);
      const hit = find(a.at(-1)!); if (!hit) throw new DockerCommandFailure('', 'Error: No such object: ' + a.at(-1), 1, false);
      return ok(hit[0]);
    }
    if (a[0] === 'run') {
      const name = a[a.indexOf('--name') + 1]!; if (find(name)) throw new DockerCommandFailure('', 'Conflict. The container name is already in use', 125, false);
      const labels = Object.fromEntries(a.flatMap((value, index) => a[index - 1] === '--label' ? [value.split('=') as [string, string]] : []));
      containers.set(randomUUID().replaceAll('-', '').padEnd(64, '0'), { name, labels });
      if (state.deadline) throw new DockerCommandFailure('', '', null, true, 'deadline');
      if (state.signal) throw new DockerCommandFailure('', '', null, true, 'signal', 'aborted');
      if (state.exit !== 0) throw new DockerCommandFailure('', '', state.exit, false);
      return ok();
    }
    if (a[0] === 'rm') { if (state.rmFails) throw new DockerCommandFailure('', 'daemon timeout', null, true, 'deadline'); const hit = find(a.at(-1)!); if (hit && !state.rmLeaves) containers.delete(hit[0]); return ok(a.at(-1)); }
    if (a[0] === 'ps') { const [key, value] = a[a.indexOf('--filter') + 1]!.slice('label='.length).split('='); return ok([...containers.entries()].filter(([, c]) => c.labels[key!] === value).map(([id]) => id).join('\n')); }
    throw new Error('unexpected Docker command ' + a[0]);
  };
  return { containers, calls, state, runner };
}
const supervisorOn = (r: Awaited<ReturnType<typeof roots2>>, runner: ReturnType<typeof fakeDaemon>['runner'], workspaceRoot = r.workspaces) => new DockerSupervisor({ executable: '/usr/bin/docker',
  workspaceRoot, imageId: 'sha256:' + 'b'.repeat(64), uid: 1000, gid: 1000, memoryBytes: 2048 * MiB, ...limits, readOnlyMounts: [{ source: r.deps, target: '/deps' }] }, runner);

it('runs a registry probe with the worker floor and without the workspace or the connection; exit codes map to met/unmet once the container is proven gone', async () => {
  const r = await roots2(), d = fakeDaemon(), supervisor = supervisorOn(r, d.runner);
  expect(await supervisor.probe(request(r.workspace), ['node', '--version'], 5000)).toBe('met');
  const run = d.calls.find(call => call[0] === 'run')!;
  for (const flag of ['--network', 'none', '--read-only', '--cap-drop', 'ALL', 'no-new-privileges', '--user', '1000:1000', `type=bind,src=${r.deps},dst=/deps,readonly`, 'NODE_OPTIONS=--max-old-space-size=1536']) expect(run).toContain(flag);
  expect(run.join(' ')).not.toContain('/workspace'); expect(run.join(' ')).not.toContain('deckent-connection'); expect(run.join(' ')).not.toContain('deckent.request=');
  expect(run.slice(-2)).toEqual(['sha256:' + 'b'.repeat(64), '--version']); expect(run[run.indexOf('--entrypoint') + 1]).toBe('node');
  // After the answer: removed and observed absent before it returns.
  const name = run[run.indexOf('--name') + 1]!, after = d.calls.slice(d.calls.indexOf(run) + 1);
  expect(after).toEqual([['rm', '--force', name], ['inspect', '--format', '{{.Id}}', name]]); expect(d.containers.size).toBe(0);
  d.state.exit = 127; expect(await supervisor.probe(request(r.workspace), ['missing-tool', '--version'], 5000)).toBe('unmet');
  d.state.exit = 1; expect(await supervisor.probe(request(r.workspace), ['node', '-e', 'process.exit(1)'], 5000)).toBe('unmet');
  // E1 (Jev 8e791e09): a probe its deadline stopped gave no answer; with its container proven gone it is `timed-out`, never `unmet`.
  d.state.exit = 0; d.state.deadline = true; expect(await supervisor.probe(request(r.workspace), ['node', '--version'], 5000)).toBe('timed-out'); expect(d.containers.size).toBe(0);
  // A caller's abort is not the probe's own deadline: it stays a control failure.
  d.state.deadline = false; d.state.signal = true; await expect(supervisor.probe(request(r.workspace), ['node', '--version'], 5000)).rejects.toMatchObject({ code: 'SUPERVISOR_CONTROL_FAILED' }); expect(d.containers.size).toBe(0);
  d.state.signal = false; d.state.exit = 125; await expect(supervisor.probe(request(r.workspace), ['node', '--version'], 5000)).rejects.toMatchObject({ code: 'SUPERVISOR_CONTROL_FAILED' });
});

it('REVISE 2691: cleanup that cannot be proven is uncertain, never met/unmet: deadline + rm error, met + rm error, rm that leaves it, unknown inspect', async () => {
  const r = await roots2();
  for (const failure of [{ deadline: true, rmFails: true }, { rmFails: true }, { exit: 1, rmLeaves: true }, { inspectFails: true }]) {
    const d = fakeDaemon(); Object.assign(d.state, failure);
    const outcome = await supervisorOn(r, d.runner).probe(request(r.workspace), ['node', '--version'], 5000);
    const name = d.calls.find(call => call[0] === 'run')?.[d.calls.find(call => call[0] === 'run')!.indexOf('--name') + 1];
    expect(outcome).toEqual({ uncertain: name ?? expect.any(String) });
  }
});

it('REVISE 2691: the probe identity is deterministic per installation, Run, task and probe (not per attempt), so a re-entry never starts a duplicate while one may live', async () => {
  const r = await roots2(), d = fakeDaemon(), supervisor = supervisorOn(r, d.runner);
  const first = request(r.workspace), second = { ...first, identity: { ...first.identity, attemptId: randomUUID(), generation: 2 } };
  const a = supervisor.probeIdentity(first, ['node', '--version']), b = supervisor.probeIdentity(second, ['node', '--version']);
  expect(a).toEqual(b); expect(a.name).toMatch(/^deckent-env-[a-f0-9]{64}$/);
  expect(supervisor.probeIdentity({ ...first, identity: { ...first.identity, taskId: 'other' } }, ['node', '--version']).name).not.toBe(a.name);
  expect(supervisor.probeIdentity(first, ['tsc', '--version']).name).not.toBe(a.name);
  expect(supervisorOn(r, d.runner, join(r.workspaces, '..', 'deps')).probeIdentity(first, ['node', '--version'])).not.toEqual(a);
  // A crashed controller left the probe running: the re-entry removes it (proven) before its own run.
  d.containers.set('f'.repeat(64), { name: a.name, labels: { 'deckent.preflight': 'left', 'deckent.preflight.root': a.root } });
  expect(await supervisor.probe(second, ['node', '--version'], 5000)).toBe('met');
  expect(d.calls.map(call => call[0])).toEqual(['inspect', 'rm', 'inspect', 'run', 'rm', 'inspect']); expect(d.containers.size).toBe(0);
  // If that leftover cannot be removed, the answer is uncertain and no second container is started.
  d.calls.length = 0; d.containers.set('e'.repeat(64), { name: a.name, labels: { 'deckent.preflight': 'left', 'deckent.preflight.root': a.root } }); d.state.rmFails = true;
  expect(await supervisor.probe(second, ['node', '--version'], 5000)).toEqual({ uncertain: a.name });
  expect(d.calls.some(call => call[0] === 'run')).toBe(false); expect(d.containers.size).toBe(1);
});

it('REVISE 2691: the startup sweep removes only this installation’s labelled probe containers and reports any it cannot prove gone', async () => {
  const r = await roots2(), d = fakeDaemon(), supervisor = supervisorOn(r, d.runner), { root } = supervisor.probeIdentity(request(r.workspace), ['node', '--version']);
  d.containers.set('a'.repeat(64), { name: 'deckent-env-ours', labels: { 'deckent.preflight': 'x', 'deckent.preflight.root': root } });
  d.containers.set('b'.repeat(64), { name: 'deckent-env-foreign', labels: { 'deckent.preflight': 'y', 'deckent.preflight.root': 'f'.repeat(64) } });
  d.containers.set('c'.repeat(64), { name: 'unrelated', labels: {} });
  expect(await supervisor.releasePreflightProbes()).toEqual({ removed: 1, unsettled: [] });
  expect([...d.containers.values()].map(c => c.name).sort()).toEqual(['deckent-env-foreign', 'unrelated']);
  d.containers.set('d'.repeat(64), { name: 'deckent-env-stuck', labels: { 'deckent.preflight': 'x', 'deckent.preflight.root': root } }); d.state.rmFails = true;
  expect(await supervisor.releasePreflightProbes()).toEqual({ removed: 0, unsettled: ['d'.repeat(64)] });
});

it('E1: a timed-out probe refuses the launch as EXECUTION_ENVIRONMENT_TIMED_OUT naming the requirement; it is a hold, not an installation-defect park', async () => {
  const probes = new Map([['executable', async () => 'met' as const], ['path-readable', async () => 'timed-out' as const]]);
  const failure = await assertTaskEnvironment({ schemaVersion: 1, requirements: [{ id: 'node', kind: 'executable', target: 'node' }, { id: 'marker', kind: 'path-readable', target: '/deps/marker.txt' }] }, probes).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: 'EXECUTION_ENVIRONMENT_TIMED_OUT', params: { requirement: 'marker', kind: 'path-readable' } });
  expect(classifyLaunchRefusal(failure)).toEqual({ disposition: 'held', code: 'EXECUTION_ENVIRONMENT_TIMED_OUT', requirement: 'marker' });
  // An unmet answer stays the permanent environment refusal (the Run parks before any worker).
  const unmet = await assertTaskEnvironment({ schemaVersion: 1, requirements: [{ id: 'node', kind: 'executable', target: 'node' }] }, new Map([['executable', async () => 'unmet' as const]])).catch((error: unknown) => error);
  expect(classifyLaunchRefusal(unmet)).toEqual({ disposition: 'permanent', code: 'EXECUTION_ENVIRONMENT_NOT_READY', requirement: 'node' });
  // A held refusal without its requirement is not recordable as one: it stays transient.
  expect(classifyLaunchRefusal({ code: 'EXECUTION_ENVIRONMENT_TIMED_OUT', params: {} })).toEqual({ disposition: 'transient' });
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
  // A probe that outlives its bound is killed and removed; it gave no answer, so it is `timed-out`, never `unmet` (E1).
  expect(await supervisor.probe(req, ['node', '-e', 'setTimeout(() => {}, 60000)'], 1500)).toBe('timed-out');
  const { root } = supervisor.probeIdentity(req, ['node', '--version']);
  expect((await exec('/usr/bin/docker', ['ps', '-aq', '--filter', `label=deckent.preflight.root=${root}`])).stdout.trim()).toBe('');
}, 120_000);

it.skipIf(process.platform !== 'linux' || !dockerImage)('REVISE 2691, real Docker: a probe left running by a crashed controller is removed on re-entry; the sweep never touches a foreign or unlabelled container', async () => {
  const r = await roots2(), docker = (...args: string[]) => exec('/usr/bin/docker', args).then(out => out.stdout.trim());
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: r.workspaces, imageId: dockerImage!, uid: process.getuid!(), gid: process.getgid!(), memoryBytes: 512 * MiB, ...limits });
  const req = request(r.workspace), argv = ['node', '--version'], { name, root } = supervisor.probeIdentity(req, argv), tag = randomUUID();
  // The crashed controller's probe: same deterministic name and labels, still running.
  await docker('run', '-d', '--name', name, '--label', 'deckent.preflight=crashed', '--label', `deckent.preflight.root=${root}`, '--network', 'none', '--entrypoint', 'node', dockerImage!, '-e', 'setTimeout(() => {}, 120000)');
  const foreign = await docker('run', '-d', '--label', 'deckent.preflight=other', '--label', `deckent.preflight.root=${'f'.repeat(64)}`, '--label', `deckent.test=${tag}`, '--network', 'none', '--entrypoint', 'node', dockerImage!, '-e', 'setTimeout(() => {}, 120000)');
  const unlabelled = await docker('run', '-d', '--label', `deckent.test=${tag}`, '--network', 'none', '--entrypoint', 'node', dockerImage!, '-e', 'setTimeout(() => {}, 120000)');
  try {
    expect(await supervisor.probe({ ...req, identity: { ...req.identity, attemptId: randomUUID(), generation: 2 } }, argv, 30000)).toBe('met');
    expect(await docker('ps', '-aq', '--filter', `name=${name}`)).toBe('');
    await docker('run', '-d', '--name', name, '--label', 'deckent.preflight=crashed', '--label', `deckent.preflight.root=${root}`, '--network', 'none', '--entrypoint', 'node', dockerImage!, '-e', 'setTimeout(() => {}, 120000)');
    expect(await supervisor.releasePreflightProbes()).toEqual({ removed: 1, unsettled: [] });
    expect(await docker('ps', '-aq', '--filter', `label=deckent.preflight.root=${root}`)).toBe('');
    expect((await docker('ps', '-q', '--no-trunc', '--filter', `label=deckent.test=${tag}`)).split('\n').sort()).toEqual([foreign, unlabelled].sort());
  } finally { await docker('rm', '--force', foreign, unlabelled).catch(() => ''); await docker('rm', '--force', name).catch(() => ''); }
}, 120_000);
