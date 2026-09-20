import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IDENTITY_MAX_LENGTH } from '#domain/core/primitives/index.js';
import { encodeModelBindingDefinition, resolveModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { modelInvocationRequestEvidence, type ModelInvocationClaim, type ModelInvocationNativeResult, type ModelInvocationProfile, type ModelInvocationReceipt } from '#domain/core/model-invocation/index.js';
import { ModelInvocationControllers, ModelInvocationApplication, ModelInvocationInspectionApplication, ModelInvocationPurgeApplication, modelInvocationProfileDigest,
  createModelInvocationEvidenceRecord, createModelInvocationResponseEvidence, createModelInvocationResponseRecord,
  createModelInvocationPreventedRecord, createModelInvocationUnknownRecord, modelInvocationRequestDigest, modelInvocationTargetId, type ModelInvocationAdmission,
  type ModelInvocationPurgeAdmission, type ModelInvocationPurgeResult, type ModelInvocationRecord,
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
  return { schemaVersion: 4, request, actor: input.actor, authorization: input.authorization, definition: input.definition,
    activationRevision: input.activation.revision, profile: input.profile, profileDigest: input.profileDigest,
    claim: { scopeId: input.command.scopeId, commandId: input.command.commandId, invocationId: input.invocationId,
      requestDigest: input.requestDigest, profileDigest: input.profileDigest }, claimedAtMs: input.claimedAtMs, outcome };
}
function fixture(options: { liveControllers?: boolean; claimError?: boolean; permitError?: boolean; nativeResult?: ModelInvocationNativeResult; profilePadding?: number; responseLimit?: number; prepare?: () => void; sendError?: boolean; responseWriteError?: boolean;
  substituteOutcome?: boolean; denySecond?: boolean; changeProfile?: boolean; concurrentBarrier?: boolean; responseBound?: bigint;
  permission?: 'denied' | 'pending' | 'prevented' | 'prevented-claimed' | 'forged-terminal' | 'foreign-owner' } = {}) {
  const controllers = new ModelInvocationControllers(2), registrations: ModelInvocationClaim[] = [];
  let stored: ModelInvocationRecord | null = null, policy = 0, selectedProfile: ModelInvocationProfile = { ...profile, limits: { ...profile.limits, responseMaxBytes: options.responseLimit ?? profile.limits.responseMaxBytes } }, invocationSequence = 0;
  if (options.profilePadding) selectedProfile = { ...selectedProfile, adapter: { ...selectedProfile.adapter,
    definition: { padding: Array.from({ length: options.profilePadding }, () => null) } } };
  let waitingLoads = 0, releaseLoads: (() => void) | undefined;
  const loadBarrier = new Promise<void>(resolve => { releaseLoads = resolve; });
  const calls = { claims: 0, permissions: 0, sends: 0, bindings: 0, profiles: 0, activations: 0, closes: 0 };
  const store: ModelInvocationStore = {
    async loadReceipt() { const found = stored;
      if (options.concurrentBarrier && found === null && ++waitingLoads <= 2) { if (waitingLoads === 2) releaseLoads?.(); await loadBarrier; }
      return found; }, async loadInvocation() { return stored; },
    async claim(input) { calls.claims++; if (options.claimError) throw new Error('CLAIM'); if (stored) return { replayed: true, record: stored };
      stored = { receipt: receipt(input), content: null, purge: null }; return { replayed: false, record: stored }; },
    async permitSend(claim, ownerId, now) { calls.permissions++; if (options.permitError) throw new Error('PERMIT');
      if (options.permission === 'denied') return { granted: false, record: stored!, control: { schemaVersion: 1, claim, reference,
        send: { state: 'permitted', ownerId: 'other-runtime', permittedAtMs: now }, cancellation: null } };
      if (options.permission === 'pending') return { granted: false, record: stored!,
        control: { schemaVersion: 1, claim, reference, send: { state: 'pending' }, cancellation: null } };
      if (options.permission === 'prevented' || options.permission === 'prevented-claimed' || options.permission === 'forged-terminal') {
        const cancellation = { schemaVersion: 1 as const,
          command: { schemaVersion: 1 as const, commandId: 'cancel', scopeId: claim.scopeId,
            targetCommandId: claim.commandId, reference, expectedRequestDigest: claim.requestDigest }, claim,
          actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance },
          authorization: { revision: 'cancel-policy', ruleId: 'cancel' }, requestedAtMs: now,
          disposition: 'prevented' as const };
        if (options.permission !== 'prevented-claimed') stored = createModelInvocationPreventedRecord(stored!.receipt,
          options.permission === 'forged-terminal' ? { ...cancellation,
            command: { ...cancellation.command, commandId: 'forged-cancel' } } : cancellation);
        return { granted: false, record: stored,
          control: { schemaVersion: 1, claim, reference, send: { state: 'prevented' }, cancellation } };
      }
      return { granted: true, record: stored!, control: { schemaVersion: 1, claim, reference,
        send: { state: 'permitted', ownerId: options.permission === 'foreign-owner' ? 'foreign' : ownerId, permittedAtMs: now }, cancellation: null } }; },
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
    }; } }, async () => store, { invocationId: () => `invocation-${++invocationSequence}`, ownerId: () => 'runtime-owner', now: () => 10,
      ...(options.liveControllers ? { register(claim: ModelInvocationClaim, owner: string) { registrations.push(claim); return controllers.register(claim, owner); } } : {}) });
  return { app, calls, store, controllers, registrations, get stored() { return stored; } };
}

describe('model invocation application', () => {
  it('releases live controller custody on claim/permission failures, prevention, native failure, settlement and concurrent replay', async () => {
    const cases = [{ claimError: true }, { permitError: true }, { permission: 'prevented' as const },
      { sendError: true }, { responseWriteError: true }, {}, { concurrentBarrier: true }];
    for (const options of cases) {
      const f = fixture({ ...options, liveControllers: true });
      const results = await Promise.allSettled(options.concurrentBarrier
        ? [f.app.invoke(command), f.app.invoke(command)] : [f.app.invoke(command)]);
      expect(f.registrations.length).toBe(options.concurrentBarrier ? 2 : 1);
      if (options.claimError || options.permitError || options.responseWriteError) expect(results[0].status).toBe('rejected');
      else expect(results.every(result => result.status === 'fulfilled')).toBe(true);
      for (const claim of f.registrations) {
        // A leaked entry conflicts; also verify release never fabricates a cancellation signal.
        const registeredAgain = f.controllers.register(claim, 'runtime-owner');
        expect(registeredAgain.signal.aborted).toBe(false);
        registeredAgain.release();
      }
      expect(f.calls.sends).toBe(options.claimError || options.permitError || options.permission ? 0 : 1);
    }
  });

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
      expect(result.receipt.outcome).toMatchObject({ schemaVersion: 4, state: complete ? 'rejected' : 'unknown',
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
    const responded = Buffer.byteLength(JSON.stringify({ replayed: false, receipt: { ...receipt, outcome: { schemaVersion: 4,
      state: 'responded', content: descriptor, observedAtMs: Number.MAX_SAFE_INTEGER } }, response: null,
      contentStatus: 'retained', purge: null }), 'utf8') - 4 + 100;
    const evidenceDescriptor = { ...descriptor, kind: 'response-body', encoding: 'base64' };
    const summary = { schemaVersion: 1, adapter: profile.adapter, reason: 'response-limit', httpStatus: null,
      body: { encoding: 'base64', byteLength: Number.MAX_SAFE_INTEGER, observedBytes: Number.MAX_SAFE_INTEGER,
        complete: false, digest: 'f'.repeat(64) } };
    const partial = Buffer.byteLength(JSON.stringify({ replayed: false, receipt: { ...receipt, outcome: { schemaVersion: 4,
      state: 'unknown', reason: 'transport-error', evidence: summary, content: evidenceDescriptor,
      observedAtMs: Number.MAX_SAFE_INTEGER } }, response: null, contentStatus: 'retained', purge: null }), 'utf8');
    const notSent = Buffer.byteLength(JSON.stringify({ replayed: false, receipt: { ...receipt, outcome: { schemaVersion: 4, state: 'not-sent',
      reason: 'cancelled-before-permission', cancellationCommandId: String.fromCharCode(0xd800).repeat(IDENTITY_MAX_LENGTH),
      observedAtMs: Number.MAX_SAFE_INTEGER, content: null } }, response: null, contentStatus: 'not-captured', purge: null }), 'utf8');
    const required = Math.max(responded, partial, notSent), small = fixture({ responseBound: 100n });
    expect(required).toBe(notSent);
    await expect(small.app.invoke(command, undefined, undefined, { maxResultBytes: required - 1 })).rejects.toMatchObject({ code: 'MODEL_INVOCATION_RESULT_LIMIT' });
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
      schemaVersion: 1, kind: 'native-response', descriptor: historical.outcome!.content, response: first.response } : null,
    purge: null } });
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

});

describe('model invocation send permission', () => {

  it('never calls native HTTP when another owner holds permission or cancellation prevented it', async () => {
    const denied = fixture({ permission: 'denied' });
    await expect(denied.app.invoke(command)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_CORRUPT' });
    expect(denied.calls).toMatchObject({ claims: 1, permissions: 1, sends: 0 });
    const prevented = fixture({ permission: 'prevented' }), preventedResult = await prevented.app.invoke(command);
    expect(preventedResult).toMatchObject({ replayed: false, receipt: { outcome: { state: 'not-sent',
      reason: 'cancelled-before-permission', cancellationCommandId: 'cancel' } }, contentStatus: 'not-captured', purge: null });
    expect(prevented.calls).toMatchObject({ claims: 1, permissions: 1, sends: 0 });
  });

  it('rejects every false permission tuple except an exact prevented settlement without native HTTP', async () => {
    for (const permission of ['pending', 'prevented-claimed', 'forged-terminal'] as const) {
      const f = fixture({ permission });
      await expect(f.app.invoke(command)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_CORRUPT' });
      expect(f.calls).toMatchObject({ claims: 1, permissions: 1, sends: 0, closes: 1 });
    }
  });

  it('rejects a forged granted permission owner without calling native HTTP', async () => {
    const f = fixture({ permission: 'foreign-owner' });
    await expect(f.app.invoke(command)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_CORRUPT' });
    expect(f.calls).toMatchObject({ claims: 1, permissions: 1, sends: 0, closes: 1 });
  });

});

describe('model invocation application after permission', () => {

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

describe('model invocation content purge application', () => {
  const purgeCommand = { schemaVersion: 1 as const, commandId: 'purge-command', scopeId: 'scope', invocationId: 'invocation-1',
    reference, expectedContentDigest: 'a'.repeat(64) };
  function purgeFixture(options: { replayed?: boolean; deny?: boolean; substituteActor?: boolean } = {}) {
    let opens = 0, mutations = 0, closes = 0; const actions: string[] = [];
    const original = { schemaVersion: 1 as const, command: purgeCommand,
      actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance },
      authorization: { revision: 'historical', ruleId: 'purge-content' }, purgedAtMs: 4 };
    const app = new ModelInvocationPurgeApplication({ async verify() { return principal; } },
      { async authorize(action) { actions.push(action); if (options.deny) throw new Error('DENIED');
        return { revision: 'current', ruleId: 'purge-content' }; } }, async () => { opens++; return {
        async purgeContent(input: ModelInvocationPurgeAdmission): Promise<ModelInvocationPurgeResult> {
          mutations++;
          if (options.replayed) return { replayed: true, receipt: options.substituteActor
            ? { ...original, actor: { ...original.actor, id: 'foreign' } } : original };
          return { replayed: false, receipt: { schemaVersion: 1, ...input } };
        }, close() { closes++; },
      }; }, { now: () => 5 });
    return { app, actions, counts: () => ({ opens, mutations, closes }) };
  }

  it('authorizes before opening, reauthorizes before mutation, and exact-checks fresh and replayed audit receipts', async () => {
    const fresh = purgeFixture();
    expect(await fresh.app.purge(purgeCommand)).toMatchObject({ replayed: false,
      receipt: { command: purgeCommand, authorization: { revision: 'current' }, purgedAtMs: 5 } });
    expect(fresh.actions).toEqual(['purge-content', 'purge-content']);
    expect(fresh.counts()).toEqual({ opens: 1, mutations: 1, closes: 1 });
    const replay = purgeFixture({ replayed: true });
    expect(await replay.app.purge(purgeCommand)).toMatchObject({ replayed: true,
      receipt: { authorization: { revision: 'historical' }, purgedAtMs: 4 } });
    const forged = purgeFixture({ replayed: true, substituteActor: true });
    await expect(forged.app.purge(purgeCommand)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_CORRUPT' });
  });

  it('performs no store effect when policy or delivery capacity rejects the command', async () => {
    const denied = purgeFixture({ deny: true });
    await expect(denied.app.purge(purgeCommand)).rejects.toThrow('DENIED');
    expect(denied.counts()).toEqual({ opens: 0, mutations: 0, closes: 0 });
    const bounded = purgeFixture();
    await expect(bounded.app.purge(purgeCommand, undefined, { maxResultBytes: 1 }))
      .rejects.toMatchObject({ code: 'MODEL_INVOCATION_RESULT_LIMIT' });
    expect(bounded.counts()).toEqual({ opens: 1, mutations: 0, closes: 1 });
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
