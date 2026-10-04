import { describe, expect, it } from 'vitest';
import { assertNativeWorkerBinding, compileNativeCodingDockerProfile } from '#adapters/core/native-coding/index.js';
const template = { id: 'coding', version: 1, adapter: { id: 'docker', version: 2 }, parameters: {
  argv: ['unused'], imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1,
  logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536,
} };
const invocation = (provider: string, modelId = 'exact-model') => ({ schemaVersion: 4, provider, cliVersion: 'fixture-1',
  discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended',
  model: { channelId: 'fixture', modelId, auxiliaryModelIds: [] }, prompt: 'Task', effort: 'high' });
describe('WORKER-EFFORT native argv', () => {
  it.each([['claude', ['--effort', 'high']], ['codex', ['-c', 'model_reasoning_effort=high']]])('compiles %s effort and seals it in the profile', (provider, segment) => {
    const profile = compileNativeCodingDockerProfile(template, invocation(provider));
    expect(profile.parameters.argv).toEqual(expect.arrayContaining(segment));
    expect(profile.parameters.nativeSubscription).toMatchObject({ reasoningEffort: { level: 'high', source: 'explicit', status: 'selected' } });
    expect(() => assertNativeWorkerBinding(profile)).not.toThrow();
    const argv = [...profile.parameters.argv as string[]]; argv[argv.indexOf(segment[1]!)] = 'low';
    expect(() => assertNativeWorkerBinding({ ...profile, parameters: { ...profile.parameters, argv } })).toThrow('WORKER_MODEL_BINDING_MISMATCH');
  });
  it('keeps Cursor exact effort variant unchanged, without invented bracket or suffix mapping', () => {
    const profile = compileNativeCodingDockerProfile(template, invocation('cursor', 'grok-4.7-high'));
    expect(profile.parameters.argv).toEqual(expect.arrayContaining(['--model', 'grok-4.7-high']));
    expect(profile.parameters.argv).not.toContain('--effort');
    expect(profile.parameters.nativeSubscription).toMatchObject({ reasoningEffort: { level: 'high', source: 'explicit' } });
  });
});
