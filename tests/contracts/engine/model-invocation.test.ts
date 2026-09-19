import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition, resolveModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { modelInvocationRequestEvidence, type ModelInvocationProfile, type ModelInvocationReceipt } from '#domain/core/model-invocation/index.js';
import { ModelInvocationApplication, ModelInvocationInspectionApplication, modelInvocationProfileDigest,
  modelInvocationRequestDigest, modelInvocationTargetId, type ModelInvocationAdmission,
  type ModelInvocationStore } from '#engine/core/model-invocation/index.js';

const reference = { providerId: 'p', providerVersion: 1, modelId: 'm', modelVersion: 1 };
const definition = resolveModelBindingDefinition({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'p', version: 1,
  models: [{ id: 'm', version: 1, nativeId: 'native', protocols: [{ family: 'chat', version: '1', capabilities: [] }] }] }] }, reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const command = { schemaVersion: 1 as const, commandId: 'command', scopeId: 'scope', reference, catalogRevision: 'catalog',
  expectedBinding: binding, nativeRequest: { prompt: 'private' } };
const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
  protocol: { family: 'chat', version: '1' }, adapter: { id: 'adapter', version: 1, definition: { origin: 'loopback' } },
  allocation: { id: 'allocation', maxCalls: 2, maxInFlight: 1 }, limits: { requestMaxBytes: 100, responseMaxBytes: 100, timeoutMs: 100 } };
const activation = { schemaVersion: 1 as const, scopeId: 'scope', reference, revision: 1, state: 'active' as const,
  catalogRevision: 'catalog', definition, binding };
const principal = { id: 'actor', issuer: 'os', subject: '1', assurance: 'os-user' as const, scopeIds: ['scope'] };
const authorization = { revision: 'policy', ruleId: 'invoke' };

function receipt(input: ModelInvocationAdmission, outcome: ModelInvocationReceipt['outcome'] = null): ModelInvocationReceipt {
  const request = modelInvocationRequestEvidence(input.command, input.requestDigest);
  return { schemaVersion: 1, request, actor: input.actor, authorization: input.authorization, definition: input.definition,
    activationRevision: input.activation.revision, profile: input.profile, profileDigest: input.profileDigest,
    claim: { scopeId: input.command.scopeId, commandId: input.command.commandId, invocationId: input.invocationId,
      requestDigest: input.requestDigest, profileDigest: input.profileDigest }, claimedAtMs: input.claimedAtMs, outcome };
}
function fixture(options: { prepare?: () => void; sendError?: boolean; responseWriteError?: boolean;
  denySecond?: boolean; changeProfile?: boolean; concurrentBarrier?: boolean } = {}) {
  let stored: ModelInvocationReceipt | null = null, policy = 0, selectedProfile: ModelInvocationProfile = profile, invocationSequence = 0;
  let waitingLoads = 0, releaseLoads: (() => void) | undefined;
  const loadBarrier = new Promise<void>(resolve => { releaseLoads = resolve; });
  const calls = { claims: 0, sends: 0, bindings: 0, profiles: 0, activations: 0, closes: 0 };
  const store: ModelInvocationStore = {
    async loadReceipt() { const found = stored;
      if (options.concurrentBarrier && found === null && ++waitingLoads <= 2) { if (waitingLoads === 2) releaseLoads?.(); await loadBarrier; }
      return found; }, async loadInvocation() { return stored; },
    async claim(input) { calls.claims++; if (stored) return { replayed: true, receipt: stored };
      stored = receipt(input); return { replayed: false, receipt: stored }; },
    async recordResponse(_claim, response, observedAtMs) { if (options.responseWriteError) throw new Error('SQL');
      stored = { ...stored!, outcome: { schemaVersion: 1, state: 'responded', response, observedAtMs } }; return stored; },
    async recordUnknown(_claim, reason, observedAtMs) { stored = { ...stored!, outcome: { schemaVersion: 1, state: 'unknown', reason, observedAtMs } }; return stored; },
    close() { calls.closes++; },
  };
  const app = new ModelInvocationApplication({ async verify() { return principal; } },
    { async authorize() { policy++; if (options.denySecond && policy === 2) throw new Error('DENIED'); return authorization; } },
    { async inspect() { calls.bindings++; return { schemaVersion: 1 as const, reference, status: 'declared' as const,
      catalogRevision: 'catalog', definition, binding, availability: 'not-observed' as const }; } },
    async () => ({ async loadRecord() { calls.activations++; return activation; }, close() {} }),
    { async resolve() { calls.profiles++; return selectedProfile; } }, { resolve() { return {
      async prepare() { options.prepare?.(); if (options.changeProfile) selectedProfile = { ...profile, version: 2 }; return Object.freeze({ body: 'prepared' }); },
      async send() { calls.sends++; if (options.sendError) throw new Error('RESET');
        return { schemaVersion: 1 as const, native: { id: 'response' }, usage: null }; },
    }; } }, async () => store, { invocationId: () => `invocation-${++invocationSequence}`, now: () => 10 });
  return { app, calls, store, get stored() { return stored; } };
}

describe('model invocation application', () => {
  it('samples policy again after preparation, claims once, sends once, and replays without live dependencies', async () => {
    const f = fixture(), first = await f.app.invoke(command);
    expect(first).toMatchObject({ replayed: false, receipt: { outcome: { state: 'responded' } } });
    expect(JSON.stringify(first)).not.toContain('private'); expect(f.calls).toMatchObject({ claims: 1, sends: 1, bindings: 2, profiles: 2 });
    const replay = await f.app.invoke(command); expect(replay).toEqual({ replayed: true, receipt: first.receipt });
    expect(f.calls).toMatchObject({ claims: 1, sends: 1, bindings: 2, profiles: 2 });
  });

  it('does not claim or send when the last policy sample denies after pure preparation', async () => {
    const f = fixture({ denySecond: true }); await expect(f.app.invoke(command)).rejects.toThrow('DENIED');
    expect(f.calls).toMatchObject({ claims: 0, sends: 0 });
  });

  it('does not claim or send when the trusted profile changes during preparation', async () => {
    const f = fixture({ changeProfile: true });
    await expect(f.app.invoke(command)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_PROFILE_CONFLICT' });
    expect(f.calls).toMatchObject({ claims: 0, sends: 0 });
  });

  it('records post-claim transport failure as unknown and never resends it on replay', async () => {
    const f = fixture({ sendError: true }), first = await f.app.invoke(command);
    expect(first.receipt.outcome).toMatchObject({ state: 'unknown', reason: 'transport-error' });
    expect((await f.app.invoke(command)).receipt).toEqual(first.receipt); expect(f.calls.sends).toBe(1);
  });

  it('accepts a concurrent exact store replay with another generated invocation id and sends once', async () => {
    const f = fixture({ concurrentBarrier: true }), [first, second] = await Promise.all([f.app.invoke(command), f.app.invoke(command)]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.receipt.claim).toEqual(second.receipt.claim);
    expect([first, second].find(result => result.replayed)?.receipt.outcome).toBeNull(); expect(f.calls.sends).toBe(1);
  });

  it('reports honest outcome uncertainty when response persistence fails after a send', async () => {
    const f = fixture({ responseWriteError: true });
    await expect(f.app.invoke(command)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_OUTCOME_UNKNOWN' });
    expect(f.calls).toMatchObject({ claims: 1, sends: 1 }); expect(f.stored?.outcome).toBeNull();
  });

  it('uses a distinct stable invocation policy target and inspects only exact stored identity after fresh policy', async () => {
    expect(modelInvocationTargetId(reference)).toMatch(/^[a-f0-9]{64}$/);
    const f = fixture(); const invoked = await f.app.invoke(command); let authorized = 0;
    const inspect = new ModelInvocationInspectionApplication({ async verify() { return principal; } },
      { async authorize(action) { expect(action).toBe('inspect'); authorized++; return authorization; } }, async () => f.store);
    expect((await inspect.inspect({ schemaVersion: 1, scopeId: 'scope', invocationId: 'invocation-1', reference })).invocation)
      .toEqual(invoked.receipt); expect(authorized).toBe(1);
    expect(modelInvocationProfileDigest(profile)).toMatch(/^[a-f0-9]{64}$/);
    expect(modelInvocationRequestDigest(command)).toMatch(/^[a-f0-9]{64}$/);
  });
});
