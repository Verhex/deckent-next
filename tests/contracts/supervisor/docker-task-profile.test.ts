import { expect, it } from 'vitest';
import { compileNativeCodingDockerProfile, dockerTaskHiddenPaths, resolveDockerTaskProfile, validateDockerTaskProfile } from '#adapters/index.js';

const parameters = () => ({
  argv: ['node', 'task.js'], imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456,
  pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
  deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536,
});
const profile = () => ({ id: 'bounded-node', version: 1, adapter: { id: 'docker', version: 2 }, parameters: parameters() });

it('accepts an installed Docker task template without reading runtime configuration or contacting Docker', () => {
  expect(validateDockerTaskProfile(profile())).toBeUndefined();
});

it('resolves only pinned argv and Docker options, independent of later source mutation', () => {
  const source = profile(); const resolved = resolveDockerTaskProfile(source);
  const { argv, ...options } = parameters();
  expect(resolved).toEqual({ argv, options });
  source.parameters.argv[0] = 'changed'; source.parameters.memoryBytes = 1;
  expect(resolved).toEqual({ argv, options });
  expect(resolved).not.toHaveProperty('executable'); expect(resolved).not.toHaveProperty('workspaceRoot');
  expect(resolved.options).not.toHaveProperty('uid'); expect(resolved.options).not.toHaveProperty('gid');
});

it('rejects a non-Docker adapter during resolution', () => {
  const value = profile(); value.adapter.id = 'process';
  expect(() => resolveDockerTaskProfile(value)).toThrow('DOCKER_TASK_PROFILE_INVALID');
});

it.each([
  ['adapter id', value => { value.adapter.id = 'process'; }],
  ['adapter version', value => { value.adapter.version = 1; }],
  ['empty argv', value => { value.parameters.argv = []; }],
  ['unbounded image', value => { value.parameters.imageId = 'latest'; }],
  ['invalid limit', value => { value.parameters.memoryBytes = 0; }],
] as const)('rejects an invalid %s', (_name, change) => {
  const value = profile(); change(value);
  expect(() => validateDockerTaskProfile(value)).toThrow('DOCKER_TASK_PROFILE_INVALID');
});

it.each(['executable', 'workspaceRoot', 'uid', 'gid', 'secret'])('strictly rejects host or unknown parameter %s', field => {
  const value = profile(); Object.assign(value.parameters, { [field]: field === 'uid' || field === 'gid' ? 1000 : '/host/value' });
  expect(() => validateDockerTaskProfile(value)).toThrow('DOCKER_TASK_PROFILE_INVALID');
});

it('accepts a local billing declaration and keeps it out of the Docker options; refuses it with a subscription binding or any other value', () => {
  const value = profile(), local = { ...value, parameters: { ...value.parameters, billingAxis: 'local' } };
  expect(validateDockerTaskProfile(local)).toBeUndefined();
  expect(resolveDockerTaskProfile(local).options).not.toHaveProperty('billingAxis');
  for (const billingAxis of ['metered', 'subscription', null]) expect(() => validateDockerTaskProfile({ ...value, parameters: { ...value.parameters, billingAxis } })).toThrow('DOCKER_TASK_PROFILE_INVALID');
  expect(() => validateDockerTaskProfile({ ...local, parameters: { ...local.parameters, nativeSubscription: { schemaVersion: 1, provider: 'claude' } } })).toThrow('DOCKER_TASK_PROFILE_INVALID');
});

it('siwcWorker v1 is strict and only rides a pinned, prompt-delivered worker of the CLI that embeds the app-server (U9-7)', () => {
  const invocation = { schemaVersion: 4, provider: 'codex', cliVersion: 'codex-cli 0.164.0', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended',
    model: { channelId: 'c', modelId: 'm', auxiliaryModelIds: [] }, composition: { schemaVersion: 1, task: 'Edit note.txt', scope: 'note.txt', acceptance: 'Zero exit' } };
  const pinned = compileNativeCodingDockerProfile({ ...profile(), parameters: { ...parameters(), argv: ['unused'] } }, invocation);
  const worker = { schemaVersion: 1, connectionId: '00000000-0000-4000-8000-000000000001', owner: { issuer: 'local', subject: 'person' }, hiddenPaths: ['AGENTS.md'] };
  const relay = (parameters: Record<string, unknown>, siwcWorker: unknown = worker) => ({ ...pinned, parameters: { ...parameters, siwcWorker } });
  expect(resolveDockerTaskProfile(relay(pinned.parameters)).siwcWorker).toEqual(worker);
  expect(dockerTaskHiddenPaths(relay(pinned.parameters))).toEqual(['AGENTS.md']);
  for (const value of [{ ...worker, schemaVersion: 2 }, { ...worker, token: 'x' }, { ...worker, connectionId: 'not-a-uuid' }, { ...worker, hiddenPaths: undefined }])
    expect(() => validateDockerTaskProfile(relay(pinned.parameters, value))).toThrow('DOCKER_TASK_PROFILE_INVALID');
  // No native pin / prompt delivery (a plain task, an inline-prompt CLI run) or another CLI: the relay route is refused, not reinterpreted.
  const inline = compileNativeCodingDockerProfile({ ...profile(), parameters: { ...parameters(), argv: ['unused'] } }, { ...invocation, composition: undefined, prompt: 'Edit note.txt.' });
  const other = compileNativeCodingDockerProfile({ ...profile(), parameters: { ...parameters(), argv: ['unused'] } }, { ...invocation, provider: 'claude', cliVersion: '2.1.293 (Claude Code)' });
  for (const value of [relay(parameters()), relay(inline.parameters), relay(other.parameters)]) expect(() => validateDockerTaskProfile(value)).toThrow('DOCKER_TASK_PROFILE_INVALID');
});
