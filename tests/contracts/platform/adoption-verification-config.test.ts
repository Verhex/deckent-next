import { expect, it } from 'vitest';
import { ZodError } from 'zod';
import { CORE_SCHEMA } from '#platform/index.js';

const execution = (adoption: unknown) => ({ docker: { executable: '/usr/bin/docker', imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 1, pids: 1, cpus: 1,
  logMaxSizeKiB: 1, logMaxFiles: 1, tmpBytes: 1, deadlineMs: 1, controlTimeoutMs: 1, outputBytes: 1 }, git: { gitExecutable: 'git', timeoutMs: 1 }, adoption });
const requirement = { kind: 'verify', required: true, criteria: [{ evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
const parse = (adoption: unknown) => CORE_SCHEMA.shape.execution.parse(execution(adoption));

it('adds the adoption verification requirement as optional data within config schema 3 (absent = none)', () => {
  expect(parse({ targets: [] })?.adoption.verification).toBeNull();
  expect(parse(undefined)?.adoption).toEqual({ targets: [], verification: null });
  expect(parse({ targets: ['refs/heads/dogfood/adopted'], verification: requirement })?.adoption.verification).toEqual(requirement);
});

it.each([
  ['a missing kind', { required: true, criteria: requirement.criteria }],
  ['an implicit required flag', { kind: 'verify', criteria: requirement.criteria }],
  ['no bar (empty criteria)', { ...requirement, criteria: [] }],
  ['a criterion without evaluator', { ...requirement, criteria: [{ parameters: {} }] }],
  ['an unknown field', { ...requirement, autoSelect: true }],
] as const)('rejects %s', (_name, verification) => {
  expect(() => parse({ targets: [], verification })).toThrow(ZodError);
});
