import { expect, it, vi } from 'vitest';
import { CORE_WORK_CLASSES, parseModelInvocationReceipt, modelInvocationRequestEvidence, resolveModelBindingDefinition, encodeModelBindingDefinition, type AgentTurnEvent, type AgentTurnMessage } from '#domain/index.js';
import { prepareBrainPrompt, selectedBrainTemplate, type SameTurnToolSessionPort } from '#capabilities/index.js';
import { BrainPlanApplication, brainRunId, type SameTurnPlanningPorts } from '#engine/core/run-planner/index.js';
import { modelInvocationRequestDigest, modelInvocationProfileDigest, createModelInvocationResponseRecord } from '#engine/core/model-invocation/index.js';
import { agentTurnResultDigest, agentToolArgumentsDigest, runDurableAgentTurn, AI_PROPOSAL_TOOL_SPECS, type AgentTurnStore, type AgentTurnPorts } from '#engine/core/agent-turn/index.js';
import { assertRunProposalSource } from '#engine/core/run-proposal/index.js';
import { sha256, knownSecretValues, ErrorRegistry } from '#platform/index.js';
import { proposalFixture } from '../support/run-proposal.js';

function fixture(overrides: Partial<SameTurnPlanningPorts> = {}, proposeError?: unknown, config = {},
  { beforeVerify, beforeBudget, beforeProposalSettles }: { beforeVerify?: () => Promise<void>; beforeBudget?: () => Promise<void>;
    beforeProposalSettles?: () => Promise<void> } = {}) {
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
  const prompt = prepareBrainPrompt(command, CORE_WORK_CLASSES, {}, config);
  const { graph, budgetCeiling, requiredPermissions } = proposal;
  const draft = ' \n' + JSON.stringify({ graph, budgetCeiling, requiredPermissions }) + '\t\n';
  const record = createModelInvocationResponseRecord(claimed, { schemaVersion: 1, native: { text: draft }, usage: null }, 2);
  const retained = { replayed: false, receipt: record.receipt, response: record.content!.kind === 'native-response' ? record.content!.response : null,
    contentStatus: 'retained' as const, purge: null };
  let proposals = 0, randomCalls = 0;
  const readResult = vi.fn<SameTurnPlanningPorts['readResult']>(overrides.readResult ?? (async () => ({ ...retained, replayed: true })));
  const revalidate = vi.fn<SameTurnPlanningPorts['revalidate']>(overrides.revalidate ?? (async input => input));
  const brain = new BrainPlanApplication({ verify: async () => { if (beforeVerify) await beforeVerify(); return principal; } }, {
    inspect: async () => null, prepare: async () => { throw new Error('SECOND_PREPARE'); },
    invoke: async () => { throw new Error('SECOND_CALL'); }, stoppedAtLength: () => false, text: result => result.response?.native['text'] as string ?? null,
    ...(beforeBudget && { remainingBudget: async () => { await beforeBudget(); return null; } }),
    propose: async value => { assertRunProposalSource(value, retained.receipt, draft); proposals++;
      expect(value.source.kind).toBe('model'); expect(value.runId).toBe(brainRunId(command));
      if (beforeProposalSettles) await beforeProposalSettles();
      if (proposeError) throw proposeError; return { proposal: { proposal: value } } as never; } });
  const planning = brain.createSameTurnPlanning({ randomBytes: size => { randomCalls++; return new Uint8Array(size).fill(0xaa); },
    projectDelivery: value => value, toolResultDigest: agentTurnResultDigest, text: result => result.response?.native['text'] as string ?? null,
    publicText: 'Preparing the plan', ...overrides, readResult, revalidate });
  const pin = planning.claimed(invocation, claimed);
  planning.bindNativeSession(pin, 'session');
  const input = { command, prepared: { invocation, prompt, kinds: ['purchase'] }, config,
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
  return { brain, planning, pin, input, claimed, invocation, retained, draft, settle, terminal, close, readResult, revalidate,
    counts: () => ({ proposals, randomCalls, reads: readResult.mock.calls.length }) };
}

function productionTurn(f: ReturnType<typeof fixture>, invokeAgent: NonNullable<AgentTurnPorts['invokeAgent']>,
  options: { parent?: AbortController; completionLimitTokens?: number; priorEffectUnknown?: boolean } = {}) {
  const events: AgentTurnEvent[] = [], executions: string[] = [], targets: string[] = [], records: string[] = [];
  let finalizers = 0, history: readonly AgentTurnMessage[] = [];
  const tools = [AI_PROPOSAL_TOOL_SPECS.find(tool => tool.name === 'propose_work')!,
    { name: 'read_item', version: 1, toolClass: 'read' as const, description: 'Read an item.',
      inputSchema: { type: 'object' as const, required: ['path'], properties: { path: { type: 'string' } } } },
    { name: 'write_item', version: 1, toolClass: 'edit' as const, description: 'Write an item.',
      inputSchema: { type: 'object' as const, required: ['path'], properties: { path: { type: 'string' } } } }];
  const store: AgentTurnStore = { claim: async () => ({ status: 'new' }), finish: async () => undefined,
    interruptRunning: async () => ({ interrupted: 0, corrupt: [] }), recordToolCall: async record => { records.push(record.callId); } };
  const running = runDurableAgentTurn({ messages: [{ role: 'user', content: 'prepare a purchase' }], tools, signal: (options.parent ?? new AbortController()).signal, language: 'en',
    ...(options.completionLimitTokens === undefined ? {} : { admission: { outputReserveTokens: 0, safetyReserveTokens: 0, completionLimitTokens: options.completionLimitTokens } }),
    nativeSession: { schemaVersion: 1, turnId: 'turn', generation: 1, tools, approvalTtlMs: 1000 },
    claim: { scopeId: 's', turnId: 'turn', principalKey: 'test:owner', requestDigest: sha256('turn-request'), claimedAtMs: 1 }, emit: event => events.push(event) }, store,
  { planning: f.planning, now: () => 1, describe: (_tool, args) => { if (typeof args['path'] !== 'string') return null; targets.push(args['path']); return args['path']; },
    authorize: async () => 'allow', invokeRound: async () => { throw new Error('SECOND_MODEL'); },
    execute: async (tool, _args, _signal, callId) => { executions.push(callId); return tool.name === 'propose_work'
      ? (await f.planning.prepare(f.pin, f.input)).outcome : tool.name === 'write_item' && options.priorEffectUnknown
        ? { status: 'error', text: 'Item effect unknown' } : { status: 'ok', text: 'Item read' }; },
    invokeAgent: (input, delta, signal) => { history = input.messages; return invokeAgent(input, delta, signal); },
    finishPlanning: async signal => { finalizers++; await f.planning.finalize(f.pin, f.retained, signal); return 'Prepared plan'; } });
  return { running, events, executions, targets, records, history: () => history, finalizers: () => finalizers };
}
const prepareCall = { id: 'prepare', name: 'propose_work', argumentsJson: '{"request":"prepare a purchase"}' };
const correlation = (id: string) => ({ kind: 'codex-mcp' as const, deckentCallId: id, callId: `rpc-${id}`, itemId: `item-${id}` });
const normalAnswer = (content: string) => ({ status: 'responded' as const, content, reasoning: '', finish: 'stop', toolCalls: [], usage: null });

it('refuses post-preparation requests before publication, including earlier cache hits and already queued calls, but replays preparation', async () => {
  for (const mode of ['new', 'earlier-replay', 'queued', 'preparation-replay'] as const) {
    const f = fixture();
    let refusedStatus = '', privateP = '';
    const earlier = { id: 'earlier', name: 'read_item', argumentsJson: '{"path":"previous-item"}' };
    const queued = { id: 'after', name: 'read_item', argumentsJson: '{"path":"queued-private-plan"}' };
    const p = productionTurn(f, async ({ session }, _delta, signal) => {
      if (mode === 'earlier-replay') expect((await session.propose(earlier, correlation(earlier.id), signal)).outcome.status).toBe('ok');
      const preparation = session.propose(prepareCall, correlation(prepareCall.id), signal);
      // Both requests enter before the preparation starts; the second must be checked again when its queue entry runs.
      const waiting = mode === 'queued' ? session.propose(queued, correlation(queued.id), signal) : null;
      const result = await preparation; privateP = result.outcome.text;
      if (waiting) { refusedStatus = (await waiting).outcome.status; return normalAnswer(f.draft); }
      f.planning.preparationDelivered(f.pin, result);
      const call = mode === 'earlier-replay' ? earlier : mode === 'preparation-replay' ? prepareCall
        : { id: 'after', name: 'read_item', argumentsJson: JSON.stringify({ path: privateP + f.draft }) };
      const repeated = await session.propose(call, correlation(call.id), signal); refusedStatus = repeated.outcome.status;
      if (mode === 'preparation-replay') { expect(repeated).toBe(result); f.terminal(); f.close(); }
      return normalAnswer(f.draft);
    });
    const outcome = await p.running, allowed = mode === 'preparation-replay';
    const afterMessages = p.history().filter(message => message.role === 'assistant' && message.toolCalls.some(call => call.id === 'after'));
    const afterEvents = p.events.filter(event => (event.kind === 'tool.started' || event.kind === 'tool.finished') && event.callId === 'after');
    const observed = { mode, refusedStatus, afterMessages: afterMessages.length, afterEvents: afterEvents.length,
      targets: p.targets.length, executions: p.executions, records: p.records, proposals: f.counts().proposals, finalizers: p.finalizers() };
    process.stdout.write(`${JSON.stringify(observed)}\n`);
    expect.soft(afterMessages).toHaveLength(0); expect.soft(afterEvents).toHaveLength(0);
    expect.soft(JSON.stringify(p.history())).not.toContain('aa'.repeat(32)); expect.soft(JSON.stringify(p.events)).not.toContain('aa'.repeat(32));
    expect.soft(JSON.stringify(p.history())).not.toContain(f.draft); expect.soft(JSON.stringify(p.events)).not.toContain(f.draft);
    expect.soft(p.history().some(message => message.content.includes(f.draft))).toBe(false);
    expect.soft(JSON.stringify(p.events)).not.toContain('queued-private-plan');
    expect.soft(p.targets).toEqual(mode === 'earlier-replay' ? ['previous-item'] : []);
    expect.soft(p.executions).toEqual(mode === 'earlier-replay' ? ['earlier', 'prepare'] : ['prepare']);
    expect.soft(p.records).toEqual(p.executions); expect.soft(refusedStatus).toBe(allowed ? 'ok' : 'error');
    expect.soft(f.counts()).toMatchObject({ proposals: allowed ? 1 : 0, randomCalls: 1 }); expect.soft(outcome.finish).toBe(allowed ? 'stop' : 'error');
  }
});

it('frames temporary preparation for a legacy template, retaining its identity and the whole-P bounds/redaction/settlement', async () => {
  const config = { selected: { id: 'run-proposal', version: 1 } }, f = fixture({}, undefined, config);
  const { envelope, custody } = await f.settle(), content = envelope.outcome.text;
  expect(content).toContain('copy the first line of this preparation result exactly at byte zero, then one LF and exactly one BrainDraft JSON object');
  expect(content).toContain('Call no more tools and write no other text.');
  expect(content).toContain(JSON.stringify(f.input.prepared.prompt.messages));
  expect(custody).toMatchObject({ content, bytes: Buffer.byteLength(content), resultDigest: agentTurnResultDigest(content) });
  expect(f.input.prepared.prompt.template).toEqual(prepareBrainPrompt(f.input.command, CORE_WORK_CLASSES, {}, config).template);
  f.terminal(); f.close(); await f.planning.finalize(f.pin, f.retained); expect(f.counts().proposals).toBe(1);
  const exact = fixture({}, undefined, config);
  await expect(exact.planning.prepare(exact.pin, { ...exact.input, bounds: { ...exact.input.bounds,
    preparationMaxBytes: Buffer.byteLength(JSON.stringify(envelope)) } })).resolves.toEqual(envelope);
  const short = fixture({}, undefined, config);
  await expect(short.planning.prepare(short.pin, { ...short.input, bounds: { ...short.input.bounds,
    preparationMaxBytes: Buffer.byteLength(JSON.stringify(envelope)) - 1 } })).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
  const redaction = fixture({ knownSecrets: knownSecretValues(['copy the first line of this preparation result']) }, undefined, config);
  await expect(redaction.planning.prepare(redaction.pin, redaction.input)).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
});

it('keeps the separate Brain invocation on its unchanged authored plain-JSON instruction', async () => {
  const f = fixture(), prompt = f.input.prepared.prompt;
  let sends = 0, proposals = 0;
  const brain = new BrainPlanApplication({ verify: async () => ({ ...f.claimed.actor, scopeIds: ['s'] }) }, {
    inspect: async () => null, prepare: async () => ({ ...f.input.prepared, invocation: { ...f.invocation, nativeRequest: { messages: prompt.messages } } }),
    invoke: async invocation => {
      sends++; expect(invocation.nativeRequest['messages']).toEqual(prompt.messages);
      expect(prompt.messages[0]!.content).toBe(selectedBrainTemplate({}).instruction);
      expect(prompt.messages[0]!.content).toContain('Return exactly one JSON object conforming to the supplied schema, without Markdown or tools.');
      expect(prompt.messages[0]!.content.endsWith('Otherwise return plain JSON as above.')).toBe(true);
      expect(JSON.stringify(invocation.nativeRequest)).not.toContain('copy the first line of this preparation result');
      const requestDigest = modelInvocationRequestDigest(invocation), claimed = { ...f.claimed, request: modelInvocationRequestEvidence(invocation, requestDigest),
        claim: { ...f.claimed.claim, commandId: invocation.commandId, requestDigest } };
      const record = createModelInvocationResponseRecord(claimed, { schemaVersion: 1, native: { text: f.draft }, usage: null }, 2);
      return { ...f.retained, receipt: record.receipt, response: record.content!.kind === 'native-response' ? record.content!.response : null };
    }, text: () => f.draft, stoppedAtLength: () => false, propose: async () => { proposals++; return {} as never; } });
  await brain.plan(f.input.command); expect({ sends, proposals }).toEqual({ sends: 1, proposals: 1 });
});

it('distinguishes normal completion at the chat threshold from contradictory completion before finalization', async () => {
  for (const contradiction of ['length', 'provider-stop', 'unknown-finish', 'missing-k2-close', 'normal-at-threshold', 'parent-cancel'] as const) {
    const f = fixture(), parent = new AbortController();
    const p = productionTurn(f, async ({ session }, _delta, signal) => {
      const result = await session.propose(prepareCall, correlation(prepareCall.id), signal);
      f.planning.preparationDelivered(f.pin, result); f.terminal();
      if (contradiction !== 'missing-k2-close') f.close();
      if (contradiction === 'parent-cancel') parent.abort();
      return { ...normalAnswer(f.draft), finish: contradiction === 'length' ? 'length' : contradiction === 'unknown-finish' ? 'unknown' : 'stop',
        usage: { promptTokens: 1, completionTokens: 8 },
        ...(contradiction === 'provider-stop' ? { providerStop: 'context-window' as const } : {}) };
    }, { parent, completionLimitTokens: 8 });
    const outcome = await p.running;
    process.stdout.write(`${JSON.stringify({ contradiction, finalizers: p.finalizers(), proposals: f.counts().proposals, finish: outcome.finish })}\n`);
    const normal = contradiction === 'normal-at-threshold';
    expect.soft(p.finalizers()).toBe(normal ? 1 : 0); expect.soft(f.counts().proposals).toBe(normal ? 1 : 0);
    expect.soft(outcome.finish).toBe(normal ? 'stop' : contradiction === 'parent-cancel' ? 'cancelled' : 'error');
    expect.soft(JSON.stringify(p.events)).not.toContain(f.draft); expect.soft(JSON.stringify(p.history())).not.toContain(f.draft);
  }
});

it('closes an active candidate and session on invalid correlation without publishing or executing the refused call, preserving prior uncertain effects', async () => {
  for (const priorEffectUnknown of [false, true]) {
    const f = fixture();
    let sessionPort!: SameTurnToolSessionPort;
    const p = productionTurn(f, async ({ session }, _delta, signal) => {
      sessionPort = session;
      if (priorEffectUnknown) expect((await session.propose({ id: 'prior', name: 'write_item', argumentsJson: '{"path":"previous-item"}' }, correlation('prior'), signal)).outcome.status).toBe('error');
      const result = await session.propose(prepareCall, correlation(prepareCall.id), signal);
      f.planning.preparationDelivered(f.pin, result);
      const refused = await session.propose({ id: 'invalid', name: 'write_item', argumentsJson: '{"path":"unpublished-item"}' }, correlation('foreign'), signal);
      expect.soft(refused.outcome).toMatchObject({ status: 'error', text: '[deckent] error=tool-correlation-invalid' });
      expect.soft(signal.aborted).toBe(true);
      expect.soft((await session.propose(prepareCall, correlation(prepareCall.id), signal)).outcome.text).toContain('tool-session-closed');
      expect.soft(() => { f.terminal(); f.close(); }).toThrow(expect.objectContaining({ code: 'BRAIN_SAME_TURN_REFUSED' }));
      return normalAnswer(f.draft);
    }, { priorEffectUnknown });
    const outcome = await p.running, closed = await sessionPort.cancel();
    const publications = p.events.filter(event => ((event.kind === 'tool.started' || event.kind === 'tool.finished') && event.callId === 'invalid')
      || (event.kind === 'message' && event.message.role === 'assistant' && event.message.toolCalls.some(call => call.id === 'invalid')));
    process.stdout.write(`${JSON.stringify({ priorEffectUnknown, finalizers: p.finalizers(), proposals: f.counts().proposals,
      publications: publications.length, executions: p.executions, records: p.records, effects: closed.effects, finish: outcome.finish })}\n`);
    expect.soft(publications).toHaveLength(0); expect.soft(JSON.stringify(p.history())).not.toContain('unpublished-item');
    expect.soft(JSON.stringify(p.events)).not.toContain('unpublished-item'); expect.soft(p.targets).toEqual(priorEffectUnknown ? ['previous-item'] : []);
    expect.soft(p.executions).toEqual(priorEffectUnknown ? ['prior', 'prepare'] : ['prepare']); expect.soft(p.records).toEqual(p.executions);
    expect.soft(p.finalizers()).toBe(0); expect.soft(f.counts().proposals).toBe(0); expect.soft(outcome.finish).toBe('error');
    expect.soft(closed).toMatchObject({ pendingCallIds: [], effects: priorEffectUnknown ? 'unknown' : 'settled', termination: 'unverified' });
  }
});

it('keeps one immutable preparation, binds durable settlement before delivery, and finalizes the exact retained D once', async () => {
  const f = fixture(), first = f.planning.prepare(f.pin, f.input), replay = f.planning.prepare(f.pin, f.input);
  expect(f.brain).not.toHaveProperty('completeSameTurn');
  expect(f.planning).not.toHaveProperty('complete');
  expect(replay).toBe(first);
  const { envelope } = await f.settle();
  expect(await first).toBe(envelope); expect(f.counts().randomCalls).toBe(1);
  expect(f.planning.privateResult('prepare', envelope.outcome.text)?.publicText).toBe('Preparing the plan');
  expect(f.terminal()).toBe(f.draft); f.close(); expect(f.planning.responseBody(f.pin, f.draft)).toBe(f.draft);
  const one = f.planning.finalize(f.pin, f.retained), two = f.planning.finalize(f.pin, f.retained);
  expect(two).toBe(one); expect(await two).toBe(await one);
  expect(f.counts()).toEqual({ proposals: 1, randomCalls: 1, reads: 1 });
  expect(f.readResult).toHaveBeenCalledWith(f.retained.receipt, expect.any(Function));
  expect(f.readResult.mock.calls[0]![1]()).toBe(false);
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
  expect(() => replay.brain.createSameTurnPlanning({} as never).claimed(replay.invocation, replay.retained.receipt))
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
  const inherited = f.brain.createSameTurnPlanning({ randomBytes: size => new Uint8Array(size), projectDelivery: value => value,
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

it('makes a denied, missing or mismatched durable readback a sticky refusal before any further planning port', async () => {
  for (const [scenario, read] of Object.entries({
    'unverified chat person': () => { throw new Error('unverified chat person'); },
    'missing content permission': () => { throw new Error('missing content permission'); },
    'missing result': () => null as never,
    'foreign invocation id': (r: ReturnType<typeof fixture>['retained']) => ({ ...r, receipt: { ...r.receipt,
      claim: { ...r.receipt.claim, invocationId: 'foreign' } } }),
    'foreign request digest': (r: ReturnType<typeof fixture>['retained']) => ({ ...r, receipt: { ...r.receipt,
      request: { ...r.receipt.request, requestDigest: sha256('foreign request') } } }),
    'purged result': (r: ReturnType<typeof fixture>['retained']) => ({ ...r, contentStatus: 'purged' as const, response: null }),
    'uncaptured result': (r: ReturnType<typeof fixture>['retained']) => ({ ...r, contentStatus: 'not-captured' as const, response: null }),
    'replay with different bytes': (r: ReturnType<typeof fixture>['retained']) => ({ ...r, replayed: true, response: {
      ...r.response!, native: { text: String(r.response!.native['text']).trim() } } }),
  })) {
    const f = fixture({ readResult: async (): ReturnType<SameTurnPlanningPorts['readResult']> => read(f.retained) });
    await f.settle(); f.terminal(); f.close();
    const first = f.planning.finalize(f.pin, f.retained);
    const refusal = { code: 'BRAIN_SAME_TURN_REFUSED', params: { reason: 'completion-unknown' } };
    await expect.soft(first, scenario).rejects.toMatchObject(refusal);
    expect(f.planning.finalize(f.pin, f.retained), scenario).toBe(first);
    await expect.soft(f.planning.prepare(f.pin, f.input), scenario).rejects.toMatchObject(refusal);
    expect(f.revalidate, scenario).toHaveBeenCalledTimes(1);
    expect(f.counts(), scenario).toEqual({ proposals: 0, randomCalls: 1, reads: 1 });
  }
});

it('discards durable readback if the person cancels or the pin is abandoned during the read', async () => {
  for (const interruption of ['cancel-then-return', 'cancel-then-reject', 'abandon'] as const) {
    const parent = new AbortController();
    const f = fixture({ readResult: async (_receipt, isCurrent): ReturnType<SameTurnPlanningPorts['readResult']> => {
      expect(isCurrent()).toBe(true);
      await Promise.resolve();
      if (interruption === 'abandon') f.planning.abandon(f.pin, 'completion-unknown');
      else parent.abort();
      expect(isCurrent()).toBe(false);
      if (interruption === 'cancel-then-reject') throw new Error('reader interrupted');
      return f.retained;
    } });
    await f.settle(); f.terminal(); f.close();
    const first = f.planning.finalize(f.pin, f.retained, parent.signal);
    const refusal = { code: 'BRAIN_SAME_TURN_REFUSED', params: { reason: interruption === 'abandon' ? 'completion-unknown' : 'cancelled' } };
    await expect.soft(first, interruption).rejects.toMatchObject(refusal);
    expect(f.planning.finalize(f.pin, f.retained), interruption).toBe(first);
    await expect.soft(f.planning.prepare(f.pin, f.input), interruption).rejects.toMatchObject(refusal);
    expect(f.revalidate, interruption).toHaveBeenCalledTimes(1);
    expect(f.counts(), interruption).toEqual({ proposals: 0, randomCalls: 1, reads: 1 });
  }
});

it.each(['identity verification', 'budget read'] as const)('stops the unsent proposal when the pin is abandoned during %s', async stage => {
  const parent = new AbortController();
  const abandonWhileWaiting = async () => {
    await Promise.resolve();
    f.planning.abandon(f.pin, 'completion-unknown');
  };
  const f = fixture({}, undefined, {}, stage === 'identity verification' ? { beforeVerify: abandonWhileWaiting } : { beforeBudget: abandonWhileWaiting });
  await f.settle(); f.terminal(); f.close();
  const first = f.planning.finalize(f.pin, f.retained, parent.signal);
  await expect.soft(first).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED', params: { reason: 'completion-unknown' } });
  expect(parent.signal.aborted).toBe(false);
  expect(f.planning.finalize(f.pin, f.retained, parent.signal)).toBe(first);
  expect(f.counts()).toEqual({ proposals: 0, randomCalls: 1, reads: 1 });
});

it('settles a proposal already sent when the pin is abandoned using the same promise', async () => {
  const parent = new AbortController();
  let started!: () => void, release!: () => void;
  const sending = new Promise<void>(resolve => { started = resolve; });
  const writing = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({}, undefined, {}, { beforeProposalSettles: () => { started(); return writing; } });
  await f.settle(); f.terminal(); f.close();
  const first = f.planning.finalize(f.pin, f.retained, parent.signal);
  await sending;
  f.planning.abandon(f.pin, 'completion-unknown');
  const again = f.planning.finalize(f.pin, f.retained, parent.signal);
  release();
  expect(again).toBe(first);
  await expect(again).resolves.toMatchObject({ proposal: { proposal: { runId: brainRunId(f.input.command) } } });
  expect(parent.signal.aborted).toBe(false);
  expect(f.counts()).toEqual({ proposals: 1, randomCalls: 1, reads: 1 });
});

it('finalizes the verified answer after the reader mutates its shared response', async () => {
  const changed = 'changed after comparison';
  const f = fixture({ readResult: async (): ReturnType<SameTurnPlanningPorts['readResult']> => ({
    ...f.retained, response: sharedResponse, replayed: true,
  }) }, undefined, {}, { beforeVerify: async () => {
    await Promise.resolve();
    Object.assign(sharedResponse.native, { text: changed });
  } });
  const sharedResponse = { ...f.retained.response!, native: { ...f.retained.response!.native } };
  await f.settle(); f.terminal(); f.close();
  await expect.soft(f.planning.finalize(f.pin, f.retained)).resolves.toMatchObject({ proposal: { proposal: { runId: brainRunId(f.input.command) } } });
  expect(sharedResponse.native['text']).toBe(changed);
  expect(f.counts()).toEqual({ proposals: 1, randomCalls: 1, reads: 1 });
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
    (r: ReturnType<typeof fixture>['retained']['receipt']) => {
      if (r.outcome?.state !== 'responded') throw new Error('fixture');
      return { ...r, outcome: { ...r.outcome, content: { ...r.outcome.content, byteLength: r.outcome.content.byteLength + 1 } } };
    },
  ]) {
    const f = fixture(); await f.settle(); f.terminal(); f.close();
    await expect(f.planning.finalize(f.pin, { ...f.retained, receipt: mutate(f.retained.receipt) })).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
    expect(f.counts().proposals).toBe(0);
    expect(f.readResult).not.toHaveBeenCalled();
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
