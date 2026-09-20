import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition, resolveModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { modelInvocationRequestEvidence, type ModelInvocationNativeResult, type ModelInvocationProfile, type ModelInvocationReceipt } from '#domain/core/model-invocation/index.js';
import { ModelInvocationApplication, ModelInvocationInspectionApplication, modelInvocationProfileDigest,
  createModelInvocationEvidenceRecord, createModelInvocationResponseEvidence, createModelInvocationResponseRecord,
  createModelInvocationUnknownRecord, modelInvocationRequestDigest, modelInvocationTargetId, type ModelInvocationAdmission,
  type ModelInvocationRecord, type ModelInvocationStore } from '#engine/core/model-invocation/index.js';

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
  return { schemaVersion: 3, request, actor: input.actor, authorization: input.authorization, definition: input.definition,
    activationRevision: input.activation.revision, profile: input.profile, profileDigest: input.profileDigest,
    claim: { scopeId: input.command.scopeId, commandId: input.command.commandId, invocationId: input.invocationId,
      requestDigest: input.requestDigest, profileDigest: input.profileDigest }, claimedAtMs: input.claimedAtMs, outcome };
}
function fixture(options: { nativeResult?: ModelInvocationNativeResult; profilePadding?: number; responseLimit?: number; prepare?: () => void; sendError?: boolean; responseWriteError?: boolean;
  substituteOutcome?: boolean; denySecond?: boolean; changeProfile?: boolean; concurrentBarrier?: boolean; responseBound?: bigint } = {}) {
  let stored: ModelInvocationRecord | null = null, policy = 0, selectedProfile: ModelInvocationProfile = { ...profile, limits: { ...profile.limits, responseMaxBytes: options.responseLimit ?? profile.limits.responseMaxBytes } }, invocationSequence = 0;
  if (options.profilePadding) selectedProfile = { ...selectedProfile, adapter: { ...selectedProfile.adapter,
    definition: { padding: Array.from({ length: options.profilePadding }, () => null) } } };
  let waitingLoads = 0, releaseLoads: (() => void) | undefined;
  const loadBarrier = new Promise<void>(resolve => { releaseLoads = resolve; });
  const calls = { claims: 0, sends: 0, bindings: 0, profiles: 0, activations: 0, closes: 0 };
  const store: ModelInvocationStore = {
    async loadReceipt() { const found = stored;
      if (options.concurrentBarrier && found === null && ++waitingLoads <= 2) { if (waitingLoads === 2) releaseLoads?.(); await loadBarrier; }
      return found; }, async loadInvocation() { return stored; },
    async claim(input) { calls.claims++; if (stored) return { replayed: true, record: stored };
      stored = { receipt: receipt(input), content: null }; return { replayed: false, record: stored }; },
    async recordResponse(_claim, response, observedAtMs) { if (options.responseWriteError) throw new Error('SQL');
      const base = stored!.receipt; stored = createModelInvocationResponseRecord(base,
        options.substituteOutcome ? { ...response, native: { substituted: true } } : response, observedAtMs); return stored; },
    async recordUnknown(_claim, _reason, observedAtMs, evidence = null) { stored = evidence
      ? createModelInvocationEvidenceRecord(stored!.receipt, evidence, observedAtMs)
      : createModelInvocationUnknownRecord(stored!.receipt, observedAtMs); return stored; },
    async recordRejected(_claim, evidence, observedAtMs) { if (options.responseWriteError) throw new Error('SQL');
      stored = createModelInvocationEvidenceRecord(stored!.receipt, evidence, observedAtMs); return stored; },
    close() { calls.closes++; },
  };
  const app = new ModelInvocationApplication({ async verify() { return principal; } },
    { async authorize() { policy++; if (options.denySecond && policy === 2) throw new Error('DENIED'); return authorization; } },
    { async inspect() { calls.bindings++; return { schemaVersion: 1 as const, reference, status: 'declared' as const,
      catalogRevision: 'catalog', definition, binding, availability: 'not-observed' as const }; } },
    async () => ({ async loadRecord() { calls.activations++; return activation; }, close() {} }),
    { async resolve() { calls.profiles++; return selectedProfile; } }, { resolve() { return {
      ...(options.responseBound === undefined ? {} : { responseBytesUpperBound: () => options.responseBound! }),
      async prepare() { options.prepare?.(); if (options.changeProfile) selectedProfile = { ...profile, version: 2 }; return Object.freeze({ body: 'prepared' }); },
      async send() { calls.sends++; if (options.sendError) throw new Error('RESET');
        return options.nativeResult ?? { schemaVersion: 1 as const, native: { id: 'response' }, usage: null }; },
    }; } }, async () => store, { invocationId: () => `invocation-${++invocationSequence}`, now: () => 10 });
  return { app, calls, store, get stored() { return stored; } };
}

describe('model invocation application', () => {
  it('rejects profiles whose retained evidence cannot fit the canonical receipt before any effect', async () => {
    const f = fixture({ responseLimit: Number.MAX_SAFE_INTEGER });
    await expect(f.app.invoke(command)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_RESULT_LIMIT' });
    expect(f.calls).toMatchObject({ claims: 0, sends: 0 });
  });

  it('retains complete rejected content and incomplete observation distinctly without a second send', async () => {
    for (const complete of [true, false]) {
      const evidence = createModelInvocationResponseEvidence(profile.adapter, complete ? 'invalid-response' : 'interrupted', 200,
        Buffer.from('{malformed useful response'), complete);
      const f = fixture({ nativeResult: { kind: 'rejected', evidence }, responseBound: 100n });
      const result = await f.app.invoke(command, undefined, undefined, { maxResultBytes: 10_000 });
      expect(result.receipt.outcome).toMatchObject({ schemaVersion: 3, state: complete ? 'rejected' : 'unknown',
        evidence: { body: { digest: evidence.body.digest, byteLength: evidence.body.byteLength } } });
      expect(JSON.stringify(result)).not.toContain(evidence.body.data);
      expect(f.stored?.content).toMatchObject({ kind: 'response-body', data: evidence.body.data });
      expect(await f.app.invoke(command)).toEqual({ ...result, replayed: true });
      expect(f.calls.sends).toBe(1);
    }
  });
  it('does not fabricate durable rejection when recording the observed response fails', async () => {
    const evidence = createModelInvocationResponseEvidence(profile.adapter, 'http-status', 429, Buffer.from('limited'), true);
    const f = fixture({ nativeResult: { kind: 'rejected', evidence }, responseWriteError: true });
    await expect(f.app.invoke(command)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_OUTCOME_UNKNOWN' });
    expect(f.stored?.receipt.outcome).toBeNull(); expect(f.calls.sends).toBe(1);
    expect((await f.app.invoke(command)).replayed).toBe(true); expect(f.calls.sends).toBe(1);
  });
  it('rejects a store-substituted settled response after the native effect', async () => {
    const f = fixture({ substituteOutcome: true });
    await expect(f.app.invoke(command)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_OUTCOME_UNKNOWN' });
    expect(f.calls).toMatchObject({ claims: 1, sends: 1 });
    expect(f.stored?.content).toMatchObject({ kind: 'native-response', response: { native: { substituted: true } } });
  });

  it('rejects unsupported and insufficient delivery before any durable claim or native effect', async () => {
    const unsupported = fixture();
    await expect(unsupported.app.invoke(command, undefined, undefined, { maxResultBytes: 10_000 }))
      .rejects.toMatchObject({ code: 'MODEL_INVOCATION_DELIVERY_UNAVAILABLE' });
    expect(unsupported.calls).toMatchObject({ claims: 0, sends: 0 });
    const small = fixture({ responseBound: 100n });
    await expect(small.app.invoke(command, undefined, undefined, { maxResultBytes: 100 }))
      .rejects.toMatchObject({ code: 'MODEL_INVOCATION_RESULT_LIMIT' });
    expect(small.calls).toMatchObject({ claims: 0, sends: 0 });
    const huge = fixture({ responseBound: BigInt(Number.MAX_SAFE_INTEGER) * 2n });
    await expect(huge.app.invoke(command, undefined, undefined, { maxResultBytes: Number.MAX_SAFE_INTEGER }))
      .rejects.toMatchObject({ code: 'MODEL_INVOCATION_RESULT_LIMIT' });
    expect(huge.calls).toMatchObject({ claims: 0, sends: 0 });
  });

  it('delivers a complete bounded result and rejects config-shrunk replay without resending', async () => {
    const f = fixture({ responseBound: 100n });
    const first = await f.app.invoke(command, undefined, undefined, { maxResultBytes: 10_000 });
    expect(first.receipt.outcome?.state).toBe('responded');
    const actual = Buffer.byteLength(JSON.stringify({ ...first, replayed: true }), 'utf8');
    expect(await f.app.invoke(command, undefined, undefined, { maxResultBytes: actual })).toEqual({ ...first, replayed: true });
    await expect(f.app.invoke(command, undefined, undefined, { maxResultBytes: actual - 1 }))
      .rejects.toMatchObject({ code: 'MODEL_INVOCATION_RESULT_LIMIT' });
    expect(f.calls).toMatchObject({ claims: 1, sends: 1 });
  });

  it('accepts the exact proven preclaim capacity and rejects one byte less without effects', async () => {
    const probe = await fixture().app.invoke(command), receipt = { ...probe.receipt, outcome: null };
    const descriptor = { schemaVersion: 1, kind: 'native-response', encoding: 'canonical-json', digest: 'f'.repeat(64),
      byteLength: Number.MAX_SAFE_INTEGER };
    const responded = Buffer.byteLength(JSON.stringify({ replayed: false, receipt: { ...receipt, outcome: { schemaVersion: 3,
      state: 'responded', content: descriptor, observedAtMs: Number.MAX_SAFE_INTEGER } }, response: null,
      contentStatus: 'retained' }), 'utf8') - 4 + 100;
    const evidenceDescriptor = { ...descriptor, kind: 'response-body', encoding: 'base64' };
    const summary = { schemaVersion: 1, adapter: profile.adapter, reason: 'response-limit', httpStatus: null,
      body: { encoding: 'base64', byteLength: Number.MAX_SAFE_INTEGER, observedBytes: Number.MAX_SAFE_INTEGER,
        complete: false, digest: 'f'.repeat(64) } };
    const partial = Buffer.byteLength(JSON.stringify({ replayed: false, receipt: { ...receipt, outcome: { schemaVersion: 3,
      state: 'unknown', reason: 'transport-error', evidence: summary, content: evidenceDescriptor,
      observedAtMs: Number.MAX_SAFE_INTEGER } }, response: null, contentStatus: 'retained' }), 'utf8');
    const required = Math.max(responded, partial), small = fixture({ responseBound: 100n });
    await expect(small.app.invoke(command, undefined, undefined, { maxResultBytes: required - 1 }))
      .rejects.toMatchObject({ code: 'MODEL_INVOCATION_RESULT_LIMIT' });
    expect(small.calls).toMatchObject({ claims: 0, sends: 0 });
    const exact = fixture({ responseBound: 100n });
    expect((await exact.app.invoke(command, undefined, undefined, { maxResultBytes: required })).receipt.outcome?.state).toBe('responded');
    expect(exact.calls).toMatchObject({ claims: 1, sends: 1 });
  });

  it('preserves unknown custody when an adapter violates its declared response bound', async () => {
    const f = fixture({ responseBound: 1n });
    const result = await f.app.invoke(command, undefined, undefined, { maxResultBytes: 10_000 });
    expect(result.receipt.outcome?.state).toBe('unknown');
    expect((await f.app.invoke(command)).receipt).toEqual(result.receipt);
    expect(f.calls).toMatchObject({ claims: 1, sends: 1 });
  });

  it('exact-checks concurrent historical replay even when its pinned profile is larger than the fresh admission', async () => {
    const f = fixture({ responseBound: 100n }), first = await f.app.invoke(command);
    const historicalProfile = { ...first.receipt.profile,
      adapter: { ...first.receipt.profile.adapter, definition: { text: 'İ😀\n'.repeat(3000) } } };
    const digest = modelInvocationProfileDigest(historicalProfile);
    const historical = { ...first.receipt, profile: historicalProfile, profileDigest: digest,
      claim: { ...first.receipt.claim, profileDigest: digest } };
    f.store.loadReceipt = async () => null;
    f.store.claim = async () => ({ replayed: true, record: { receipt: historical, content: first.response ? {
      schemaVersion: 1, kind: 'native-response', descriptor: historical.outcome!.content, response: first.response } : null } });
    await expect(f.app.invoke(command, undefined, undefined, { maxResultBytes: 10_000 }))
      .rejects.toMatchObject({ code: 'MODEL_INVOCATION_RESULT_LIMIT' });
    expect(f.calls.sends).toBe(1);
    expect((await f.app.invoke(command)).receipt).toEqual(historical);
    expect(f.calls.sends).toBe(1);
  });
  it('samples policy again after preparation, claims once, sends once, and replays without live dependencies', async () => {
    const f = fixture(), first = await f.app.invoke(command);
    expect(first).toMatchObject({ replayed: false, receipt: { outcome: { state: 'responded' } } });
    expect(JSON.stringify(first)).not.toContain('private'); expect(f.calls).toMatchObject({ claims: 1, sends: 1, bindings: 2, profiles: 2 });
    const replay = await f.app.invoke(command); expect(replay).toEqual({ ...first, replayed: true });
    expect(f.calls).toMatchObject({ claims: 1, sends: 1, bindings: 2, profiles: 2 });
  });

  it('does not claim or send when the last policy sample denies after pure preparation', async () => {
    const f = fixture({ denySecond: true });
    await expect(f.app.invoke(command, undefined, undefined, { maxResultBytes: 1 })).rejects.toThrow('DENIED');
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
    expect(f.calls).toMatchObject({ claims: 1, sends: 1 }); expect(f.stored?.receipt.outcome).toBeNull();
  });

  it('uses a distinct stable invocation policy target and inspects only exact stored identity after fresh policy', async () => {
    expect(modelInvocationTargetId(reference)).toMatch(/^[a-f0-9]{64}$/);
    const f = fixture(); const invoked = await f.app.invoke(command); let authorized = 0;
    const inspect = new ModelInvocationInspectionApplication({ async verify() { return principal; } },
      { async authorize(action) { expect(action).toBe('inspect'); authorized++; return authorization; } }, async () => f.store);
    expect((await inspect.inspect({ schemaVersion: 2, scopeId: 'scope', invocationId: 'invocation-1', reference })).invocation)
      .toEqual(invoked.receipt); expect(authorized).toBe(1);
    expect(modelInvocationProfileDigest(profile)).toMatch(/^[a-f0-9]{64}$/);
    expect(modelInvocationRequestDigest(command)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('model invocation private evidence access', () => {
  it('withholds echoed raw evidence by default and requires fresh additional authority before opening a reader', async () => {
    const evidence = createModelInvocationResponseEvidence(profile.adapter, 'invalid-response', 200,
      Buffer.from('private echoed prompt\x1b[31m'), true);
    const f = fixture({ nativeResult: { kind: 'rejected', evidence } });
    const invoked = await f.app.invoke(command); let rawAllowed = false, reads = 0;
    const actions: string[] = [];
    const inspect = new ModelInvocationInspectionApplication({ async verify() { return principal; } },
      { async authorize(action) { actions.push(action); if (action === 'inspect-content' && !rawAllowed) throw new Error('RAW_DENIED'); return authorization; } },
      async () => { reads++; return f.store; });
    const query = { schemaVersion: 2 as const, scopeId: 'scope', invocationId: 'invocation-1', reference };
    const ordinary = await inspect.inspect(query);
    expect(ordinary.invocation).toEqual(invoked.receipt);
    expect(ordinary).not.toHaveProperty('responseContent');
    expect(JSON.stringify(ordinary)).not.toContain(evidence.body.data);
    expect(f.stored?.content).toMatchObject({ data: evidence.body.data });
    await expect(inspect.inspect({ ...query, includeResponseContent: true })).rejects.toThrow('RAW_DENIED');
    expect(reads).toBe(1); expect(actions).toEqual(['inspect', 'inspect', 'inspect-content']);
    rawAllowed = true;
    const explicit = await inspect.inspect({ ...query, includeResponseContent: true });
    expect(explicit.responseContent).toEqual(f.stored?.content);
    expect(explicit.invocation).toEqual(ordinary.invocation);
    rawAllowed = false;
    await expect(inspect.inspect({ ...query, includeResponseContent: true })).rejects.toThrow('RAW_DENIED');
    expect(reads).toBe(2); expect(f.calls.sends).toBe(1);
    expect((await inspect.inspect({ ...query, includeResponseContent: false }))).not.toHaveProperty('responseContent');
  });

});

describe('model invocation composed receipt bounds', () => {
  it('persists a deeply nested valid native response inside its receipt without a post-send envelope failure', async () => {
    let native: Record<string, unknown> = { leaf: 'value' };
    for (let depth = 0; depth < 14; depth++) native = { next: native };
    const f = fixture({ responseLimit: 4096, nativeResult: { schemaVersion: 1, native, usage: null } as ModelInvocationNativeResult });
    const result = await f.app.invoke(command);
    expect(result.receipt.outcome).toMatchObject({ state: 'responded', content: { kind: 'native-response' } });
    expect(result.response?.native).toEqual(native);
    expect(f.calls).toMatchObject({ claims: 1, sends: 1 });
    expect(await f.app.invoke(command)).toEqual({ ...result, replayed: true });
  });

  it('bounds static and response fragments separately when their combined node count exceeds one fragment limit', async () => {
    const native = { values: Array.from({ length: 100_000 }, () => null) };
    const f = fixture({ profilePadding: 200_000, responseLimit: 600_000, nativeResult: { schemaVersion: 1, native, usage: null } });
    const result = await f.app.invoke(command);
    expect(result.receipt.outcome?.state).toBe('responded');
    expect(f.calls).toMatchObject({ claims: 1, sends: 1 });
  }, 30_000);
});
