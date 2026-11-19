import { request as httpRequest } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { CORE_WORK_CLASSES, encodeModelBindingDefinition, modelInvocationRequestEvidence, parseModelInvocationReceipt,
  parseModelInvocationProfile, type ModelInvocationNativeResponse } from '#domain/index.js';
import { prepareBrainPrompt, type SameTurnToolSessionPort } from '#capabilities/index.js';
import { BrainPlanApplication } from '#engine/core/run-planner/index.js';
import { createModelInvocationResponseRecord, modelInvocationProfileDigest, modelInvocationRequestDigest, type ModelInvocationResult } from '#engine/core/model-invocation/index.js';
import { agentToolArgumentsDigest, agentTurnResultDigest } from '#engine/core/agent-turn/index.js';
import { createNativeAgentDriver, createClaudeAgentDriver, codexAgentTurn, nativeAgentFlagSetDigest, preflightNativeAgent, runHeadlessIsolated } from '#adapters/core/native-cli-headless/index.js';
import { createNativeToolBridge } from '#adapters/core/native-tool-bridge/index.js';
import { nativeQuotaPolicy, openNativeEgressGateway } from '#adapters/core/native-connection/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { EMPTY_KNOWN_SECRETS, knownSecretValues, sha256 } from '#platform/index.js';
import { connection, cleanupConnections, binding as fixtureBinding } from '../../fixtures/native-headless/connection.js';
import registry from '../../../assets/native-coding/commands.json' with { type: 'json' };

vi.mock('#adapters/core/native-cli-headless/internal/realm.js', async importOriginal => ({
  ...await importOriginal<typeof import('#adapters/core/native-cli-headless/internal/realm.js')>(), runHeadlessIsolated: vi.fn(),
}));
vi.mock('#adapters/core/native-cli-headless/internal/agent-observation.js', async importOriginal => ({
  ...await importOriginal<typeof import('#adapters/core/native-cli-headless/internal/agent-observation.js')>(), preflightNativeAgent: vi.fn(), recordNativeAgentObservation: vi.fn(),
}));
afterEach(async () => { vi.clearAllMocks(); await cleanupConnections(); });

type Cli = 'codex' | 'claude';
// Use distinct RPC ids for retransmissions of the same correlated call.
async function bridgeClient(port: SameTurnToolSessionPort, entry: NonNullable<ReturnType<typeof nativeCliAgent>>, directory: string) {
  const b = entry.bridge;
  const bridge = await createNativeToolBridge({ port, bridge: b, correlationKind: entry.agent.transport.kind === 'codex-mcp' ? 'codex-mcp' : 'claude-tool-use',
    limits: { idleMs: 5000, maxConnections: b.maxConnections!, replayMaxEntries: b.replayMaxEntries!, replayMaxBytes: b.replayMaxBytes! } });
  const gateway = await openNativeEgressGateway({ provider: entry.id, directory, mcp: bridge });
  let session = '';
  const send = (id: number, method: string, params: unknown) => new Promise<string>((resolve, reject) => {
    const req = httpRequest({ socketPath: gateway.socketPath, path: bridge.url, method: 'POST', agent: false,
      headers: { host: bridge.sentinelHost, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        [b.tokenHeaderName]: bridge.tokenHeader, ...(session ? { 'mcp-session-id': session } : {}) } }, response => {
      session ||= String(response.headers['mcp-session-id']);
      let body = '';
      response.on('data', chunk => { body += String(chunk); }); response.on('error', reject);
      response.on('end', () => { if (response.statusCode === 200) resolve(body); else reject(new Error('fixture transport status ' + response.statusCode)); });
    });
    req.on('error', reject); req.end(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  let id = 1;
  const request = async (params: unknown) => {
    if (!session) await send(id++, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    const body = await send(id++, 'tools/call', params);
    return JSON.parse(body.split('\n').find(line => line.startsWith('data: '))!.slice(6)).result;
  };
  const answer = async (params: unknown) => {
    const result = await request(params);
    expect(result.isError).toBe(false);
    return result.content[0].text as string;
  };
  let last: unknown;
  return { bridge, request, repeat: () => answer(last), call(params: unknown) { last = params; return answer(params); },
    async close() { await gateway.close(); await bridge.close(); } };
}

async function recording(cli: Cli, mode: string) {
  const dir = new URL('../../fixtures/same-turn-planning/' + cli + '/recorded/', import.meta.url);
  const read = (file: string) => readFile(new URL(file, dir), 'utf8');
  const meta = JSON.parse(await read('manifest.json')), custody = JSON.parse((await read('custody.jsonl')).split('\n')[0]!);
  const wire = (await read('stdout.jsonl')).trimEnd().split('\n').map(line => JSON.parse(line));
  let framed = (cli === 'codex' ? wire.at(-2).item.text : wire.at(-1).result) as string;
  const terminal = cli === 'codex' ? wire.at(-2).item : wire.at(-2).message.content[0];
  const finish = wire.at(-1);
  if (mode === 'whitespace-D') {
    framed = framed.replace('\n', '\n \n') + '\t\n';
    terminal.text = framed;
    if (cli === 'claude') finish.result = framed;
  }
  if (mode === 'extra-json') {
    terminal.text += '{}';
    if (cli === 'claude') finish.result = terminal.text;
  }
  if (mode === 'middle') terminal.text = 'prefix' + framed;
  if (mode === 'suffix') terminal.text = framed.split('\n').reverse().join('\n');
  if (mode === 'wrong-token') terminal.text = framed.replace(/ [a-f0-9]{64}/, ' ' + '0'.repeat(64));
  const terminalIndex = wire.length - 2;
  if (mode === 'stitched' || mode === 'same-id-blocks') {
    const continuation = structuredClone(wire[terminalIndex]), cut = framed.indexOf('\n') + 1;
    terminal.text = framed.slice(0, cut);
    if (cli === 'codex') { continuation.item.id += '-later'; continuation.item.text = framed.slice(cut); }
    else {
      if (mode === 'stitched') continuation.message.id += '-later';
      continuation.message.content[0].text = framed.slice(cut);
    }
    wire.splice(terminalIndex + 1, 0, continuation);
  }
  if (mode === 'unknown-start') {
    if (cli === 'codex') wire.splice(2, 1);
    else delete wire[1].message.id;
  }
  if (mode === 'late-turn-conflict' || mode === 'late-turn-match') {
    wire[terminalIndex].turn_id = 'local-turn';
    finish.turn_id = mode === 'late-turn-conflict' ? 'other-turn' : 'local-turn';
  }
  if (mode === 'conflicting-thread') finish.thread_id = 'foreign-thread';
  if (mode === 'stderr-truncated') meta.process.stderrTruncated = true;
  if (mode === 'error-finish') {
    if (cli === 'codex') finish.type = 'turn.failed'; else finish.is_error = true;
  }
  if (mode === 'no-final') wire.splice(terminalIndex, 1);
  if (mode === 'missing-finish') wire.pop();
  if (mode === 'second-message') {
    const second = structuredClone(wire[terminalIndex]);
    if (cli === 'codex') second.item.id += '-another'; else second.message.id += '-another';
    wire.splice(terminalIndex + 1, 0, second);
  }
  if (cli === 'codex' && mode === 'old-start') wire.splice(3, 0, { type: 'item.started', item: { type: 'agent_message', id: wire[terminalIndex].item.id } });
  if (cli === 'claude') {
    if (mode === 'old-start') wire[terminalIndex].message.id = wire[1].message.id;
    if (mode === 'wrong-role') wire[terminalIndex].message.role = 'user';
    if (mode === 'assistant-length') wire[terminalIndex].message.stop_reason = 'max_tokens';
    if (mode === 'wrong-session') finish.session_id += '-other';
    if (mode === 'wrong-result') finish.result += ' ';
    if (mode === 'unknown-stop') finish.stop_reason = null;
    if (mode === 'length') finish.stop_reason = 'max_tokens';
    if (mode === 'nested') wire[terminalIndex].parent_tool_use_id = 'different-parent';
    if (mode === 'error-result') wire[3].message.content[0].is_error = true;
  } else if (mode === 'length') finish.finish_reason = 'length';
  if (mode === 'extra-tool') {
    const extra = structuredClone(cli === 'codex' ? wire[4] : wire[1]);
    if (cli === 'codex') extra.item.id += '-new'; else extra.message.content[0].id += '-new';
    wire.splice(terminalIndex, 0, extra);
  }
  const observed = cli === 'codex' ? wire.find(e => e.item?.result)?.item.result.content[0] : wire.find(e => e.type === 'user')?.message.content[0].content[0];
  expect(JSON.parse(observed.text)).toEqual(custody.result);
  expect(agentTurnResultDigest(custody.P)).toBe(custody.resultDigest);
  const draft = framed.slice(framed.indexOf('\n') + 1);
  return { meta, custody, wire, framed, draft };
}

async function replay(cli: Cli, mode: string) {
  const { meta, custody, wire, framed, draft } = await recording(cli, mode);
  const family = cli === 'claude' ? registry.adapters.claude.capabilities.eventStream : registry.adapters.codex.headless.protocolFamily, entry = nativeCliAgent(family)!;
  const binding = { ...fixtureBinding, model: { ...fixtureBinding.model, nativeId: meta.nativeModel, protocols: [{ family, version: 'v1', capabilities: [] }] } };
  const digest = sha256(encodeModelBindingDefinition(binding)), c = await connection({}, {}, digest);
  const profile = parseModelInvocationProfile({ ...c.profile, protocol: { family, version: 'v1' } });
  const request = { model: meta.nativeModel, messages: [{ role: 'system', content: 'Prepare' }, { role: 'user', content: 'Purchase' }] };
  const invocation = { schemaVersion: 1 as const, commandId: 'chat', scopeId: profile.scopeId, reference: profile.reference,
    catalogRevision: 'catalog', expectedBinding: { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest }, nativeRequest: request };
  const requestDigest = modelInvocationRequestDigest(invocation), profileDigest = modelInvocationProfileDigest(profile);
  const actor = { id: 'owner', issuer: 'test', subject: 'owner', assurance: 'os-user' as const };
  const claimed = parseModelInvocationReceipt({ schemaVersion: 4, request: modelInvocationRequestEvidence(invocation, requestDigest), actor,
    authorization: { revision: 'policy', ruleId: 'invoke' }, definition: binding, activationRevision: 1, profile, profileDigest,
    claim: { scopeId: profile.scopeId, commandId: 'chat', invocationId: 'one-call', requestDigest, profileDigest }, claimedAtMs: 1, outcome: null });
  const command = { schemaVersion: 1 as const, commandId: 'plan', scopeId: profile.scopeId, intent: 'prepare a purchase' };
  const extract = (r: ModelInvocationResult) => (r.response?.native['choices'] as { message: { content: string } }[] | undefined)?.[0]?.message.content ?? null;
  let retained: ModelInvocationResult;
  const unreachable = () => { throw new Error('unexpected second model path'); };
  const proposals: string[] = [];
  const brain = new BrainPlanApplication({ verify: async () => ({ ...actor, scopeIds: [profile.scopeId] }) }, {
    inspect: async () => null, prepare: unreachable, invoke: unreachable, stoppedAtLength: () => false, text: extract,
    propose: async proposal => { proposals.push(proposal.runId); return { proposal: { proposal } } as never; },
  });
  const useBridge = mode === 'bridge-replay' || mode === 'bridge-earlier';
  const entropy = useBridge ? createNativeAgentDriver.planningEntropy : { randomBytes: () => Buffer.from(framed.split('\n')[0]!.split(' ')[1]!, 'hex') };
  let preparations = 0, responses = 0, reads = 0;
  const planning = brain.createSameTurnPlanning({ ...entropy,
    publicText: 'Preparing', toolResultDigest: agentTurnResultDigest, revalidate: async input => input, readResult: async () => retained, text: extract });
  const prepareTool = { name: 'propose_work', toolClass: 'read' as const, version: 1, description: 'Prepare', inputSchema: { type: 'object' as const, properties: {} } };
  const session: SameTurnToolSessionPort = { planning, session: { schemaVersion: 1, turnId: custody.turnId, generation: custody.generation, approvalTtlMs: 5000,
    tools: mode === 'bridge-earlier' ? [prepareTool, { ...prepareTool, name: 'read_item', description: 'Read item' }] : [prepareTool] },
    checkResultDelivery(call) {
      try { planning.beforeTool(call.id, agentToolArgumentsDigest(call.name, JSON.parse(call.argumentsJson))); return true; }
      catch { return false; }
    },
    cancel: unreachable, revoke: unreachable, async propose(call) {
      if (call.name === 'read_item') {
        reads++;
        return { schemaVersion: 1, turnId: custody.turnId, generation: custody.generation, deckentCallId: call.id, outcome: { status: 'ok', text: 'earlier-item' } };
      }
      preparations++;
      const identity = { turnId: custody.turnId, generation: custody.generation, callId: call.id, argsDigest: agentToolArgumentsDigest(call.name, JSON.parse(call.argumentsJson)) };
      const result = await planning.prepare(planning.pin!, { command, prepared: { invocation, prompt: prepareBrainPrompt(command, CORE_WORK_CLASSES, {}, {}), kinds: ['purchase'] },
        config: {}, settings: { cap: { value: null, origin: 'brain-default' }, reasoning: { value: 'model-default', origin: 'brain-default' }, applied: null },
        call: identity, bounds: { preparationMaxBytes: 65536, draftMaxBytes: 65536 } });
      const content = result.outcome.text;
      if (mode !== 'unsettled') planning.preparationSettled(planning.pin!, { ...identity, content, bytes: Buffer.byteLength(content), resultDigest: agentTurnResultDigest(content) });
      return result;
    } };
  const definition = c.profile.adapter.definition, flagSetDigest = nativeAgentFlagSetDigest(entry);
  const execution = { schemaVersion: 1 as const, capability: 'NativeAgentExecution' as const, executable: c.executable, cliVersion: meta.version, ownerUid: process.getuid!(), profileDigest, flagSetDigest };
  vi.mocked(preflightNativeAgent).mockResolvedValue({ execution, preflight: { executable: c.executable, version: meta.version, flagSetDigest } } as Awaited<ReturnType<typeof preflightNativeAgent>>);
  await mkdir(definition['stateDir'] as string);
  const notices: unknown[] = [];
  const driver = createNativeAgentDriver({ profile, execution, session, isolation: unreachable, now: Date.now, onPaidUsage: async notice => { notices.push(notice); } });
  const client = useBridge ? await bridgeClient(driver.port, entry, c.root) : undefined;
  const native = driver.native(client?.bridge ?? ({ ...entry.bridge, turnToken: '~fixture-only', url: 'http://' + entry.bridge.sentinelHost + entry.bridge.path } as Parameters<typeof driver.native>[0]),
    { configured: mode === 'redacted-D' ? knownSecretValues(['Durable business readback'])
      : mode === 'stream-redaction' ? knownSecretValues(['}private-fixture-suffix']) : EMPTY_KNOWN_SECRETS, turn: client?.bridge.known ?? EMPTY_KNOWN_SECRETS });
  const prepared = await native.prepare(profile, binding, request);
  const pin = planning.claimed(invocation, claimed);
  native.claimed?.(claimed);
  const delivery = vi.spyOn(planning, 'preparationDelivered'), closed = vi.spyOn(planning, 'nativeClosed'), body = vi.spyOn(planning, 'responseBody');
  const deltas: string[] = [];
  vi.mocked(runHeadlessIsolated).mockImplementationOnce(async (_entry, _isolation, spawn, _bounds, signal, line) => {
    let actual = '', challengeLine = '', stopped = false, called = false;
    const earlier = { name: 'read_item', arguments: {}, _meta: { callId: 'read-call', itemId: 'read-item' } };
    for (const event of wire) {
      if (event.subtype === 'init') event.cwd = spawn.runDir;
      if (challengeLine) {
        const rebind = (text: string) => challengeLine + text.slice(text.indexOf('\n'));
        if (event.item?.type === 'agent_message') event.item.text = rebind(event.item.text);
        if (event.type === 'assistant') for (const block of event.message.content) if (block.type === 'text') block.text = rebind(block.text);
        if (event.type === 'result') event.result = rebind(event.result);
      }
      let raw = JSON.stringify(event);
      // Rebind W to current custody. The host-entropy variation also echoes its new challenge, always with the recorded D.
      if (actual && mode !== 'original') raw = raw.replaceAll(JSON.stringify(JSON.stringify(custody.result)), () => JSON.stringify(actual));
      if (await line!(raw, signal!) === 'stop') { stopped = true; break; }
      if (client && mode === 'bridge-earlier' && event.type === 'turn.started') {
        const item = { id: 'read-item', type: 'mcp_tool_call', server: entry.bridge.serverName, tool: earlier.name, arguments: earlier.arguments };
        expect(await line!(JSON.stringify({ type: 'item.started', item: { ...item, status: 'in_progress' } }), signal!)).toBeUndefined();
        const result = await client.request(earlier);
        expect(JSON.parse(result.content[0].text).outcome).toEqual({ status: 'ok', text: 'earlier-item' });
        expect(await line!(JSON.stringify({ type: 'item.completed', item: { ...item, status: 'completed', result } }), signal!)).toBeUndefined();
      }
      if (client && (event.type === 'user' || event.item?.result)) {
        if (mode === 'bridge-earlier') {
          const repeated = await client.request(earlier);
          expect.soft(repeated.isError).toBe(true);
          expect.soft(JSON.parse(repeated.content[0].text).outcome).toEqual({ status: 'error', text: 'BRAIN_SAME_TURN_REFUSED' });
        } else {
          expect(delivery).toHaveBeenCalledTimes(1);
          expect(await client.repeat()).toBe(actual);
          expect(delivery).toHaveBeenCalledTimes(1);
        }
      }
      const tool = cli === 'codex' ? event.type === 'item.started' && event.item.type === 'mcp_tool_call' && event.item : event.message?.content?.find((b: { type: string }) => b.type === 'tool_use');
      if (tool && !called) {
        called = true;
        const args = tool.arguments ?? tool.input;
        expect(agentToolArgumentsDigest('propose_work', args)).toBe(custody.argsDigest);
        if (client) {
          const _meta = cli === 'codex' ? { callId: custody.correlation.callId, itemId: custody.correlation.itemId } : { 'claudecode/toolUseId': tool.id };
          actual = await client.call({ name: 'propose_work', arguments: args, _meta });
          challengeLine = JSON.parse(actual).outcome.text.split('\n')[0];
        } else {
          const result = await driver.port.propose({ id: custody.callId, name: 'propose_work', argumentsJson: JSON.stringify(args) }, custody.correlation, signal!);
          actual = JSON.stringify(mode === 'wrong-W' ? { ...result, outcome: { ...result.outcome, text: result.outcome.text + ' ' } }
            : mode === 'failed-W' ? { ...result, outcome: { ...result.outcome, status: 'error' } } : result);
        }
      }
    }
    return { ...meta.process, started: true, reason: stopped ? 'stopped' : mode === 'cancel' ? 'cancelled' : mode === 'disconnect' ? 'signal' : 'exit',
      exitCode: mode === 'exit' ? 1 : meta.process.exitCode, stdoutTruncated: mode === 'truncated', limit: mode === 'limit' ? 'cpu' : null };
  });
  try {
    const result = await native.send(prepared, undefined, d => { if (planning.active) deltas.push(d.text); });
    if ('native' in result) {
      responses++;
      expect(closed).toHaveBeenCalledTimes(1);
      expect(body).toHaveBeenCalledTimes(1);
      expect(closed.mock.invocationCallOrder[0]!).toBeLessThan(body.mock.invocationCallOrder[0]!);
      const record = createModelInvocationResponseRecord(claimed, result as ModelInvocationNativeResponse, 2);
      retained = { replayed: false, receipt: record.receipt, response: result, contentStatus: 'retained', purge: null };
      await planning.finalize(pin, retained);
    }
    return { proposals, deltas, responses, preparations, reads, deliveries: delivery.mock.calls.length, selected: retained! && extract(retained), draft };
  } catch (error) {
    if (!['BRAIN_SAME_TURN_REFUSED', 'HEADLESS_OUTCOME_UNKNOWN'].includes((error as { code?: string }).code ?? (error as Error).message)) throw error;
    return { proposals, deltas, responses, preparations, reads, deliveries: delivery.mock.calls.length, selected: null, draft, failure: (error as Error).message };
  } finally {
    if (mode === 'stream-redaction') {
      expect(body).toHaveBeenCalledTimes(1);
      expect(body.mock.calls[0]?.[1]).not.toBe(draft);
    }
    const publicFacts = JSON.stringify([driver.notices(), driver.refusalCheck(), notices, deltas]);
    expect(publicFacts).not.toContain(framed.split('\n')[0]!.split(' ')[1]);
    expect(publicFacts).not.toContain(draft);
    await client?.close(); await driver.close();
  }
}
it('binds K1 preparation to the recorded terminal message and finalizes the exact recorded draft on both drivers', async () => {
  for (const cli of ['codex', 'claude'] as const) {
    for (const mode of ['current-custody', 'bridge-replay', 'whitespace-D', ...(cli === 'claude' ? ['same-id-blocks'] : [])]) {
      const result = await replay(cli, mode);
      expect(result.preparations).toBe(1);
      expect(result.proposals).toHaveLength(1);
      expect(result.selected).toBe(result.draft);
      expect(result.deltas).toEqual([]);
    }
  }
});

it('refuses an earlier cached tool result at the bridge before it can reach the active planning turn', async () => {
  const result = await replay('codex', 'bridge-earlier');
  expect(result).toMatchObject({ reads: 1, preparations: 1, deliveries: 1, responses: 0, proposals: [] });
});

it('binds the first local Codex turn id even when it arrives after turn.started', async () => {
  const conflict = await replay('codex', 'late-turn-conflict');
  expect.soft(conflict.responses).toBe(0);
  expect.soft(conflict.proposals).toHaveLength(0);
  for (const mode of ['late-turn-match', 'current-custody']) {
    const accepted = await replay('codex', mode);
    expect(accepted.proposals).toHaveLength(1);
    expect(accepted.selected).toBe(accepted.draft);
  }
});

it('closes planning on stale identity, foreign delivery, ambiguous framing and incomplete protocol or process evidence', async () => {
  for (const cli of ['codex', 'claude'] as const) {
    for (const mode of ['original', 'unsettled', 'wrong-W', 'failed-W', 'redacted-D', 'stream-redaction', 'extra-json', 'unknown-start', 'stitched', 'error-finish', 'stderr-truncated', 'no-final', 'old-start', 'second-message', 'middle', 'suffix', 'wrong-token', 'extra-tool',
      'length', 'exit', 'cancel', 'disconnect', 'limit', 'truncated', 'missing-finish', ...(cli === 'claude' ? ['wrong-session', 'wrong-result', 'unknown-stop', 'nested', 'error-result', 'wrong-role', 'assistant-length'] : ['conflicting-thread'])]) {
      const result = await replay(cli, mode);
      expect(result.responses, cli + '/' + mode).toBe(0);
      expect(result.proposals, cli + '/' + mode).toHaveLength(0);
      expect(result.deltas, cli + '/' + mode).toEqual([]);
    }
  }
});

it('observes the literal masked recording envelope and terminal identity in each native wire reader', async () => {
  for (const cli of ['codex', 'claude'] as const) {
    const { meta, custody, wire, framed } = await recording(cli, 'original');
    const entry = nativeCliAgent(cli === 'codex' ? registry.adapters.codex.headless.protocolFamily : registry.adapters.claude.capabilities.eventStream)!;
    let active = false, delivered = false;
    const observe = { get active() { return active; }, get delivered() { return delivered; }, session: vi.fn(),
      delivery(envelope: unknown) { expect(envelope).toEqual(custody.result); delivered = true; }, replay: vi.fn(),
      terminal: vi.fn(), response: () => framed };
    const session = { schemaVersion: 1 as const, turnId: custody.turnId as string, generation: 1, approvalTtlMs: 5000,
      tools: [{ name: 'propose_work', version: 1, toolClass: 'read' as const, description: 'Prepare', inputSchema: { type: 'object' as const, properties: {} } }] };
    const stop = () => { throw new Error('unexpected session operation'); };
    const call = { id: custody.callId, name: 'propose_work', argumentsJson: JSON.stringify({ request: 'prepare a purchase with durable business readback' }) };
    const claude = cli === 'claude' ? createClaudeAgentDriver({ entry, port: { session, propose: async () => custody.result, cancel: stop, revoke: stop },
      model: meta.nativeModel, cliVersion: meta.version, runDir: wire[0].cwd, outputMaxBytes: 65536, quotaPolicy: nativeQuotaPolicy(), onPaidUsage: async () => undefined,
      paidExtraUsage: 'continue', planning: observe }) : null;
    const codex = cli === 'codex' ? codexAgentTurn({ entry, model: meta.nativeModel } as Parameters<typeof codexAgentTurn>[0],
      { version: meta.version, flagSetDigest: nativeAgentFlagSetDigest(entry) } as Parameters<typeof codexAgentTurn>[1], session,
      id => id === call.id ? { call, result: custody.result } : undefined, undefined, EMPTY_KNOWN_SECRETS, observe) : null;
    for (const event of wire) {
      if (claude) expect(await claude.line(JSON.stringify(event))).toBeUndefined();
      if (codex) expect(codex.line(JSON.stringify(event))).toBeNull();
      if (event.item?.type === 'mcp_tool_call' && event.type === 'item.started' || event.message?.content?.some((b: { type: string }) => b.type === 'tool_use')) {
        if (claude) expect(await claude.propose(call, custody.correlation, new AbortController().signal)).toEqual(custody.result);
        if (codex) expect(codex.accepts(call)).toBe(true);
        active = true;
      }
    }
    expect(delivered).toBe(true);
    const terminal = wire.at(-2);
    expect(observe.session).toHaveBeenCalledWith(wire[0].session_id ?? wire[0].thread_id);
    expect(observe.terminal.mock.calls).toEqual([[terminal.item?.id ?? terminal.message.id, framed]]);
    if (claude) expect(claude.finish(meta.process)).toMatchObject({ kind: 'completed', stopReason: 'end_turn', text: framed });
    if (codex) expect(codex.end({ exited: true, exitCode: meta.process.exitCode }, meta.process.egress)).toHaveProperty('response');
  }
});
