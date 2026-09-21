import { expect, it } from 'vitest';
import { compileNativeCodingDockerProfile, resolveDockerTaskProfile } from '#adapters/index.js';

const template = () => ({ id: 'coding', version: 1, adapter: { id: 'docker', version: 2 }, parameters: {
  argv: ['unused'], imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456,
  pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
  deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536,
} });
const invocation = (provider = 'codex') => ({ schemaVersion: 1, provider, permissionMode: 'unattended',
  model: 'configured-model', prompt: '--config dangerous=true; $(touch /outside)' });

it.each(['codex', 'claude', 'cursor'])('compiles %s into the existing pinned Docker execution contract without shell interpretation', provider => {
  const source = template();
  const result = compileNativeCodingDockerProfile(source, invocation(provider));
  const { argv, options } = resolveDockerTaskProfile(result);
  expect(argv.at(-2)).toBe('--');
  expect(argv.at(-1)).toBe(invocation().prompt);
  expect(argv[argv.indexOf('--model') + 1]).toBe('configured-model');
  expect(argv).not.toContain('ask');
  expect(options.imageId).toBe(source.parameters.imageId);
  expect(result.adapter).toEqual(source.adapter);
  expect(result.version).toBe(source.version);
  expect(source.parameters.argv).toEqual(['unused']);
  source.parameters.memoryBytes = 1;
  expect(options.memoryBytes).toBe(268435456);
});

it.each([
  { provider: 'unknown' }, { model: '-override' }, { model: '' }, { prompt: '\0' },
  { prompt: 'ü'.repeat(32769) }, { permissionMode: 'auto' }, { schemaVersion: 2 }, { secret: 'never-forward' },
])('rejects unsupported or unsafe invocation data without fallback: %j', change => {
  expect(() => compileNativeCodingDockerProfile(template(), { ...invocation(), ...change }))
    .toThrow('NATIVE_CODING_INVOCATION_INVALID');
});

it('rejects mutable image references and non-Docker templates', () => {
  const mutable = template(); mutable.parameters.imageId = 'latest';
  expect(() => compileNativeCodingDockerProfile(mutable, invocation())).toThrow('NATIVE_CODING_TEMPLATE_INVALID');
  const other = template(); other.adapter.id = 'process';
  expect(() => compileNativeCodingDockerProfile(other, invocation())).toThrow('NATIVE_CODING_TEMPLATE_INVALID');
});
