import { expect, it } from 'vitest';
import { CORE_WORK_CLASSES, parseModelInvocationReceipt, modelInvocationRequestEvidence, resolveModelBindingDefinition, encodeModelBindingDefinition } from '#domain/index.js';
import { prepareBrainPrompt } from '#capabilities/index.js';
import { BrainPlanApplication, SameTurnPlanningApplication, brainRunId, type SameTurnPlanningPorts } from '#engine/core/run-planner/index.js';
import { modelInvocationRequestDigest, modelInvocationProfileDigest, createModelInvocationResponseRecord } from '#engine/core/model-invocation/index.js';
import { agentTurnResultDigest, agentToolArgumentsDigest, runDurableAgentTurn, AI_PROPOSAL_TOOL_SPECS, type AgentTurnStore } from '#engine/core/agent-turn/index.js';
import { assertRunProposalSource } from '#engine/core/run-proposal/index.js';
import { sha256, knownSecretValues, ErrorRegistry } from '#platform/index.js';
import { proposalFixture } from '../support/run-proposal.js';

function fixture(overrides: Partial<SameTurnPlanningPorts> = {}, proposeError?: unknown) {
  const proposal = proposalFixture(), principal = { ...proposal.proposer, assurance: 'os-user' as const, scopeIds: ['s'] };
  const reference = { providerId: 'test', providerVersion: 1, modelId: 'model', modelVersion: 1 };
  const definition = resolveModelBindingDefinition({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'test', version: 1,
    models: [{ id: 'model', version: 1, nativeId: 'native', protocols: [{ family: 'chat', version: '1', capabilities: [] }] }] }] }, reference)!;
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: sha256(encodeModelBindingDefinition(definition)) };
  const invocation = { schemaVersion: 1 as const, commandId: 'chat', scopeId: 's', reference, catalogRevision: 'catalog', expectedBinding: binding, nativeRequest: {} };
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 's', reference, bindingDigest: binding.digest,
    protocol: { family: 'chat', version: '1' }, adapter: { id: 'adapter', version: 1, definition: {} }, allocation: { id: 'allocation', maxCalls: 1, maxInFlight: 1 },
    limits: { requestMaxBytes: 131072, responseMaxBytes: 131072, timeoutMs: 1000 } };
  const requestDigest = modelInvocationRequestDigest(invocation), profileDigest = modelInvocationProfileDigest(profile);
  const claimed = parseModelInvocationReceipt({ schemaVersion: 4, request: modelInvocationRequestEvidence(invocation, requestDigest), actor: { ...proposal.proposer, assurance: principal.assurance },
    authorization: { revision: 'policy', ruleId: 'invoke' }, definition, activationRevision: 1, profile, profileDigest,
    claim: { scopeId: 's', commandId: 'chat', invocationId: 'invocation', requestDigest, profileDigest }, claimedAtMs: 1, outcome: null });
  const command = { schemaVersion: 1 as const, commandId: 'plan', scopeId: 's', intent: 'prepare a purchase' };
  const prompt = prepareBrainPrompt(command, CORE_WORK_CLASSES, {}, {});
  const { graph, budgetCeiling, requiredPermissions } = proposal;
  const draft = ' \n' + JSON.stringify({ graph, budgetCeiling, requiredPermissions }) + '\t\n';
  const record = createModelInvocationResponseRecord(claimed, { schemaVersion: 1, native: { text: draft }, usage: null }, 2);
  const retained = { replayed: false, receipt: record.receipt, response: record.content!.kind === 'native-response' ? record.content!.response : null,
    contentStatus: 'retained' as const, purge: null };
  let proposals = 0, randomCalls = 0, reads = 0;
  const brain = new BrainPlanApplication({ verify: async () => principal }, { inspect: async () => null, prepare: async () => { throw new Error('SECOND_PREPARE'); },
    invoke: async () => { throw new Error('SECOND_CALL'); }, stoppedAtLength: () => false, text: result => result.response?.native['text'] as string ?? null,
    propose: async value => { assertRunProposalSource(value, retained.receipt, draft); proposals++;
      expect(value.source.kind).toBe('model'); expect(value.runId).toBe(brainRunId(command));
      if (proposeError) throw proposeError; return { proposal: { proposal: value } } as never; } });
  const planning = new SameTurnPlanningApplication(brain, { randomBytes: size => { randomCalls++; return new Uint8Array(size).fill(0xaa); },
    projectDelivery: value => value, toolResultDigest: agentTurnResultDigest, text: result => result.response?.native['text'] as string ?? null,
    readResult: async () => { reads++; return retained; }, revalidate: async input => input,
    publicText: 'Preparing the plan', ...overrides });
  const pin = planning.claimed(invocation, claimed);
  planning.bindNativeSession(pin, 'session');
  const input = { command, prepared: { invocation, prompt, kinds: ['purchase'] }, config: {},
    settings: { cap: { value: null, origin: 'brain-default' as const }, reasoning: { value: 'model-default' as const, origin: 'brain-default' as const }, applied: null },
    call: { turnId: 'turn', generation: 1, callId: 'prepare', argsDigest: agentToolArgumentsDigest('propose_work', { request: 'prepare a purchase' }) },
    bounds: { preparationMaxBytes: 131072, draftMaxBytes: 131072 } };
  const settle = async () => {
    const envelope = await planning.prepare(pin, input), content = envelope.outcome.text;
    const custody = { ...input.call, content, bytes: Buffer.byteLength(content), resultDigest: agentTurnResultDigest(content) };
    planning.preparationSettled(pin, custody); planning.preparationDelivered(pin, envelope);
    return { envelope, custody };
  };
  const terminal = () => planning.terminalEnvelope(pin, { ...input.call, messageId: 'final', sessionId: 'session', parentId: null,
    line: 'DECKENT-PLAN-CHALLENGE/1 ' + 'aa'.repeat(32), draft });
  const close = () => planning.nativeClosed(pin, { state: 'normal', closed: true, drained: true });
  return { planning, pin, input, claimed, invocation, retained, draft, settle, terminal, close, counts: () => ({ proposals, randomCalls, reads }) };
}

it('keeps one immutable preparation, binds durable settlement before delivery, and finalizes the exact retained D once', async () => {
  const f = fixture(), first = f.planning.prepare(f.pin, f.input), replay = f.planning.prepare(f.pin, f.input);
  expect(replay).toBe(first);
  const { envelope } = await f.settle();
  expect(await first).toBe(envelope); expect(f.counts().randomCalls).toBe(1);
  expect(f.planning.privateResult('prepare', envelope.outcome.text)?.publicText).toBe('Preparing the plan');
  expect(f.terminal()).toBe(f.draft); f.close(); expect(f.planning.responseBody(f.pin, f.draft)).toBe(f.draft);
  const one = f.planning.finalize(f.pin, f.retained), two = f.planning.finalize(f.pin, f.retained);
  expect(two).toBe(one); expect(await two).toBe(await one);
  expect(f.counts()).toEqual({ proposals: 1, randomCalls: 1, reads: 1 });
});

it('refuses delivery before the durable settlement and never repairs the closed candidate', async () => {
  const f = fixture(), envelope = await f.planning.prepare(f.pin, f.input);
  expect(() => f.planning.preparationDelivered(f.pin, envelope)).toThrow(expect.objectContaining({ code: 'BRAIN_SAME_TURN_REFUSED' }));
  await expect(f.planning.prepare(f.pin, f.input)).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
  expect(f.counts()).toEqual({ proposals: 0, randomCalls: 1, reads: 0 });
});

it('refuses a foreign pin, a receipt replay and a different second proposal without generating a new token', async () => {
  const foreign = fixture();
  await expect(foreign.planning.prepare(Object.freeze({}) as typeof foreign.pin, foreign.input)).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
  const replay = fixture();
  expect(() => new SameTurnPlanningApplication({} as never, {} as never).claimed(replay.invocation, replay.retained.receipt))
    .toThrow(expect.objectContaining({ code: 'BRAIN_SAME_TURN_REFUSED' }));
  const second = fixture(); await second.planning.prepare(second.pin, second.input);
  await expect(second.planning.prepare(second.pin, { ...second.input, command: { ...second.input.command, intent: 'different purchase' } }))
    .rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
  expect(second.counts().randomCalls).toBe(1); expect(second.counts().proposals).toBe(0);
});

it('refuses a changed preparation content, byte count, result digest, call, arguments, turn or generation before delivery', async () => {
  const mutations = [ { content: 'token added after record' }, { bytes: 0 }, { resultDigest: sha256('foreign') },
    { callId: 'foreign' }, { argsDigest: sha256('foreign') }, { turnId: 'foreign' }, { generation: 2 } ];
  for (const mutation of mutations) {
    const f = fixture(), result = await f.planning.prepare(f.pin, f.input), content = result.outcome.text;
    const custody = { ...f.input.call, content, bytes: Buffer.byteLength(content), resultDigest: agentTurnResultDigest(content), ...mutation };
    expect(() => f.planning.preparationSettled(f.pin, custody)).toThrow(expect.objectContaining({ code: 'BRAIN_SAME_TURN_REFUSED' }));
    expect(f.counts().proposals).toBe(0);
  }
});

it('refuses wrong delivery and terminal identity/token bindings instead of using timestamps or a token-selected pin', async () => {
  const wrongDelivery = fixture(), { envelope } = await wrongDelivery.settle();
  expect(() => wrongDelivery.planning.preparationDelivered(wrongDelivery.pin, { ...envelope, deckentCallId: 'foreign' }))
    .toThrow(expect.objectContaining({ code: 'BRAIN_SAME_TURN_REFUSED' }));
  for (const mutation of [{ line: 'DECKENT-PLAN-CHALLENGE/1 ' + 'bb'.repeat(32) }, { sessionId: 'foreign' }, { parentId: 'subagent' },
    { messageId: '' }, { callId: 'foreign' }, { argsDigest: sha256('foreign') }, { turnId: 'foreign' }, { generation: 2 }]) {
    const f = fixture(); await f.settle();
    expect(() => f.planning.terminalEnvelope(f.pin, { ...f.input.call, sessionId: 'session', messageId: 'final', parentId: null,
      line: 'DECKENT-PLAN-CHALLENGE/1 ' + 'aa'.repeat(32), draft: f.draft, ...mutation }))
      .toThrow(expect.objectContaining({ code: 'BRAIN_SAME_TURN_REFUSED' }));
    expect(f.counts().proposals).toBe(0);
  }
});

it('rejects preparation redaction conflicts, additional tools, duplicate terminal envelopes and framing/JSON repair', async () => {
  const redacted = fixture({ projectDelivery: result => ({ ...result, outcome: { ...result.outcome, text: '[REDACTED]' } }) });
  await expect(redacted.planning.prepare(redacted.pin, redacted.input)).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
  const collision = fixture({ knownSecrets: knownSecretValues(['aa'.repeat(32)]) });
  await expect(collision.planning.prepare(collision.pin, collision.input)).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
  expect(collision.counts().randomCalls).toBe(1);
  const extraTool = fixture(); await extraTool.settle();
  expect(() => extraTool.planning.beforeTool('another-tool', sha256('args'))).toThrow(expect.objectContaining({ code: 'BRAIN_SAME_TURN_REFUSED' }));
  const duplicate = fixture(); await duplicate.settle(); duplicate.terminal();
  expect(duplicate.terminal).toThrow(expect.objectContaining({ code: 'BRAIN_SAME_TURN_REFUSED' }));
  for (const transform of [(d: string) => '```json\n' + d + '\n```', (d: string) => d + '{}', (d: string) => d + ' explanation',
    (d: string) => d.replace('Durable business evidence', 'aa'.repeat(32))]) {
    const f = fixture(); await f.settle();
    expect(() => { f.planning.terminalEnvelope(f.pin, { ...f.input.call, sessionId: 'session', messageId: 'final', parentId: null,
      line: 'DECKENT-PLAN-CHALLENGE/1 ' + 'aa'.repeat(32), draft: transform(f.draft) }); f.close(); })
      .toThrow(expect.objectContaining({ code: 'BRAIN_SAME_TURN_REFUSED' }));
  }
});

it('preserves configured-secret redaction for raw and JSON-escaped draft values before retention', async () => {
  for (const encoded of ['private-password-value', '\\u0070rivate-password-value']) {
    const f = fixture({ knownSecrets: knownSecretValues(['private-password-value']) }); await f.settle();
    expect(() => { f.planning.terminalEnvelope(f.pin, { ...f.input.call, sessionId: 'session', messageId: 'final', parentId: null,
      line: 'DECKENT-PLAN-CHALLENGE/1 ' + 'aa'.repeat(32), draft: f.draft.replace('Durable business evidence', encoded) }); f.close(); })
      .toThrow(expect.objectContaining({ code: 'BRAIN_SAME_TURN_REFUSED' }));
  }
});

it('treats every Brain numeric cap origin equally, refuses unknown origin and never turns inherited terminal policy into a Brain requirement', async () => {
  for (const origin of ['person', 'project', 'company', 'brain-default'] as const) {
    const f = fixture();
    await expect(f.planning.prepare(f.pin, { ...f.input, config: { maxCompletionTokens: 8 },
      settings: { ...f.input.settings, cap: { value: 8, origin } } })).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED', params: { reason: 'settings-mismatch' } });
    expect(f.counts().randomCalls).toBe(0);
  }
  for (const setting of ['cap', 'reasoning'] as const) {
    const f = fixture();
    await expect(f.planning.prepare(f.pin, { ...f.input, settings: { ...f.input.settings,
      [setting]: { ...f.input.settings[setting], origin: 'unknown' } } })).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
  }
  const off = fixture();
  await expect(off.planning.prepare(off.pin, { ...off.input, config: { reasoning: 'off' }, settings: { ...off.input.settings,
    reasoning: { value: 'off', origin: 'person' } } })).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
  // An inherited terminal cap is in the actual invocation, not the Brain settings. It grants no native token guarantee.
  const f = fixture(), invocation = { ...f.invocation, nativeRequest: { max_completion_tokens: 8 } };
  const requestDigest = modelInvocationRequestDigest(invocation);
  const claimed = { ...f.claimed, request: modelInvocationRequestEvidence(invocation, requestDigest), claim: { ...f.claimed.claim, requestDigest } };
  const inherited = new SameTurnPlanningApplication({} as never, { randomBytes: size => new Uint8Array(size), projectDelivery: value => value,
    toolResultDigest: agentTurnResultDigest, readResult: async () => f.retained, text: () => f.draft, revalidate: async input => input, publicText: 'Preparing the plan' });
  const pin = inherited.claimed(invocation, claimed);
  await expect(inherited.prepare(pin, { ...f.input, prepared: { ...f.input.prepared, invocation } })).resolves.toMatchObject({ outcome: { status: 'ok' } });
});

it('refuses finalization on valid JSON with length, cancellation, failure or unknown/incomplete native close', async () => {
  for (const finish of [{ state: 'length' as const, closed: true, drained: true }, { state: 'cancelled' as const, closed: true, drained: true },
    { state: 'failed' as const, closed: true, drained: true }, { state: 'unknown' as const, closed: true, drained: true },
    { state: 'normal' as const, closed: false, drained: true }, { state: 'normal' as const, closed: true, drained: false }]) {
    const f = fixture(); await f.settle(); f.terminal();
    expect(() => f.planning.nativeClosed(f.pin, finish)).toThrow(expect.objectContaining({ code: 'BRAIN_SAME_TURN_REFUSED' }));
    await expect(f.planning.finalize(f.pin, f.retained)).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
    expect(f.counts().proposals).toBe(0);
  }
});

it('checks outer/Brain byte bounds including framing and refuses a selected body that is changed in retention/readback', async () => {
  const projected = fixture(); await projected.settle(); projected.terminal(); projected.close();
  expect(() => projected.planning.responseBody(projected.pin, projected.draft.trim())).toThrow(expect.objectContaining({ code: 'BRAIN_SAME_TURN_REFUSED' }));
  const tooBig = fixture();
  await expect(tooBig.planning.prepare(tooBig.pin, { ...tooBig.input, bounds: { ...tooBig.input.bounds, preparationMaxBytes: 1 } }))
    .rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
  const bounded = fixture(); await bounded.planning.prepare(bounded.pin, { ...bounded.input, bounds: { ...bounded.input.bounds, draftMaxBytes: Buffer.byteLength(bounded.draft) } });
  // D alone fits; the challenge line also counts.
  const input = { ...bounded.input, bounds: { ...bounded.input.bounds, draftMaxBytes: Buffer.byteLength(bounded.draft) } };
  const result = await bounded.planning.prepare(bounded.pin, input), content = result.outcome.text;
  bounded.planning.preparationSettled(bounded.pin, { ...input.call, content, bytes: Buffer.byteLength(content), resultDigest: agentTurnResultDigest(content) });
  bounded.planning.preparationDelivered(bounded.pin, result);
  expect(bounded.terminal).toThrow(expect.objectContaining({ code: 'BRAIN_SAME_TURN_REFUSED' }));
  const changed = fixture(); await changed.settle(); changed.terminal(); changed.close();
  await expect(changed.planning.finalize(changed.pin, { ...changed.retained, response: { ...changed.retained.response!, native: { text: changed.draft.trim() } } }))
    .rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
  const store = fixture({ readResult: async () => ({ ...changed.retained, contentStatus: 'purged', purge: null }) }); await store.settle(); store.terminal(); store.close();
  await expect(store.planning.finalize(store.pin, store.retained)).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
});

it('closes on final settings/context drift, parent cancellation and lost pin, keeping uncertain admission on the SAME rejected promise', async () => {
  let rechecks = 0;
  const drift = fixture({ revalidate: async input => ++rechecks === 1 ? input : { ...input, prepared: { ...input.prepared,
    prompt: { ...input.prepared.prompt, contextDigest: sha256('different context') } } } });
  await drift.settle(); drift.terminal(); drift.close();
  await expect(drift.planning.finalize(drift.pin, drift.retained)).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
  const cancelled = fixture(); await cancelled.settle(); cancelled.terminal(); cancelled.close(); const abort = new AbortController(); abort.abort();
  await expect(cancelled.planning.finalize(cancelled.pin, cancelled.retained, abort.signal)).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
  const lost = fixture(); await lost.settle(); lost.terminal(); lost.close(); lost.planning.abandon(lost.pin, 'completion-unknown');
  await expect(lost.planning.finalize(lost.pin, lost.retained)).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
  const unknown = fixture({}, ErrorRegistry.createError('RUN_PROPOSAL_OUTCOME_UNKNOWN')); await unknown.settle(); unknown.terminal(); unknown.close();
  const first = unknown.planning.finalize(unknown.pin, unknown.retained); await expect(first).rejects.toMatchObject({ code: 'RUN_PROPOSAL_OUTCOME_UNKNOWN' });
  const again = unknown.planning.finalize(unknown.pin, unknown.retained); expect(again).toBe(first);
  await expect(again).rejects.toMatchObject({ code: 'RUN_PROPOSAL_OUTCOME_UNKNOWN' }); expect(unknown.counts().proposals).toBe(1);
});

it('refuses actor/scope/call/request/model/binding/activation/profile substitution in the retained source', async () => {
  for (const mutate of [
    (r: ReturnType<typeof fixture>['retained']['receipt']) => ({ ...r, actor: { ...r.actor, subject: 'foreign' } }),
    (r: ReturnType<typeof fixture>['retained']['receipt']) => ({ ...r, request: { ...r.request, scopeId: 'foreign' } }),
    (r: ReturnType<typeof fixture>['retained']['receipt']) => ({ ...r, claim: { ...r.claim, invocationId: 'foreign' } }),
    (r: ReturnType<typeof fixture>['retained']['receipt']) => ({ ...r, request: { ...r.request, requestDigest: sha256('foreign') } }),
    (r: ReturnType<typeof fixture>['retained']['receipt']) => ({ ...r, request: { ...r.request, reference: { ...r.request.reference, modelVersion: 2 } } }),
    (r: ReturnType<typeof fixture>['retained']['receipt']) => ({ ...r, request: { ...r.request, expectedBinding: { ...r.request.expectedBinding, digest: sha256('foreign') } } }),
    (r: ReturnType<typeof fixture>['retained']['receipt']) => ({ ...r, activationRevision: r.activationRevision + 1 }),
    (r: ReturnType<typeof fixture>['retained']['receipt']) => ({ ...r, profile: { ...r.profile, version: r.profile.version + 1 } }),
    (r: ReturnType<typeof fixture>['retained']['receipt']) => {
      if (r.outcome?.state !== 'responded') throw new Error('fixture');
      return { ...r, outcome: { ...r.outcome, content: { ...r.outcome.content, digest: sha256('foreign retained content') } } };
    },
  ]) {
    const f = fixture(); await f.settle(); f.terminal(); f.close();
    await expect(f.planning.finalize(f.pin, { ...f.retained, receipt: mutate(f.retained.receipt) })).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
    expect(f.counts().proposals).toBe(0);
  }
});

it('does not turn any incomplete crash interval or a lost pin into a proposal by reading a later receipt', async () => {
  for (const stage of ['claimed', 'prepared', 'settled', 'delivered', 'terminal', 'response-unknown', 'pin-lost'] as const) {
    const f = fixture();
    if (stage !== 'claimed') {
      const result = await f.planning.prepare(f.pin, f.input), content = result.outcome.text;
      if (stage !== 'prepared') {
        f.planning.preparationSettled(f.pin, { ...f.input.call, content, bytes: Buffer.byteLength(content), resultDigest: agentTurnResultDigest(content) });
        if (stage !== 'settled') f.planning.preparationDelivered(f.pin, result);
      }
    }
    if (['terminal', 'response-unknown', 'pin-lost'].includes(stage)) f.terminal();
    if (stage === 'response-unknown' || stage === 'pin-lost') f.close();
    if (stage === 'pin-lost') f.planning.abandon(f.pin, 'completion-unknown');
    const retained = stage === 'response-unknown' ? { ...f.retained, receipt: f.claimed } : f.retained;
    await expect(f.planning.finalize(f.pin, retained)).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
    expect(f.counts()).toMatchObject({ proposals: 0, reads: 0 });
  }
});

it('uses the production durable turn to withhold native release until P is recorded and keeps P/D out of public sinks', async () => {
  for (const { failedWrite, unknownAdmission } of [{ failedWrite: false, unknownAdmission: false }, { failedWrite: true, unknownAdmission: false }, { failedWrite: false, unknownAdmission: true }]) {
    const f = fixture({}, unknownAdmission ? ErrorRegistry.createError('RUN_PROPOSAL_OUTCOME_UNKNOWN') : undefined), events: unknown[] = [], trace: string[] = [], signal = new AbortController().signal;
    let release!: () => void, started!: () => void, released = false, privateP = '';
    const barrier = new Promise<void>(resolve => { release = resolve; }), recording = new Promise<void>(resolve => { started = resolve; });
    const tool = AI_PROPOSAL_TOOL_SPECS.find(tool => tool.name === 'propose_work')!, tools = [tool];
    const store: AgentTurnStore = { claim: async () => ({ status: 'new' }), finish: async () => undefined,
      interruptRunning: async () => ({ interrupted: 0, corrupt: [] }),
      recordToolCall: async record => {
        expect(record.bytes).toBe(Buffer.byteLength(privateP)); expect(record.resultDigest).toBe(agentTurnResultDigest(privateP));
        trace.push('write-start'); started(); await barrier;
        if (failedWrite) throw new Error('COMMIT_UNKNOWN'); trace.push('write-durable');
      } };
    const running = runDurableAgentTurn({ messages: [{ role: 'user', content: 'prepare a purchase' }], tools, signal, language: 'en',
      nativeSession: { schemaVersion: 1, turnId: 'turn', generation: 1, tools, approvalTtlMs: 1000 },
      claim: { scopeId: 's', turnId: 'turn', principalKey: 'test:owner', requestDigest: sha256('turn-request'), claimedAtMs: 1 }, emit: event => events.push(event) }, store,
    { planning: f.planning, now: () => 1, describe: () => null, authorize: async () => 'allow', invokeRound: async () => { throw new Error('SECOND_MODEL'); },
      execute: async () => { const result = await f.planning.prepare(f.pin, f.input); privateP = result.outcome.text; return result.outcome; },
      settled: async record => { expect(record.content).toBe('Preparing the plan'); expect(trace).toContain('write-durable'); trace.push('observer'); },
      invokeAgent: async ({ session }, onDelta) => {
        expect(session.planning).toBe(f.planning);
        const call = { id: 'prepare', name: tool.name, argumentsJson: '{"request":"prepare a purchase"}' };
        const result = await session.propose(call, { kind: 'codex-mcp', deckentCallId: call.id, callId: 'rpc', itemId: 'item' }, signal);
        released = true; trace.push('native-release');
        if (failedWrite) return { status: 'failed', state: 'unknown' };
        f.planning.preparationDelivered(f.pin, result); f.terminal(); f.close();
        onDelta({ kind: 'text', text: 'DECKENT-PLAN-CHALLENGE/1 ' + 'aa'.repeat(32) + '\n' + f.draft });
        return { status: 'responded', content: f.draft, reasoning: '', finish: 'stop', toolCalls: [], usage: null };
      },
      finishPlanning: async parent => { trace.push('finalize'); await f.planning.finalize(f.pin, f.retained, parent); return 'Prepared plan'; },
    });
    await recording; expect(released).toBe(false); expect(f.counts().proposals).toBe(0);
    expect(JSON.stringify(events)).not.toContain('aa'.repeat(32)); release();
    const outcome = await running;
    expect(JSON.stringify(events)).not.toContain('aa'.repeat(32)); expect(JSON.stringify(events)).not.toContain(f.draft);
    expect(outcome.finish).toBe(failedWrite || unknownAdmission ? 'error' : 'stop'); expect(f.counts().proposals).toBe(failedWrite ? 0 : 1);
    if (unknownAdmission) expect(outcome.note).toBe(ErrorRegistry.get('RUN_PROPOSAL_OUTCOME_UNKNOWN', 'en')!.message);
    if (!failedWrite) expect(trace).toEqual(['write-start', 'write-durable', 'observer', 'native-release', 'finalize']);
  }
});
