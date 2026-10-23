import { expect, it } from 'vitest';
import { decideDispatchLoss, type AttemptIdentity, type DispatchLossRecord, type DispatchTerminationProof, type WorkerIncarnation } from '#domain/index.js';
import { DockerCommandFailure, DockerSupervisor, identifyDockerRequest, type DockerCommandRunner } from '#adapters/index.js';

// S6R-3 (lead note on s6r1 Q2): a launcher that died after `create` and before the first running observation leaves only the created
// container id (S6R-1). The termination variant binds to that exact id and only proves absence; it never loosens the incarnation rule.
const identity: AttemptIdentity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 };
const containerId = 'c'.repeat(64), other = 'd'.repeat(64);
const fence = { identity, owner: 'owner-a', receiptId: 'fence-receipt' };
const record: DispatchLossRecord = { identity, owner: 'owner-a', launch: 'granted', lost: true, worker: null, containerId };
const proof: DispatchTerminationProof = { kind: 'created-container-absent', identity, owner: 'owner-a', receiptId: 'release-receipt', containerId };
const hold = (reason: string) => ({ kind: 'hold-manual', reason });

it('releases a fenced dispatch with no incarnation only on the proven absence of its own created container id', () => {
  expect(decideDispatchLoss(record, fence, proof, 'release-slot')).toEqual({ kind: 'release', fenceReceiptId: 'fence-receipt', terminationReceiptId: 'release-receipt' });
  expect(decideDispatchLoss(record, fence, { ...proof, containerId: other }, 'release-slot')).toEqual(hold('termination-mismatch'));
  expect(decideDispatchLoss({ ...record, containerId: null }, fence, proof, 'release-slot')).toEqual(hold('termination-mismatch'));
  expect(decideDispatchLoss({ ...record, containerId: undefined }, fence, proof, 'release-slot')).toEqual(hold('termination-mismatch'));
  expect(decideDispatchLoss(record, fence, { ...proof, owner: 'other' }, 'release-slot')).toEqual(hold('termination-mismatch'));
  expect(decideDispatchLoss(record, fence, { ...proof, identity: { ...identity, generation: 2 } }, 'release-slot')).toEqual(hold('termination-mismatch'));
  expect(decideDispatchLoss(record, fence, { ...proof, receiptId: '' }, 'release-slot')).toEqual(hold('termination-mismatch'));
  expect(decideDispatchLoss(record, null, proof, 'release-slot')).toEqual(hold('fence-required'));
  expect(decideDispatchLoss(record, fence, proof, 'result')).toEqual({ kind: 'reject-late-write', code: 'DISPATCH_FENCED' });
});

it('never lets the created-id variant stand in for a retained incarnation (the stricter rule wins once a worker started)', () => {
  const worker: WorkerIncarnation = { kind: 'container', id: containerId, startedAt: '2026-10-23T10:00:00Z' };
  expect(decideDispatchLoss({ ...record, worker }, fence, proof, 'release-slot')).toEqual(hold('termination-mismatch'));
  const absent: DispatchTerminationProof = { kind: 'worker-absent', identity, owner: 'owner-a', receiptId: 'release-receipt', worker };
  expect(decideDispatchLoss({ ...record, worker }, fence, absent, 'release-slot').kind).toBe('release');
  expect(decideDispatchLoss(record, fence, absent, 'release-slot')).toEqual(hold('termination-mismatch'));
});

it('the Docker supervisor proves absence by the exact created id only on Docker\'s explicit missing-object answer', async () => {
  const request = { protocolVersion: 1 as const, identity, workspace: '/tmp/w', argv: ['node'] };
  const docker = { executable: '/usr/bin/docker', workspaceRoot: '/tmp', imageId: 'sha256:' + 'a'.repeat(64), uid: 1, gid: 1, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 1000, outputBytes: 65536 };
  const { digest } = identifyDockerRequest(request, docker), inspected: string[] = [];
  const answer = (state: 'missing' | 'created' | 'daemon' | 'foreign'): DockerCommandRunner => async command => {
    const args = command.args[0] === '--host' ? command.args.slice(2) : command.args;
    if (args[0] === 'context') return { stdout: JSON.stringify({ Host: 'unix:///fixture.sock' }), stderr: '' };
    if (args[0] !== 'inspect') throw new Error('unexpected ' + args[0]);
    inspected.push(args[1]!);
    if (state === 'missing') throw new DockerCommandFailure('', 'Error: No such object: ' + args[1], 1, false);
    if (state === 'daemon') throw new DockerCommandFailure('', 'Cannot connect to the Docker daemon', 1, false);
    return { stdout: JSON.stringify([{ Id: containerId, Config: { Labels: { 'deckent.request': state === 'foreign' ? 'x' : digest } }, State: { Status: 'created', StartedAt: '0001-01-01T00:00:00Z' } }]), stderr: '' };
  };
  expect(await new DockerSupervisor(docker, answer('missing')).observeCreatedAbsence(request, containerId)).toEqual({ kind: 'created-container-absent', containerId });
  expect(inspected).toEqual([containerId]);
  expect(await new DockerSupervisor(docker, answer('created')).observeCreatedAbsence(request, containerId)).toBeNull();
  await expect(new DockerSupervisor(docker, answer('daemon')).observeCreatedAbsence(request, containerId)).rejects.toMatchObject({ code: 'SUPERVISOR_CONTROL_FAILED' });
  await expect(new DockerSupervisor(docker, answer('foreign')).observeCreatedAbsence(request, containerId)).rejects.toMatchObject({ code: 'SUPERVISOR_IDENTITY_CONFLICT' });
  await expect(new DockerSupervisor(docker, answer('missing')).observeCreatedAbsence(request, 'not-an-id')).rejects.toThrow();
});

it('a Docker exit observed for the retained incarnation is a termination proof the loss decision accepts (strict exit cause, no adapter fields)', async () => {
  const request = { protocolVersion: 1 as const, identity, workspace: '/tmp/w', argv: ['node'] };
  const docker = { executable: '/usr/bin/docker', workspaceRoot: '/tmp', imageId: 'sha256:' + 'a'.repeat(64), uid: 1, gid: 1, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 1000, outputBytes: 65536 };
  const worker: WorkerIncarnation = { kind: 'container', id: containerId, startedAt: '2026-10-23T10:00:00.000000001Z' }, { digest } = identifyDockerRequest(request, docker);
  const supervisor = new DockerSupervisor(docker, async command => command.args[0] === 'context' ? { stdout: JSON.stringify({ Host: 'unix:///fixture.sock' }), stderr: '' }
    : { stdout: JSON.stringify([{ Id: containerId, Config: { Labels: { 'deckent.request': digest } }, State: { Status: 'exited', ExitCode: 137, StartedAt: worker.startedAt } }]), stderr: '' });
  const observed = (await supervisor.observeTermination(request, worker))!;
  expect(observed).toEqual({ kind: 'supervisor-exit', worker, result: { exitCode: 137 } });
  expect(decideDispatchLoss({ ...record, containerId, worker }, fence, { ...observed, identity, owner: 'owner-a', receiptId: 'release-receipt' }, 'release-slot').kind).toBe('release');
});
