import { expect, it } from 'vitest';
import { DispatchError, parseRetainedOutputEnvelope, verifyRetainedOutputEnvelope } from '#engine/core/dispatch/index.js';

const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'layout' };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const envelope = { schemaVersion: 1, identity, completeness: 'partial', stdout: 'out', stderr: '' };

it.each(['complete', 'partial', 'unavailable'] as const)('reports %s honestly while acceptance still requires complete evidence', completeness => {
  const bytes = encode({ ...envelope, completeness });
  expect(parseRetainedOutputEnvelope(bytes, identity).completeness).toBe(completeness);
  if (completeness === 'complete') expect(verifyRetainedOutputEnvelope(bytes, identity).stdout).toBe('out');
  else expect(() => verifyRetainedOutputEnvelope(bytes, identity)).toThrow(DispatchError);
});

it('rejects malformed, extra-field and foreign-identity evidence before exposing recovered output', () => {
  for (const bytes of [new Uint8Array([255]), encode({ ...envelope, extra: true }),
    encode({ ...envelope, identity: { ...identity, scopeId: 'foreign' } }), encode({ ...envelope, completeness: 'invented' })]) {
    expect(() => parseRetainedOutputEnvelope(bytes, identity)).toThrow(DispatchError);
  }
});
