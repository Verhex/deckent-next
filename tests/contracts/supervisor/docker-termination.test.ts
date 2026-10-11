import { expect, it } from 'vitest';
import { DockerSupervisor, identifyDockerRequest } from '#adapters/index.js';
const options = { executable: '/usr/bin/docker', workspaceRoot: '/fixture', imageId: 'sha256:' + 'b'.repeat(64), uid: 1000, gid: 1000,
  memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 };
const request = { protocolVersion: 1 as const, identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 }, workspace: '/fixture/task', argv: ['fixture'] };
const worker = { kind: 'container' as const, id: 'a'.repeat(64), startedAt: '2026-10-11T01:00:00.000000001Z' };
function fixture(state: string, change: Record<string, unknown> = {}) {
  const calls: string[][] = [], { digest } = identifyDockerRequest(request, options);
  const supervisor = new DockerSupervisor(options, async command => {
    calls.push([...command.args]);
    if (command.args[0] === 'context') return { stdout: JSON.stringify({ Host: 'unix:///fixture/docker.sock' }), stderr: '' };
    expect(command.args.slice(0, 3)).toEqual(['--host', 'unix:///fixture/docker.sock', 'inspect']);
    if (state === 'absent') throw { stderr: 'Error: No such object: ' + command.args[3] };
    if (state === 'denied') throw { stderr: 'permission denied' };
    return { stdout: JSON.stringify([{ Id: worker.id, Image: options.imageId, Config: { Labels: { 'deckent.request': digest } },
      State: { Status: state, StartedAt: worker.startedAt, FinishedAt: '2026-10-11T01:01:00Z', ExitCode: 1 }, ...change }]), stderr: '' };
  });
  return { supervisor, calls };
}
it.each(['exited', 'absent'])('certifies %s only by the exact retained container id', async state => {
  const f = fixture(state), observed = await f.supervisor.observeTermination(request, worker);
  expect(observed).toMatchObject({ kind: state === 'exited' ? 'supervisor-exit' : 'worker-absent', worker });
  expect(f.calls.at(-1)?.at(-1)).toBe(worker.id);
  expect(f.calls.flat()).not.toContain('start'); expect(f.calls.flat()).not.toContain('kill'); expect(f.calls.flat()).not.toContain('rm');
});
it.each(['running', 'paused', 'created'])('keeps %s custody held', async state => {
  expect(await fixture(state).supervisor.observeTermination(request, worker)).toBeNull();
});
it.each(['id', 'startedAt', 'label'])('rejects a foreign %s instead of certifying termination', async field => {
  const changed = field === 'id' ? { Id: 'c'.repeat(64) } : field === 'label' ? { Config: { Labels: { 'deckent.request': 'foreign' } } }
    : { State: { Status: 'exited', ExitCode: 1, StartedAt: '2026-10-11T02:00:00Z' } };
  await expect(fixture('exited', changed).supervisor.observeTermination(request, worker)).rejects.toMatchObject({ code: 'SUPERVISOR_IDENTITY_CONFLICT' });
});
it('daemon permission failure stays unknown, and a process PID is not Docker incarnation evidence', async () => {
  await expect(fixture('denied').supervisor.observeTermination(request, worker)).rejects.toMatchObject({ code: 'SUPERVISOR_CONTROL_FAILED' });
  await expect(fixture('exited').supervisor.observeTermination(request, { kind: 'process', pid: 1, startedAt: worker.startedAt })).rejects.toThrow();
});
it('read-only running observation carries immutable id and birth time for durable dispatch retention', async () => {
  const observed = await fixture('running').supervisor.observe(request);
  expect(observed.worker).toEqual(worker); expect(observed.result.kind).toBe('unknown');
});
