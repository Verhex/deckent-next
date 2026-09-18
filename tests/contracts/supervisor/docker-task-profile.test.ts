import { expect, it } from 'vitest';
import { validateDockerTaskProfile } from '#adapters/index.js';

const parameters = () => ({
  argv: ['node', 'task.js'], imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456,
  pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
  deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536,
});
const profile = () => ({ id: 'bounded-node', version: 1, adapter: { id: 'docker', version: 2 }, parameters: parameters() });

it('accepts an installed Docker task template without reading runtime configuration or contacting Docker', () => {
  expect(validateDockerTaskProfile(profile())).toBeUndefined();
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
