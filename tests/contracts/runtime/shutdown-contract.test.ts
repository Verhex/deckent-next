import { describe, expect, it } from 'vitest';
import { runtimeServiceDescriptorSchema, sameShutdownAdmission, serviceActorSchema, serviceIdentitySchema,
  serviceInstanceSchema, shutdownAdmissionSchema, shutdownCommandSchema, shutdownOutcomeSchema,
  stableShutdownActor } from '#engine/core/runtime/index.js';

const principal = { id: 'local-user', issuer: 'installation', subject: '1000', assurance: 'os-user' as const, scopeIds: ['service-scope'] };
const actor = { principal, evidence: { method: 'os-peer' as const, pid: 41, uid: 1000, gid: 1000 } };
const command = { schemaVersion: 1 as const, commandId: 'shutdown-1', serviceId: 'runtime', instanceId: 'instance-1', reason: 'operator request' };
const admission = { schemaVersion: 1 as const, scopeId: 'service-scope', command, actor,
  authorization: { revision: 'policy-1', ruleId: 'allow-shutdown' }, admittedAtMs: 10 };

describe('runtime shutdown contract', () => {
  it('validates strict immutable identities, instances and descriptors', () => {
    const identity = serviceIdentitySchema.parse({ scopeId: 'service-scope', serviceId: 'runtime' });
    const instance = serviceInstanceSchema.parse({ ...identity, instanceId: 'instance-1' });
    const descriptor = runtimeServiceDescriptorSchema.parse({ schemaVersion: 1, identity, instanceId: instance.instanceId, shutdownAvailable: true });
    expect(descriptor).toEqual({ schemaVersion: 1, identity, instanceId: 'instance-1', shutdownAvailable: true });
    expect(Object.isFrozen(identity)).toBe(true); expect(Object.isFrozen(instance)).toBe(true); expect(Object.isFrozen(descriptor)).toBe(true);
    expect(() => serviceIdentitySchema.parse({ ...identity, tenantId: 'forged' })).toThrow();
    expect(() => runtimeServiceDescriptorSchema.parse({ ...descriptor, schemaVersion: 2 })).toThrow();
    expect(runtimeServiceDescriptorSchema.parse({ schemaVersion: 1, instanceId: 'instance-1', shutdownAvailable: false, identity: null })).toMatchObject({ identity: null });
    expect(() => runtimeServiceDescriptorSchema.parse({ ...descriptor, shutdownAvailable: false })).toThrow();
    expect(() => runtimeServiceDescriptorSchema.parse({ ...descriptor, identity: null })).toThrow();
  });

  it('bounds command reason and never accepts client-authored principal data in the command', () => {
    expect(shutdownCommandSchema.parse(command)).toEqual(command);
    for (const reason of ['', '   ', 'x'.repeat(1025)]) expect(() => shutdownCommandSchema.parse({ ...command, reason })).toThrow();
    expect(shutdownCommandSchema.parse({ ...command, reason: 'x'.repeat(1024) }).reason).toHaveLength(1024);
    expect(() => shutdownCommandSchema.parse({ ...command, principal })).toThrow();
    expect(() => shutdownCommandSchema.parse({ ...command, extra: true })).toThrow();
  });

  it('validates consistent OS principal/evidence shapes without treating PID as actor identity', () => {
    const parsed = serviceActorSchema.parse(actor);
    expect(stableShutdownActor(parsed)).toEqual({ issuer: 'installation', subject: '1000', assurance: 'os-user' });
    expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.evidence)).toBe(true);
    for (const evidence of [{ ...actor.evidence, pid: 0 }, { ...actor.evidence, uid: -1 }, { ...actor.evidence, gid: 1.5 }]) {
      expect(() => serviceActorSchema.parse({ ...actor, evidence })).toThrow();
    }
    expect(() => serviceActorSchema.parse({ ...actor, principal: { ...principal, admin: true } })).toThrow();
    expect(() => serviceActorSchema.parse({ ...actor, evidence: { ...actor.evidence, method: 'wire-claim' } })).toThrow();
    expect(() => serviceActorSchema.parse({ ...actor, principal: { ...principal, assurance: 'token-verified' } })).toThrow();
    expect(() => serviceActorSchema.parse({ ...actor, evidence: { ...actor.evidence, uid: 1001 } })).toThrow();
  });

  it('matches replay by canonical command and stable actor while retaining the original audit', () => {
    const existing = shutdownAdmissionSchema.parse(admission);
    const refreshed = { ...admission,
      actor: { ...actor, principal: { ...principal, id: 'display-name-changed', scopeIds: ['service-scope', 'other'] },
        evidence: { ...actor.evidence, pid: 99, gid: 99 } },
      authorization: { revision: 'policy-2', ruleId: 'new-rule' }, admittedAtMs: 20 };
    expect(sameShutdownAdmission(existing, refreshed)).toBe(true);
    expect(existing.authorization).toEqual({ revision: 'policy-1', ruleId: 'allow-shutdown' });
    expect(existing.actor.evidence.pid).toBe(41);
    expect(sameShutdownAdmission(existing, { ...refreshed, command: { ...command, instanceId: 'instance-2' } })).toBe(false);
    expect(sameShutdownAdmission(existing, { ...refreshed, command: { ...command, reason: 'different reason' } })).toBe(false);
    expect(sameShutdownAdmission(existing, { ...refreshed, actor: { ...refreshed.actor,
      principal: { ...refreshed.actor.principal, subject: '1001' }, evidence: { ...actor.evidence, uid: 1001 } } })).toBe(false);
  });

  it('validates admission audit metadata and rejects forged or incomplete shapes', () => {
    const parsed = shutdownAdmissionSchema.parse(admission);
    expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.authorization)).toBe(true);
    expect(() => shutdownAdmissionSchema.parse({ ...admission, authorization: { revision: 'policy-1' } })).toThrow();
    expect(() => shutdownAdmissionSchema.parse({ ...admission, admittedAtMs: -1 })).toThrow();
    expect(() => shutdownAdmissionSchema.parse({ ...admission, effect: 'stop-now' })).toThrow();
  });

  it('allows honest incomplete outcomes and enforces clean drain invariants', () => {
    const base = { schemaVersion: 1 as const, scopeId: 'service-scope', serviceId: 'runtime', instanceId: 'instance-1',
      commandId: 'shutdown-1', observedAtMs: 20 };
    expect(shutdownOutcomeSchema.parse({ ...base, state: 'clean', remainingRequests: 0, recoveryPending: false })).toMatchObject({ state: 'clean' });
    expect(shutdownOutcomeSchema.parse({ ...base, state: 'incomplete', remainingRequests: 2, recoveryPending: true })).toMatchObject({ state: 'incomplete' });
    expect(() => shutdownOutcomeSchema.parse({ ...base, state: 'clean', remainingRequests: 1, recoveryPending: false })).toThrow();
    expect(() => shutdownOutcomeSchema.parse({ ...base, state: 'clean', remainingRequests: 0, recoveryPending: true })).toThrow();
    expect(() => shutdownOutcomeSchema.parse({ ...base, state: 'incomplete', remainingRequests: -1, recoveryPending: false })).toThrow();
  });
});
