import { expect, it } from 'vitest';
import { dispatchClaimV2Schema, dispatchRecordV2Schema, dispatchRecordSchema } from '#engine/index.js';

const request = { protocolVersion: 1, identity: { runId: 'run', taskId: 'task', attemptId: 'attempt', scopeId: 'scope', layoutRevision: 'layout', generation: 1 }, workspace: '/private/workspace', argv: ['program'] };
const profile = { schemaVersion: 1, adapterId: 'test-adapter', adapterVersion: 1, parameters: { options: { limit: 8 }, origin: 'test-origin' } };
const record = { schemaVersion: 2, request, owner: 'controller', profile, launch: 'pending', terminal: null };
const terminal = { handle: 'process', exitCode: 0, interrupted: false };

it('copies and freezes the complete versioned profile without using it as a launch grant', () => {
  const input = structuredClone(record); const parsed = dispatchRecordV2Schema.parse(input);
  input.profile.parameters.options.limit = 100;
  expect(parsed.profile.parameters.options).toEqual({ limit: 8 });
  expect(Object.isFrozen(parsed.profile.parameters.options)).toBe(true);
  expect(parsed.launch).toBe('pending');
  expect(dispatchClaimV2Schema.parse({ request, owner: 'controller', profile }).profile).toEqual(profile);
});

it('keeps prevention distinct from process exit and rejects impossible evidence combinations', () => {
  const output = { schemaVersion: 1, scopeId: 'scope', digest: 'a'.repeat(64), byteLength: 1 };
  expect(dispatchRecordV2Schema.safeParse({ ...record, launch: 'granted', output }).success).toBe(true);
  for (const launch of ['pending', 'prevented-before-launch']) {
    expect(dispatchRecordV2Schema.safeParse({ ...record, launch }).success).toBe(true);
    expect(dispatchRecordV2Schema.safeParse({ ...record, launch, terminal }).success).toBe(false);
    expect(dispatchRecordV2Schema.safeParse({ ...record, launch, output }).success).toBe(false);
  }
  expect(dispatchRecordV2Schema.parse({ ...record, launch: 'granted', terminal }).terminal).toEqual(terminal);
  // A granted launch may have no observed result, even after cancellation.
  expect(dispatchRecordV2Schema.parse({ ...record, launch: 'granted', cancellation: { id: 'u', issuer: 'local', subject: 'u' } }).terminal).toBeNull();
});

it('requires explicit v2 custody and rejects v1 conversion or extra authority fields', () => {
  const old = { schemaVersion: 1, request, owner: 'controller', terminal: null };
  expect(dispatchRecordSchema.safeParse(old).success).toBe(true);
  expect(dispatchRecordV2Schema.safeParse(old).success).toBe(false);
  expect(dispatchRecordSchema.safeParse(record).success).toBe(false);
  for (const input of [{ ...record, profile: undefined }, { ...record, launch: undefined }, { ...record, mayExecute: true },
    { ...record, profile: { ...profile, permissionGranted: true } }]) {
    expect(dispatchRecordV2Schema.safeParse(input).success).toBe(false);
  }
});
