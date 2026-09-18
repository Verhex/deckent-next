import { expect, it } from 'vitest';
import { dispatchAdmissionSchema, dispatchClaimSchema, dispatchRecordSchema } from '#engine/index.js';

const request = { protocolVersion: 1, identity: { runId: 'run', taskId: 'task', attemptId: 'attempt', scopeId: 'scope', layoutRevision: 'layout', generation: 1 }, workspace: '/private/workspace', argv: ['program'] };
const profile = { schemaVersion: 1, adapterId: 'test-adapter', adapterVersion: 1, parameters: { options: { limit: 8 }, origin: 'test-origin' } };
const actor = { id: 'u', issuer: 'local', subject: 'u' };
const pending = { schemaVersion: 2, request, owner: 'controller', profile, launch: 'pending', terminal: null };
const grant = { generation: 1, grantedAt: 10, principal: actor };
const terminal = { handle: 'process', exitCode: 0, interrupted: false };

it('copies and freezes the current profile without treating admission as a launch grant', () => {
  const input = structuredClone(pending); const parsed = dispatchRecordSchema.parse(input);
  input.profile.parameters.options.limit = 100;
  expect(parsed.profile.parameters.options).toEqual({ limit: 8 });
  expect(Object.isFrozen(parsed.profile.parameters.options)).toBe(true);
  expect(parsed.launch).toBe('pending');
  expect(dispatchClaimSchema.parse({ request, owner: 'controller' })).toEqual({ request, owner: 'controller' });
  expect(dispatchAdmissionSchema.parse({ request, owner: 'controller', profile }).profile).toEqual(profile);
});

it('requires grant identity metadata and keeps prevention distinct from process exit', () => {
  const output = { schemaVersion: 1, scopeId: 'scope', digest: 'a'.repeat(64), byteLength: 1 };
  const granted = { ...pending, launch: 'granted', grant };
  expect(dispatchRecordSchema.parse({ ...granted, output }).grant).toEqual(grant);
  expect(dispatchRecordSchema.parse({ ...granted, terminal }).terminal).toEqual(terminal);
  expect(dispatchRecordSchema.parse({ ...granted, cancellation: actor }).terminal).toBeNull();
  const prevented = { ...pending, launch: 'prevented-before-launch', cancellation: actor, prevention: { reason: 'cancel-requested' } };
  expect(dispatchRecordSchema.parse(prevented).prevention).toEqual({ reason: 'cancel-requested' });
  for (const input of [{ ...granted, grant: undefined }, { ...granted, grant: { ...grant, generation: 2 } },
    { ...pending, launch: 'prevented-before-launch' }, { ...prevented, cancellation: undefined },
    { ...prevented, terminal }, { ...prevented, output }]) expect(dispatchRecordSchema.safeParse(input).success).toBe(false);
});

it('rejects the removed record shape, missing custody, and extra authority fields', () => {
  expect(dispatchRecordSchema.safeParse({ schemaVersion: 1, request, owner: 'controller', terminal: null }).success).toBe(false);
  for (const input of [{ ...pending, profile: undefined }, { ...pending, launch: undefined }, { ...pending, mayExecute: true },
    { ...pending, profile: { ...profile, permissionGranted: true } }]) expect(dispatchRecordSchema.safeParse(input).success).toBe(false);
});
