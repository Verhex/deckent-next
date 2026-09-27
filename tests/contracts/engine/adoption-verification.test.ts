import { expect, it } from 'vitest';
import { adoptionVerificationPhaseOutcome, executionProfileFingerprint, integrationAdoptionCommandSchema } from '#engine/index.js';

it('maps every verification task phase to one outcome (design §5.4): only accepted verifies', () => {
  expect({
    accepted: adoptionVerificationPhaseOutcome('accepted'),
    failed: adoptionVerificationPhaseOutcome('failed'),
    pending: adoptionVerificationPhaseOutcome('pending'),
    active: adoptionVerificationPhaseOutcome('active'),
    evaluating: adoptionVerificationPhaseOutcome('evaluating'),
    reconciling: adoptionVerificationPhaseOutcome('reconciling'),
    cancelled: adoptionVerificationPhaseOutcome('cancelled'),
  }).toEqual({ accepted: null, failed: 'ADOPTION_VERIFICATION_FAILED', pending: 'ADOPTION_VERIFICATION_PENDING',
    active: 'ADOPTION_VERIFICATION_PENDING', evaluating: 'ADOPTION_VERIFICATION_PENDING', reconciling: 'ADOPTION_VERIFICATION_UNSETTLED',
    cancelled: 'ADOPTION_VERIFICATION_CANCELLED' });
});

it('fingerprints a profile definition independently of key order and sensitive to every parameter', () => {
  const profile = { id: 'verify', version: 1, adapter: { id: 'docker', version: 1 }, parameters: { argv: ['npm', 'test'], deadlineMs: 1000 } };
  const reordered = { parameters: { deadlineMs: 1000, argv: ['npm', 'test'] }, adapter: { version: 1, id: 'docker' }, version: 1, id: 'verify' };
  expect(executionProfileFingerprint(profile)).toMatch(/^[a-f0-9]{64}$/);
  expect(executionProfileFingerprint(reordered)).toBe(executionProfileFingerprint(profile));
  expect(executionProfileFingerprint({ ...profile, parameters: { ...profile.parameters, argv: ['true'] } })).not.toBe(executionProfileFingerprint(profile));
  expect(executionProfileFingerprint({ ...profile, version: 2 })).not.toBe(executionProfileFingerprint(profile));
});

it('accepts the v2 adoption command with both verification fields or neither, and no v1 command', () => {
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 };
  const base = { schemaVersion: 2, commandId: 'c', identity, deliveryCommandId: 'd', targetRef: 'refs/heads/main' };
  expect(integrationAdoptionCommandSchema.parse(base)).toEqual(base);
  expect(integrationAdoptionCommandSchema.parse({ ...base, verificationRunId: 'v', verificationKind: 'verify' })).toMatchObject({ verificationRunId: 'v' });
  expect(() => integrationAdoptionCommandSchema.parse({ ...base, verificationRunId: 'v' })).toThrow();
  expect(() => integrationAdoptionCommandSchema.parse({ ...base, verificationKind: 'verify' })).toThrow();
  expect(() => integrationAdoptionCommandSchema.parse({ ...base, schemaVersion: 1 })).toThrow();
});
