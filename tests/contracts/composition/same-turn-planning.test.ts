import { mkdir, mkdtemp, readFile, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import * as headless from '#adapters/core/native-cli-headless/index.js';
import * as invocationStore from '#adapters/core/sqlite-model-invocation/index.js';
import { nativeCliAgent, readLocalOsIdentity, withLocalPrincipalChannel, withMcpPrincipal } from '#adapters/index.js';
import { encodeModelBindingDefinition, firstRunPolicyTemplate, modelInvocationProfileSchema, type AgentTurnStreamEvent } from '#domain/index.js';
import { brainPlannerConfigSchema, type NativeAgentCorrelation } from '#capabilities/index.js';
import { FIRST_RUN_TOOL_NAMES, ModelInvocationControllers, ModelInvocationPolicyAuthorization, agentTurnResultDigest, modelInvocationProfileDigest } from '#engine/index.js';
import { createConfiguredNativeChatRuntime, createRuntimeChatTurnHost, runPeerConfiguredChatTurn, type NativeChatRuntime } from '#composition/core/agent-turn/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { inspectConfiguredModelInvocation } from '#composition/core/model-invocation/index.js';
import { createServiceSameTurnPlanning, planServiceRun } from '#composition/core/run-planner/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { loadProposalViews } from '#surfaces/index.js';
import { clearConfigCache, sha256 } from '#platform/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import { personEnv } from '../support/person-env.js';
import { createTerminalRuntimeClient, terminalRuntimePeer } from '../support/terminal-runtime-client.js';
import { CODEX_FAMILY } from '../../fixtures/native-headless/codex.js';
import { FAMILY } from '../../fixtures/native-headless/stream.js';

vi.mock('#adapters/core/native-cli-headless/internal/realm.js', async importOriginal => ({
  ...await importOriginal<typeof import('#adapters/core/native-cli-headless/internal/realm.js')>(), runHeadlessIsolated: vi.fn(),
}));
vi.mock('#adapters/core/native-cli-headless/internal/agent-observation.js', async importOriginal => ({
  ...await importOriginal<typeof import('#adapters/core/native-cli-headless/internal/agent-observation.js')>(),
  preflightNativeAgent: vi.fn(), recordNativeAgentObservation: vi.fn(),
}));

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const RAW = 'fixture-private-native-body-marker';
type Card = Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>;
type Outcome = 'allow' | 'deny' | 'refuse' | 'lost' | 'corrupt' | 'cancel-card';

async function recording(cli: 'codex' | 'claude') {
  const dir = new URL('../../fixtures/same-turn-planning/' + cli + '/recorded/', import.meta.url);
  const read = (file: string) => readFile(new URL(file, dir), 'utf8');
  const [stdout, custody, manifest] = await Promise.all([read('stdout.jsonl'), read('custody.jsonl'), read('manifest.json')]);
  const wire = stdout.trimEnd().split('\n').map(line => JSON.parse(line));
  const meta = JSON.parse(manifest);
  expect(sha256(stdout)).toBe(meta.maskedSha256['stdout.jsonl']);
  expect(sha256(custody)).toBe(meta.maskedSha256['custody.jsonl']);
  const call = JSON.parse(custody.split('\n')[0]!) as { callId: string; correlation: NativeAgentCorrelation; result: unknown };
  const terminal = cli === 'codex' ? wire.at(-2).item.text as string : wire.at(-1).result as string;
  return { meta, wire, call, draft: terminal.slice(terminal.indexOf('\n') + 1) };
}

function snapshot(path: string, observe: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { observe(db); } finally { db.close(); }
}

async function run(cli: 'codex' | 'claude', decision: Outcome) {
  const family = cli === 'codex' ? CODEX_FAMILY : FAMILY;
  const { meta, wire, call, draft } = await recording(cli);
  const owner = readLocalOsIdentity(), emptyRealm = await mkdtemp(join(tmpdir(), 'deckent-same-turn-realm-'));
  const stateDir = join(emptyRealm, 'scratch');
  await mkdir(stateDir);
  cleanups.push(async () => { await rmdir(stateDir); await rmdir(emptyRealm); });
  const f = await brainProviderFixture({ maxInFlight: 1, headless: {
    executable: process.execPath, configDir: emptyRealm, stateDir, protocolFamily: family, nativeModel: meta.nativeModel,
    delegatedUse: { consentedBy: { issuer: owner.issuer, subject: owner.subject }, atMs: 1, classes: ['ai'] },
  } });
  cleanups.push(f.close);
  const profile = modelInvocationProfileSchema.parse(f.config.provider_invocation_profiles.profiles[0]), entry = nativeCliAgent(family)!;
  expect(f.config.provider_invocation_profiles.profiles).toHaveLength(1);
  expect(profile.billingAxis).toBe('subscription'); expect(profile.allocation.maxInFlight).toBe(1);
  expect(brainPlannerConfigSchema.parse((await loadComposedConfig(f.project, f.options))['brain_planner'] ?? {}))
    .toMatchObject({ maxCompletionTokens: null, reasoning: 'model-default' });
  const chosenBrain = cli === 'claude' ? 'chosen-brain' : null;
  if (chosenBrain) {
    const reference = { ...f.reference, modelId: chosenBrain };
    const [provider] = f.config.provider_catalog.providers;
    const model = { ...provider!.models[0]!, id: chosenBrain, nativeId: chosenBrain };
    const bindingDigest = sha256(encodeModelBindingDefinition({ encodingVersion: 1, provider: { id: provider!.id, version: provider!.version }, model }));
    await writeFile(join(f.project, '.deckent', 'config.json'), JSON.stringify({ ...f.config, language: 'tr', brain_planner: { reference },
      provider_catalog: { ...f.config.provider_catalog, providers: [{ ...provider, models: [...provider!.models, model] }] },
      provider_invocation_profiles: { schemaVersion: 1, profiles: [profile,
        { ...profile, id: chosenBrain, allocation: { ...profile.allocation, id: chosenBrain }, reference, bindingDigest }] } }));
  }
  const first = firstRunPolicyTemplate({ scopeId: 's', principal: { issuer: owner.issuer, subject: owner.subject }, ...FIRST_RUN_TOOL_NAMES });
  const policy = decision === 'refuse' ? { ...first.policy, grants: first.policy.grants.map(grant =>
    grant.resource.kind === 'model-invocation' ? { ...grant, actions: grant.actions.filter(action => action !== 'inspect-content') } : grant) } : first.policy;
  await writeFile(join(f.data, 'policy.json'), JSON.stringify(policy), { mode: 0o600 });
  await writeFile(join(f.data, 'bindings.json'), JSON.stringify({ schemaVersion: 3, revision: 'fixture', bindings: [], modes: [] }), { mode: 0o600 });
  clearConfigCache();
  const terminal = await terminalRuntimePeer(createTerminalRuntimeClient(f.project, f.options, personEnv(process.env)));
  const lost = new AbortController();
  const peer = decision === 'lost' ? { ...terminal, connection: AbortSignal.any([terminal.connection!, lost.signal]),
    isConnectionActive: () => !lost.signal.aborted && terminal.isConnectionActive?.() === true } : terminal;
  const trace: Record<string, unknown>[] = [], events: AgentTurnStreamEvent[] = [], abort = new AbortController();
  const log = ['log', 'warn', 'error'].map(name => vi.spyOn(console, name as 'log').mockImplementation(() => {}));
  const register = ModelInvocationControllers.prototype.register;
  vi.spyOn(ModelInvocationControllers.prototype, 'register').mockImplementation(function (this: ModelInvocationControllers, claim, ownerId) {
    trace.push({ event: 'claim-register-attempt', commandId: claim.commandId });
    try { return register.call(this, claim, ownerId); }
    catch (error) { trace.push({ event: 'claim-register-refused', code: (error as { code: string }).code }); throw error; }
  });
  const openStore = invocationStore.openSqliteModelInvocationStore;
  let settledResponse = false, selected = 0;
  vi.spyOn(invocationStore, 'openSqliteModelInvocationStore').mockImplementation(async (...args) => {
    const store = await openStore(...args), claim = store.claim.bind(store), record = store.recordResponse.bind(store);
    vi.spyOn(store, 'claim').mockImplementation(async input => {
      trace.push({ event: 'claim-attempt', commandId: input.command.commandId, reference: input.command.reference });
      try { const result = await claim(input); trace.push({ event: 'claimed', commandId: input.command.commandId }); return result; }
      catch (error) { trace.push({ event: 'claim-refused', code: (error as { code: string }).code }); throw error; }
    });
    vi.spyOn(store, 'recordResponse').mockImplementation(async (...response) => {
      const result = await record(...response);
      if (decision === 'corrupt') {
        const db = new DatabaseSync(f.path);
        try { db.prepare("UPDATE model_invocation_contents SET record=json_set(record,'$.response.native.fixtureWitness','altered') WHERE invocation_id=?")
          .run(result.receipt.claim.invocationId); } finally { db.close(); }
      }
      settledResponse = true;
      return result;
    });
    return store;
  });
  const sqlPrepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, statement) {
    const prepared = sqlPrepare.call(this, statement);
    if (/c\.record AS content_record/iu.test(statement)) {
      const get = prepared.get.bind(prepared);
      vi.spyOn(prepared, 'get').mockImplementation((...args: Parameters<typeof prepared.get>) => {
        if (settledResponse) selected++;
        return get(...args);
      });
    }
    return prepared;
  });
  if (decision === 'lost') {
    const authorize = ModelInvocationPolicyAuthorization.prototype.authorize;
    vi.spyOn(ModelInvocationPolicyAuthorization.prototype, 'authorize').mockImplementation(async function (this: ModelInvocationPolicyAuthorization, ...args) {
      const result = await authorize.call(this, ...args);
      if (args[0] === 'inspect-content') lost.abort();
      return result;
    });
  }
  // The separate Brain would claim the same login. Keep the transport fenced even if the routing regresses.
  vi.spyOn(headless, 'createNativeCliHeadlessPort').mockImplementation(() => ({ billingAxis: 'subscription', preflight: async () => undefined,
    prepare: async (_profile, _definition, request) => { trace.push({ event: 'brain-prepare', cap: request['max_completion_tokens'], reasoning: request['reasoning_effort'] ?? 'model-default' }); return {}; },
    send: async () => { trace.push({ event: 'brain-send' }); throw new Error('UNEXPECTED_SECOND_SEND'); },
  }) as ReturnType<typeof headless.createNativeCliHeadlessPort>);
  const execution = { schemaVersion: 1 as const, capability: 'NativeAgentExecution' as const, executable: process.execPath, cliVersion: meta.version,
    flagSetDigest: headless.nativeAgentFlagSetDigest(entry), profileDigest: modelInvocationProfileDigest(profile), ownerUid: process.getuid!() };
  vi.mocked(headless.preflightNativeAgent).mockResolvedValue({ execution, preflight: { executable: process.execPath, version: meta.version,
    flagSetDigest: execution.flagSetDigest } } as Awaited<ReturnType<typeof headless.preflightNativeAgent>>);
  let driver: ReturnType<typeof headless.createNativeAgentDriver>;
  const production = createConfiguredNativeChatRuntime(f.project, f.options)!;
  const runtime: NativeChatRuntime = {
    readiness: { read: async () => ({ cli: true, login: true, environment: true, plugins: true, toolSurface: true, bridge: true, execution }) },
    limits: { idleMs: 10_000, maxConnections: 1, replayMaxEntries: 1, replayMaxBytes: entry.bridge.frameMaxBytes },
    resolveModelUse: production.resolveModelUse,
    driver: async input => {
      driver = headless.createNativeAgentDriver({ ...input, now: Date.now, isolation: async () => { throw new Error('UNEXPECTED_REAL_CLI'); } });
      return { ...driver, native(bridge, secrets) {
        const port = driver.native(bridge, secrets);
        return { ...port, async send(...args: Parameters<typeof port.send>) {
          const result = await port.send(...args);
          return 'kind' in result ? result : { ...result, native: { ...result.native, fixtureWitness: RAW } };
        } };
      } };
    },
  };
  let toolAnswer = '';
  vi.mocked(headless.runHeadlessIsolated).mockImplementation(async (_entry, _isolation, spawn, _bounds, signal, line) => {
    trace.push({ event: 'outer-send' });
    let challenge = '', stopped = false;
    for (const event of wire) {
      if (event.subtype === 'init') {
        event.cwd = spawn.runDir;
        // The retained recording advertised only its preparation tool. Bind the init surface to this real session.
        event.tools = driver.port.session.tools.map(tool => entry.bridge.toolPrefix + tool.name);
      }
      if (challenge) {
        const rebind = (text: string) => challenge + text.slice(text.indexOf('\n'));
        if (event.item?.type === 'agent_message') event.item.text = rebind(event.item.text);
        if (event.type === 'assistant') for (const block of event.message.content) if (block.type === 'text') block.text = rebind(block.text);
        if (event.type === 'result') event.result = rebind(event.result);
      }
      let raw = JSON.stringify(event);
      if (toolAnswer) raw = raw.replaceAll(JSON.stringify(JSON.stringify(call.result)), () => JSON.stringify(toolAnswer));
      if (await line!(raw, signal!) === 'stop') { stopped = true; break; }
      const tool = cli === 'codex' ? event.type === 'item.started' && event.item.type === 'mcp_tool_call' && event.item
        : event.message?.content?.find((block: { type: string }) => block.type === 'tool_use');
      if (!tool) continue;
      trace.push({ event: 'propose_work' });
      const result = await driver.port.propose({ id: call.callId, name: 'propose_work', argumentsJson: JSON.stringify(tool.arguments ?? tool.input) }, call.correlation, signal!);
      toolAnswer = JSON.stringify(result);
      challenge = result.outcome.text.split('\n')[0]!;
      trace.push({ event: 'preparation-result', status: result.outcome.status,
        ...(result.outcome.status === 'error' ? { failure: result.outcome.text } : {}) });
      // This is the original one-slot counterexample at its live-claim barrier. The person card now comes after the native turn closes.
      snapshot(f.path, db => {
        expect(db.prepare('SELECT execution_slots,in_flight_slots FROM capacity_resources WHERE binding_kind=?').all(profile.adapter.id))
          .toEqual([{ execution_slots: 1, in_flight_slots: 1 }]);
        expect(db.prepare("SELECT command_id FROM model_invocations WHERE state='claimed'").all()).toHaveLength(1);
        expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 0 });
      });
      expect(events.filter(event => event.kind === 'approval.requested')).toHaveLength(0);
    }
    return { ...meta.process, started: true, reason: stopped ? 'stopped' : 'exit' };
  });
  const createHost = () => createRuntimeChatTurnHost({ ownerId: 'same-turn-fixture', controllers: new ModelInvocationControllers(2) }, abort.signal,
    undefined, undefined, () => [], undefined, runtime, planServiceRun,
    () => loadProposalViews().then(([planning, config]) => ({ cardLines: planning.brainProposalCardLines, schemaChoices: config.configSchemaChoices })),
    input => {
      const service = createServiceSameTurnPlanning(input);
      if (!service) return null;
      const code = (error: unknown) => {
        const failure = error as { name?: string; code?: string; params?: { reason?: string } } | null;
        return { name: failure?.name, code: failure?.code, reason: failure?.params?.reason };
      };
      const privateResult = service.planning.privateResult.bind(service.planning);
      vi.spyOn(service.planning, 'privateResult').mockImplementation((...args) => {
        try { return privateResult(...args); }
        catch (error) { trace.push({ event: 'private-projection-refused', ...code(error) }); throw error; }
      });
      return { ...service, async prepare(...args) {
        try { return await service.prepare(...args); }
        catch (error) { trace.push({ event: 'prepare-refused', ...code(error) }); throw error; }
      } };
    });
  const host = createHost();
  const turnId = 'same-turn', command = { schemaVersion: 1 as const, scopeId: 's', turnId, messages: [{ role: 'user' as const, content: 'prepare a purchase' }] };
  const proofDir = process.env['DECKENT_K3C_PROOF_DIR'];
  async function retain(phase: string, event: Card) {
    if (!proofDir) return;
    const output = join(proofDir, cli + '-' + phase);
    await mkdir(output, { recursive: true });
    const db = new DatabaseSync(f.path, { readOnly: true });
    try { await backup(db, join(output, 'ledger.db')); } finally { db.close(); }
    await writeFile(join(output, 'witness.json'), JSON.stringify({ turnId, approvalId: event.approvalId, draft, preview: event.preview, summary: event.summary }));
  }
  let answered: Promise<void> | undefined, card: Card | undefined;
  let cardError: unknown;
  const result = await runPeerConfiguredChatTurn(f.project, command, peer, f.options, { maxResultBytes: 65_536 }, host, {
    signal: abort.signal, room: () => 1_000_000, drained: async () => true,
    emit(event) {
      events.push(event);
      if (event.kind !== 'approval.requested') return;
      card = event;
      answered = (async () => {
        snapshot(f.path, db => {
          expect(db.prepare("SELECT command_id FROM model_invocations WHERE state='responded'").all()).toHaveLength(1);
          expect(db.prepare('SELECT command_id FROM run_proposals').all()).toHaveLength(1);
          expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 0 });
        });
        await retain('pending', event);
        if (decision === 'cancel-card') { abort.abort(); return; }
        if (decision !== 'allow' && decision !== 'deny') throw new Error('UNEXPECTED_APPROVAL');
        // The person answers over the runtime's separate decision request, outside the chat's MCP callback.
        const decided = await withLocalPrincipalChannel(undefined, () => configuredApproval(f.project, 'decide', { schemaVersion: 1, scopeId: 's', commandId: 'person-answer', approvalId: event.approvalId,
          expectedRevision: event.revision, decision, reason: 'Fixture person decision', channel: 'local-terminal-card', decisionCapability: event.decisionCapability },
        f.options, peer, undefined, {}, host.decisions, host.answers), peer);
        expect(decided).toMatchObject({ status: 'decided', decision: { decision, actor: { issuer: owner.issuer, subject: owner.subject } } });
      })().catch(error => { cardError = error; abort.abort(); });
    },
  }).finally(async () => { await answered; await host.mcp.close(); });
  if (cardError) throw cardError;
  if (card) await retain(decision, card);
  const cards = events.filter(event => event.kind === 'approval.requested');
  const shouldCard = decision === 'allow' || decision === 'deny' || decision === 'cancel-card';
  if (shouldCard && !cards.length && trace.some(row => row['event'] === 'claim-refused')) {
    expect(trace.filter(row => row['event'] === 'claim-register-attempt')).toHaveLength(2);
    expect(trace.filter(row => row['event'] === 'claim-attempt')).toHaveLength(2);
    expect(trace.at(-1)).toMatchObject({ event: 'claim-refused', code: 'MODEL_INVOCATION_CAPACITY_EXHAUSTED' });
    expect(trace.find(row => row['event'] === 'brain-prepare')).toMatchObject({ cap: 8, reasoning: 'model-default' });
  }
  expect(cards, JSON.stringify({ trace, result, events })).toHaveLength(shouldCard ? 1 : 0);
  expect(trace.filter(row => row['event'] === 'outer-send')).toHaveLength(1);
  expect(trace.filter(row => row['event'] === 'claim-register-attempt')).toHaveLength(1);
  expect(trace.filter(row => row['event'] === 'claim-attempt')).toHaveLength(1);
  expect(trace.filter(row => row['event'] === 'brain-send')).toHaveLength(0);
  expect(JSON.stringify({ trace, result })).not.toMatch(/MODEL_INVOCATION_CAPACITY_EXHAUSTED|HEADLESS_LOGIN_BUSY/u);
  expect(selected).toBe(shouldCard || decision === 'corrupt' ? 1 : 0);
  expect(settledResponse).toBe(true);
  if (decision === 'refuse' || decision === 'corrupt') {
    expect(result).toMatchObject({ finish: 'error', note: 'The system could not verify access to the saved reply for this chat. No plan was sent for approval and no Run started. Use /do to request a separate plan.' });
  }
  snapshot(f.path, db => {
    const proposals = db.prepare('SELECT record FROM run_proposals').all();
    expect(proposals).toHaveLength(shouldCard ? 1 : 0);
    expect(db.prepare('SELECT command FROM run_receipts').all()).toHaveLength(decision === 'allow' ? 1 : 0);
    expect(db.prepare('SELECT snapshot FROM runs').all()).toHaveLength(decision === 'allow' ? 1 : 0);
    const [response] = db.prepare('SELECT record FROM model_invocation_contents').all();
    const { response: stored } = JSON.parse(String(response?.record));
    expect(stored.native.choices[0].message.content).toBe(draft);
    expect(stored.native.fixtureWitness).toBe(decision === 'corrupt' ? 'altered' : RAW);
    const turn = JSON.parse(String(db.prepare('SELECT record FROM agent_turns WHERE turn_id=?').get(turnId)?.record));
    const history = events.flatMap(event => event.kind === 'message' ? [event.message] : []);
    expect(turn.outcome.appendedDigest).toBe(sha256('agent-turn-appended:1\0' + JSON.stringify(history)));
    const [tool] = db.prepare('SELECT record FROM agent_turn_tool_calls WHERE turn_id=?').all(turnId);
    const preparation = JSON.parse(toolAnswer).outcome.text as string;
    expect(JSON.parse(String(tool?.record))).toMatchObject({ resultDigest: agentTurnResultDigest(preparation), bytes: Buffer.byteLength(preparation) });
    const sinks = JSON.stringify({ toolAnswer, result, events, turn, history, logs: log.map(spy => spy.mock.calls) });
    expect(sinks).not.toContain(RAW);
    expect(JSON.stringify({ result, events, turn })).not.toContain("DECKENT-PLAN-CHALLENGE/1 ");
    if (shouldCard) {
      const { proposal } = JSON.parse(String(proposals[0]?.record));
      expect(proposal.graph).toEqual(JSON.parse(draft).graph);
      expect(proposal.source).toMatchObject({ kind: 'model', receipt: { reference: f.reference },
        contribution: { schemaVersion: 2, billingAxis: 'subscription' } });
      expect(cards[0]?.preview).toContain(chosenBrain ? 'bu sohbetin abonelik girişiyle' : 'the subscription sign-in for this chat');
      if (chosenBrain) expect(cards[0]?.preview).toContain('Seçtiğiniz Brain modeli chosen-brain aynı girişi paylaştığı için kullanılmadı.');
    }
    expect(db.prepare('SELECT record FROM model_invocation_plan_usage').all()).toHaveLength(1);
    expect(db.prepare('SELECT record FROM model_invocation_spend_reservations').all()).toHaveLength(0);
  });
  if (decision === 'cancel-card') {
    expect(events).toContainEqual(expect.objectContaining({ kind: 'approval.settled', outcome: 'cancelled' }));
  }
  if (decision === 'allow' || decision === 'deny') {
    const restarted = createHost(), replayEvents: AgentTurnStreamEvent[] = [];
    try {
      const replay = await runPeerConfiguredChatTurn(f.project, command, peer, f.options, { maxResultBytes: 65_536 }, restarted, {
        signal: abort.signal, room: () => 1_000_000, drained: async () => true, emit: event => replayEvents.push(event),
      });
      expect(replay).toMatchObject({ replayed: true, answer: result.answer, recorded: true });
      expect(replayEvents.filter(event => event.kind === 'approval.requested')).toHaveLength(0);
      expect(trace.filter(row => row['event'] === 'outer-send')).toHaveLength(1);
      expect(selected).toBe(1);
    } finally { await restarted.mcp.close(); }
  }
  if (decision !== 'corrupt') {
    const row = new DatabaseSync(f.path, { readOnly: true });
    let invocationId: string;
    try { invocationId = String(row.prepare('SELECT invocation_id FROM model_invocations').get()?.invocation_id); } finally { row.close(); }
    await expect(withMcpPrincipal(() => inspectConfiguredModelInvocation(f.project, { schemaVersion: 2, scopeId: 's',
      reference: profile.reference, invocationId, includeResponseContent: true }, f.options))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(selected).toBe(shouldCard ? 1 : 0);
  }
}

for (const [cli, decision] of [['codex', 'allow'], ['claude', 'deny']] as const) {
  it.skipIf(process.platform !== 'linux')(`${cli}: one native subscription call produces one verified plan and person card (${decision})`, async () => {
    await run(cli, decision);
  }, 45_000);
}

it.skipIf(process.platform !== 'linux')('private read denial, lost connection and corrupt body stop before proposal, and cancellation stops at an open card', async () => {
  for (const decision of ['refuse', 'lost', 'corrupt', 'cancel-card'] as const) {
    await run('codex', decision);
    for (const close of cleanups.splice(0).reverse()) await close();
    vi.restoreAllMocks(); vi.clearAllMocks();
  }
}, 90_000);
