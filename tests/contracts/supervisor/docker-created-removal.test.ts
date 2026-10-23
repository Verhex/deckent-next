import { expect, it } from 'vitest';
import { DockerCommandFailure, DockerSupervisor, identifyDockerRequest, type DockerCommandRunner } from '#adapters/index.js';

// S6R-4 (lead on s6r3 Q3): a launcher that died after `docker create` and before `start` leaves a never-started container that no stop can end, so
// its slot could never be released. The recovery stop removes exactly that container — by the created id S6R-1 recorded, only while Docker reports
// it `created` under this request's label, never forced — and only a later inspect that answers "no such object" counts as removed.
const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 };
const request = { protocolVersion: 1 as const, identity, workspace: '/tmp/w', argv: ['node'] };
const docker = { executable: '/usr/bin/docker', workspaceRoot: '/tmp', imageId: 'sha256:' + 'a'.repeat(64), uid: 1, gid: 1, memoryBytes: 268435456, pids: 64, cpus: 1,
  logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 1000, outputBytes: 65536 };
const containerId = 'c'.repeat(64), { digest } = identifyDockerRequest(request, docker);

function daemon(state: { status: 'created' | 'running' | 'exited' | 'missing'; label?: string; rmFails?: boolean }) {
  const calls: string[][] = [];
  const runner: DockerCommandRunner = async command => {
    const args = command.args[0] === '--host' ? command.args.slice(2) : command.args;
    if (args[0] === 'context') return { stdout: JSON.stringify({ Host: 'unix:///fixture.sock' }), stderr: '' };
    calls.push([...args]);
    if (args[0] === 'rm') {
      if (state.rmFails || state.status !== 'created') throw new DockerCommandFailure('', 'Error: cannot remove', 1, false);
      state.status = 'missing'; return { stdout: args[1]!, stderr: '' };
    }
    if (args[0] !== 'inspect') throw new Error('unexpected ' + args[0]);
    if (state.status === 'missing' || args[1] !== containerId) throw new DockerCommandFailure('', 'Error: No such object: ' + args[1], 1, false);
    return { stdout: JSON.stringify([{ Id: containerId, Config: { Labels: { 'deckent.request': state.label ?? digest } }, State: { Status: state.status, StartedAt: '0001-01-01T00:00:00Z' } }]), stderr: '' };
  };
  return { calls, supervisor: new DockerSupervisor(docker, runner) };
}

it('removes a created container by its exact id (plain rm, no force) and proves it absent', async () => {
  const d = daemon({ status: 'created' });
  expect(await d.supervisor.removeCreatedContainer(request, containerId)).toBe('removed');
  expect(d.calls).toEqual([['inspect', containerId], ['rm', containerId], ['inspect', containerId]]);
});

it('never touches a started, exited or foreign container; an absent one is already absent', async () => {
  for (const status of ['running', 'exited'] as const) {
    const d = daemon({ status }); expect(await d.supervisor.removeCreatedContainer(request, containerId)).toBe('not-created');
    expect(d.calls.some(call => call[0] === 'rm')).toBe(false);
  }
  const foreign = daemon({ status: 'created', label: 'other' });
  await expect(foreign.supervisor.removeCreatedContainer(request, containerId)).rejects.toMatchObject({ code: 'SUPERVISOR_IDENTITY_CONFLICT' });
  expect(foreign.calls.some(call => call[0] === 'rm')).toBe(false);
  const gone = daemon({ status: 'missing' }); expect(await gone.supervisor.removeCreatedContainer(request, containerId)).toBe('absent');
  await expect(daemon({ status: 'created' }).supervisor.removeCreatedContainer(request, 'not-an-id')).rejects.toMatchObject({ code: 'SUPERVISOR_REQUEST_INVALID' });
});

it('a removal Docker does not confirm is not a removal', async () => {
  const d = daemon({ status: 'created', rmFails: true });
  await expect(d.supervisor.removeCreatedContainer(request, containerId)).rejects.toMatchObject({ code: 'SUPERVISOR_RELEASE_UNCONFIRMED' });
});
