import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rmdir, writeFile } from 'node:fs/promises';
import * as auditComposition from '#composition/core/audit/index.js';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { main as runCli } from '#composition/core/cli/index.js';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import * as headless from '#adapters/core/native-cli-headless/index.js';
import * as invocationStore from '#adapters/core/sqlite-model-invocation/index.js';
import { nativeCliAgent, readLocalOsIdentity, withLocalPrincipalChannel, withMcpPrincipal } from '#adapters/index.js';
import { encodeModelBindingDefinition, firstRunPolicyTemplate, modelInvocationProfileSchema, type AgentTurnStreamEvent } from '#domain/index.js';
import { brainPlannerConfigSchema, type NativeAgentCorrelation } from '#capabilities/index.js';
import { AuditApplication, FIRST_RUN_TOOL_NAMES, ModelInvocationControllers, ModelInvocationPolicyAuthorization, agentTurnResultDigest, modelInvocationProfileDigest, modelInvocationRequestDigest, type ModelInvocationStore } from '#engine/index.js';
import { createConfiguredNativeChatRuntime, createRuntimeChatTurnHost, runPeerConfiguredChatTurn, type NativeChatRuntime } from '#composition/core/agent-turn/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { inspectConfiguredModelInvocation, inspectRefusalCandidate } from '#composition/core/model-invocation/index.js';
import { createServiceSameTurnPlanning, planServiceRun } from '#composition/core/run-planner/index.js';
import { loadConfiguredScopeContext, withScopeAudit } from '#composition/core/scoped-request/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { loadProposalViews } from '#surfaces/index.js';
import { clearConfigCache, productResourcePath, resolveGlobalConfigReadPath, sha256, t } from '#platform/index.js';
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
  preflightNativeAgent: vi.fn(), prepareNativeAgentObservation: vi.fn(async () => async () => {}),
}));

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const RAW = 'fixture-private-native-body-marker';
type Card = Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>;
type Outcome = 'allow' | 'deny' | 'refuse' | 'fresh-refusal' | 'lost' | 'corrupt' | 'cancel-card' | 'masking-changed' | 'raw-masking-changed';

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

async function run(cli: 'codex' | 'claude', decision: Outcome, variant?: 'rebind' | 'sign-failure' | 'append-failure') {
  const family = cli === 'codex' ? CODEX_FAMILY : FAMILY;
  const { meta, wire, call, draft: recordedDraft } = await recording(cli);
  const rawMask = '200.000000';
  const draft = decision === 'raw-masking-changed' ? recordedDraft.replace('"limitMinorUnits":200', `"limitMinorUnits":${rawMask}`) : recordedDraft;
  if (decision === 'raw-masking-changed') {
    expect(JSON.parse(draft)).toEqual(JSON.parse(recordedDraft));
    wire.at(-2).item.text = wire.at(-2).item.text.replace(recordedDraft, draft);
  }
  const owner = readLocalOsIdentity(), emptyRealm = await mkdtemp(join(tmpdir(), 'deckent-same-turn-realm-'));
  const stateDir = join(emptyRealm, 'scratch');
  await mkdir(stateDir);
  cleanups.push(async () => { await rmdir(stateDir); await rmdir(emptyRealm); });
  const f = await brainProviderFixture({ maxInFlight: 1, headless: {
    executable: process.execPath, configDir: emptyRealm, stateDir, protocolFamily: family, nativeModel: meta.nativeModel,
    delegatedUse: { consentedBy: { issuer: owner.issuer, subject: owner.subject }, atMs: 1, classes: ['ai'] },
  } });
  cleanups.push(f.close);
  const maskingChanged = decision === 'masking-changed' || decision === 'raw-masking-changed';
  const approval = maskingChanged ? 'allow' : decision;
  let maskingValue = 'synthetic-unused-value';
  if (maskingChanged) {
    const globalPath = await resolveGlobalConfigReadPath(f.options.env);
    const globalConfig = JSON.parse(await readFile(globalPath, 'utf8'));
    await writeFile(globalPath, JSON.stringify({ ...globalConfig, projectName: '$DECK:PLAN_MASKING_FIXTURE' }));
    Object.assign(f.options, { secretResolver: async (name: string) => name === 'PLAN_MASKING_FIXTURE' ? maskingValue : undefined });
  }
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
  const deniedPolicy = { ...first.policy, grants: first.policy.grants.map(grant =>
    grant.resource.kind === 'model-invocation' ? { ...grant, actions: grant.actions.filter(action => action !== 'inspect-content') } : grant) };
  const policyFile = join(f.data, 'policy.json'), freshRevision = 'fresh-read-denial', bindingsRevision = 'fixture';
  await writeFile(policyFile, JSON.stringify(decision === 'refuse' ? deniedPolicy : first.policy), { mode: 0o600 });
  await writeFile(join(f.data, 'bindings.json'), JSON.stringify({ schemaVersion: 3, revision: bindingsRevision, bindings: [], modes: [] }), { mode: 0o600 });
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
  let claimInput: Parameters<ModelInvocationStore['claim']>[0] | undefined;
  let retainedResponse: Parameters<ModelInvocationStore['recordResponse']>[1] | undefined;
  let settledResponse = false, selected = 0;
  vi.spyOn(invocationStore, 'openSqliteModelInvocationStore').mockImplementation(async (...args) => {
    const store = await openStore(...args), claim = store.claim.bind(store), record = store.recordResponse.bind(store);
    vi.spyOn(store, 'claim').mockImplementation(async input => {
      claimInput = input;
      trace.push({ event: 'claim-attempt', commandId: input.command.commandId, reference: input.command.reference });
      try { const result = await claim(input); trace.push({ event: 'claimed', commandId: input.command.commandId }); return result; }
      catch (error) { trace.push({ event: 'claim-refused', code: (error as { code: string }).code }); throw error; }
    });
    vi.spyOn(store, 'recordResponse').mockImplementation(async (...response) => {
      retainedResponse = response[1];
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
  if (decision === 'fresh-refusal') {
    const authorize = ModelInvocationPolicyAuthorization.prototype.authorize;
    vi.spyOn(ModelInvocationPolicyAuthorization.prototype, 'authorize').mockImplementation(async function (this: ModelInvocationPolicyAuthorization, ...args) {
      if (args[0] === 'inspect-content' && args[2].assurance === 'os-user') {
        expect(JSON.parse(await readFile(policyFile, 'utf8')).revision).toBe(first.policy.revision);
        await writeFile(policyFile, JSON.stringify({ ...deniedPolicy, revision: freshRevision }), { mode: 0o600 });
      }
      return authorize.call(this, ...args);
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
    }, signer);
  const signer: typeof auditComposition.signRefusalTarget = variant === 'sign-failure' ? () => { throw new Error('fixture-sign-failure'); } : auditComposition.signRefusalTarget;
  if (variant === 'append-failure') {
    const record = AuditApplication.prototype.record;
    vi.spyOn(AuditApplication.prototype, 'record').mockImplementation(function (this: AuditApplication, input) {
      if ((input as { subject?: { kind?: string } }).subject?.kind === 'access-refusal-summary') throw new Error('fixture-append-failure');
      return record.call(this, input);
    });
  }
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
        if (approval !== 'allow' && approval !== 'deny') throw new Error('UNEXPECTED_APPROVAL');
        if (maskingChanged) {
          expect(selected).toBe(1);
          maskingValue = decision === 'raw-masking-changed' ? rawMask : 'Durable business readback';
          expect(draft).toContain(maskingValue);
        }
        // The person answers over the runtime's separate decision request, outside the chat's MCP callback.
        const decided = await withLocalPrincipalChannel(undefined, () => configuredApproval(f.project, 'decide', { schemaVersion: 1, scopeId: 's', commandId: 'person-answer', approvalId: event.approvalId,
          expectedRevision: event.revision, decision: approval, reason: 'Fixture person decision', channel: 'local-terminal-card', decisionCapability: event.decisionCapability },
        f.options, peer, undefined, {}, host.decisions, host.answers), peer);
        expect(decided).toMatchObject({ status: 'decided', decision: { decision: approval, actor: { issuer: owner.issuer, subject: owner.subject } } });
      })().catch(error => { cardError = error; abort.abort(); });
    },
  }).finally(async () => { await answered; await host.mcp.close(); });
  if (cardError) throw cardError;
  if (card) await retain(decision, card);
  const cards = events.filter(event => event.kind === 'approval.requested');
  const shouldCard = approval === 'allow' || approval === 'deny' || decision === 'cancel-card';
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
  if (decision === 'refuse' || decision === 'fresh-refusal' || decision === 'corrupt') {
    expect(result).toMatchObject({ finish: 'error', note: [
      'The system could not verify access to the saved reply for this chat. No plan was sent for approval and no Run started. Use /do to request a separate plan.',
      ...((variant === 'sign-failure' || variant === 'append-failure') ? ['This turn’s access-refusal audit summary could not be saved.'] : []),
    ].join(' ') });
  }
  snapshot(f.path, db => {
    const proposals = db.prepare('SELECT record FROM run_proposals').all();
    expect(proposals).toHaveLength(shouldCard ? 1 : 0);
    expect(db.prepare('SELECT snapshot FROM runs').all()).toHaveLength(decision === 'allow' ? 1 : 0);
    expect(db.prepare('SELECT command FROM run_receipts').all()).toHaveLength(decision === 'allow' ? 1 : 0);
    const [response] = db.prepare('SELECT record FROM model_invocation_contents').all();
    const { response: stored } = JSON.parse(String(response?.record));
    expect(stored.native.choices[0].message.content).toBe(draft);
    expect(stored.native.fixtureWitness).toBe(decision === 'corrupt' ? 'altered' : RAW);
    const readEvents = db.prepare("SELECT record FROM audit_events WHERE kind='access-refusal-summary'").all()
      .map(row => JSON.parse(String(row.record)).event)
      .filter(event => event.subject.evidenceBasis === 'retained-response-authority');
    const readRefusals = readEvents.map(event => event.subject);
    if ((decision === 'refuse' || decision === 'fresh-refusal') && variant !== 'sign-failure' && variant !== 'append-failure') {
      const revision = decision === 'fresh-refusal' ? freshRevision : first.policy.revision;
      expect(readEvents.map(event => event.policyRevision)).toEqual([`${revision}+${bindingsRevision}`]);
      expect(readRefusals).toEqual([expect.objectContaining({ turnId, count: 1, samples: [],
        invocationId: db.prepare('SELECT invocation_id FROM model_invocations').get()?.invocation_id,
        target: { role: 'stored-invocation-response', identity: { keyId: expect.any(String), digest: expect.stringMatching(/^[a-f0-9]{64}$/u) } },
      })]);
      expect(readRefusals[0]).not.toHaveProperty('call');
      expect(JSON.stringify(readRefusals)).not.toContain(RAW);
    } else expect(readRefusals).toEqual([]);
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
      const { proposal, status, reason } = JSON.parse(String(proposals[0]?.record));
      if (maskingChanged) expect({ status, reason }).toEqual({ status: 'rejected', reason: 'RUN_PROPOSAL_SOURCE_INVALID' });
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
  if (maskingChanged) {
    expect(events).toContainEqual(expect.objectContaining({ kind: 'approval.settled', outcome: 'allow' }));
    expect(result).toMatchObject({ finish: 'error', note: 'The plan could not be completed in this chat turn. No Run was started by this proposal. Ask again in chat, or use /do to request a separate plan.' });
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
  if (variant === 'sign-failure' || variant === 'append-failure') return result;
  if (decision === 'refuse') {
    const db = new DatabaseSync(f.path, { readOnly: true });
    let row: { sequence: number; invocationId: string };
    try {
      row = db.prepare("SELECT sequence, json_extract(record,'$.event.subject.invocationId') AS invocationId FROM audit_events WHERE kind='access-refusal-summary'").get() as typeof row;
    } finally { db.close(); }
    const inspect: auditComposition.InspectRefusalCandidate = async (context, ...args) => {
      expect(context.principal).toMatchObject({ issuer: owner.issuer, subject: owner.subject, assurance: 'os-user' });
      return inspectRefusalCandidate(context, ...args);
    };
    const query = { sequence: row.sequence, scopeId: 's', candidate: { invocationId: row.invocationId, reference: profile.reference } };
    const show = (candidate = query.candidate, lookup = inspect) => auditComposition.showConfiguredAuditCandidate(f.project, { ...query, candidate }, f.options, lookup);
    expect(await show()).toMatchObject({ targetResolution: 'not-resolvable' });
    const readerPolicy = { ...first.policy, revision: 'refusal-reader' };
    const publishPolicy = (policy: typeof readerPolicy) => writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
    await publishPolicy(readerPolicy);
    const matched = await show();
    expect(matched).toMatchObject({ sequence: query.sequence, targetResolution: 'verified-match' });
    expect(JSON.stringify(matched)).not.toContain(RAW);
    if (variant === 'rebind') {
      // Rebind only the UUID on this disposable fixture. Policy, DB path, key and verified locator are identical.
      const identityPath = join(productResourcePath((await loadComposedConfig(f.project, f.options)).productLayout, 'installationIdentity'), 'identity.json');
      const originalIdentity = await readFile(identityPath, 'utf8');
      const replacement = randomUUID();
      let changed = false;
      try {
        const rebound = await show(query.candidate, async (...args) => {
          const verified = await inspect(...args);
          if (verified) {
            await writeFile(identityPath, JSON.stringify({ ...JSON.parse(originalIdentity), installationId: replacement }), { mode: 0o600 });
            changed = true;
          }
          return verified;
        });
        expect(changed).toBe(true);
        expect(rebound).toMatchObject({ targetResolution: 'not-resolvable' });
      } finally { await writeFile(identityPath, originalIdentity, { mode: 0o600 }); }
      return result;
    }
    const file = join(f.project, 'candidate.json');
    await writeFile(file, JSON.stringify(query.candidate), { mode: 0o600 });
    const publicShow = async (candidate = query.candidate, { source = '-', locale = 'en', json = true, sequence = query.sequence } = {}) => {
      const stdout: string[] = [], stderr: string[] = [];
      const argv = ['audit', 'show', String(sequence), '--scope', 's', '--candidate', source, '--lang', locale, ...(json ? ['--json'] : [])];
      const stdin = Readable.from([JSON.stringify(candidate)]);
      const mocks = [
        vi.spyOn(process, 'cwd').mockReturnValue(f.project),
        vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(() => stdin[Symbol.asyncIterator]()),
        vi.spyOn(process.stdout, 'write').mockImplementation(line => { stdout.push(String(line)); return true; }),
        vi.spyOn(process.stderr, 'write').mockImplementation(line => { stderr.push(String(line)); return true; }),
      ];
      vi.stubEnv('HOME', f.options.env.HOME);
      vi.stubEnv('USERPROFILE', f.options.env.USERPROFILE);
      let exit;
      try { exit = await runCli(argv); }
      finally { mocks.forEach(mock => mock.mockRestore()); vi.unstubAllEnvs(); }
      const out = stdout.join(''), err = stderr.join('');
      for (const privateValue of [RAW, candidate.reference.modelId, candidate.reference.providerId]) {
        expect(out + err).not.toContain(privateValue);
      }
      return { exit, out, err };
    };
    for (const locale of ['en', 'tr'] as const) {
      const json = await publicShow(query.candidate, { locale, source: 'candidate.json' });
      expect(json).toMatchObject({ exit: 0, err: '' });
      expect(JSON.parse(json.out)).toEqual(matched);
      const human = await publicShow(query.candidate, { locale, json: false });
      expect(human).toMatchObject({ exit: 0, err: '' });
      expect(human.out).toContain(locale === 'en' ? 'Candidate target verified.' : 'Aday hedef doğrulandı.');
    }
    const unresolved = async (candidate = query.candidate, sequence = query.sequence) => {
      const response = await publicShow(candidate, { sequence });
      expect(response).toMatchObject({ exit: 0, err: '' });
      const parsed = JSON.parse(response.out);
      expect(parsed).toEqual({ ...parsed, sequence, targetResolution: 'not-resolvable' });
      expect(Object.keys(parsed).sort()).toEqual(['event', 'sequence', 'targetResolution']);
      if (candidate.invocationId !== query.candidate.invocationId) expect(response.out).not.toContain(candidate.invocationId);
    };

    const unrelatedId = 'same-scope-substitute', ctx = await loadConfiguredScopeContext(f.project, 's', f.options, 'read');
    const models = await openStore(f.path, ctx.config.storage.sqlite, 'forbid');
    try {
      const original = claimInput!, command = { ...original.command, commandId: unrelatedId }, claimedAtMs = Date.now();
      const other = await models.claim({ ...original, command, invocationId: unrelatedId, claimedAtMs, requestDigest: modelInvocationRequestDigest(command) });
      await models.permitSend(other.record.receipt.claim, 'fixture-second-owner', claimedAtMs + 1);
      await models.recordResponse(other.record.receipt.claim, retainedResponse!, claimedAtMs + 2);
      const alternate = { ...query.candidate, invocationId: unrelatedId };
      expect(await inspectRefusalCandidate(ctx, 's', alternate)).toMatchObject(alternate);
      await unresolved(alternate);
    } finally { models.close(); }
    await unresolved({ ...query.candidate, reference: { ...query.candidate.reference, modelVersion: 2 } });
    for (const update of [{ companyId: 'foreign-company' }, { installationId: 'foreign-installation' }, { scopeId: 'foreign-scope' },
      { descriptor: { kind: 'native-response' as const, encoding: 'canonical-json' as const, schemaVersion: 1 as const, byteLength: 7, digest: 'f'.repeat(64) } }]) {
      expect(await show(query.candidate, async (...input) => {
        const verified = await inspect(...input);
        return verified ? { ...verified, ...update } : null;
      })).toMatchObject({ targetResolution: 'not-resolvable' });
    }

    const auditOnly = { ...readerPolicy, revision: 'audit-only', grants: readerPolicy.grants.filter(grant => grant.resource.kind !== 'model-invocation') };
    await publishPolicy(auditOnly);
    await unresolved();
    const humanUnresolved = await publicShow(query.candidate, { locale: 'tr', json: false });
    expect(humanUnresolved).toMatchObject({ exit: 0, err: '' });
    expect(humanUnresolved.out).toContain('Hedef çözümlenemiyor.');
    await publishPolicy({ ...deniedPolicy, revision: 'content-revoked' });
    await unresolved();
    await publishPolicy({ ...readerPolicy, revision: 'audit-revoked', grants: readerPolicy.grants.filter(grant => grant.resource.kind !== 'approval') });
    const noAudit = await publicShow();
    expect(noAudit.exit).not.toBe(0);
    expect(noAudit.err).toContain('APPROVAL_DENIED');
    expect(noAudit.out).toBe('');

    await publishPolicy(readerPolicy);
    if (!matched || matched.event.subject.kind !== 'access-refusal-summary') throw new Error('fixture refusal missing');
    const subject = matched.event.subject, target = subject.target;
    const probes = [{ ...subject, invocationId: undefined }, { ...subject, target: { ...target, identity: null } },
      { ...subject, target: { ...target, identity: { keyId: 'unavailable-target-key', digest: target.identity!.digest } } },
      { ...subject, target: { ...target, identity: { ...target.identity!, digest: 'f'.repeat(64) } } }];
    await withScopeAudit(ctx, async audit => {
      // These rows have valid audit seals. Only the optional target binding varies.
      const controls = probes.map((value, index) => audit.record({ ...matched.event, eventId: 'candidate-control-' + index, subject: value }));
      for (const control of controls) await unresolved(query.candidate, control.sequence);
      const position = { turnId, callId: 'correlation-fixture', round: 1, index: 0 };
      const correlated = audit.record({ ...matched.event, eventId: 'candidate-correlated-refusal', subject: { ...subject, call: position, samples: [position] } });
      const { turnId: correlatedTurn, ...call } = position;
      const allowance = audit.record({ ...matched.event, eventId: 'candidate-correlated-policy', subject: { kind: 'policy-turn', turnId: correlatedTurn,
        ceiling: false, refused: { count: 0, calls: [] }, allowed: { count: 1, calls: [{ tool: { name: 'read_file', version: 1 },
          call, cell: 'read', argsDigest: 'a'.repeat(64), revision: matched.event.policyRevision }] } } });
      const joined = await publicShow(query.candidate, { sequence: correlated.sequence });
      expect(joined).toMatchObject({ exit: 0, err: '' });
      expect(JSON.parse(joined.out)).toEqual({ sequence: correlated.sequence, event: correlated.event,
        related: [{ sequence: allowance.sequence, event: allowance.event }], targetResolution: 'verified-match' });
    }, false);

    const purger = await openStore(f.path, ctx.config.storage.sqlite, 'forbid');
    try {
      const stored = await purger.loadInvocation('s', row.invocationId), { id, issuer, subject: principalSubject, assurance } = ctx.principal;
      await purger.purgeContent({ command: { schemaVersion: 1, commandId: 'candidate-control-purge', scopeId: 's', ...query.candidate,
        expectedContentDigest: stored!.content!.descriptor.digest }, actor: { id, issuer, subject: principalSubject, assurance },
      authorization: { revision: readerPolicy.revision, ruleId: 'fixture-purge' }, purgedAtMs: Date.now() });
    } finally { purger.close(); }
    await unresolved();
    const missingSequence = await publicShow(query.candidate, { sequence: 9999 });
    expect(missingSequence.exit).not.toBe(0);
    expect(missingSequence.err).toContain('AUDIT_RECORD_NOT_FOUND');

    const forged = new DatabaseSync(f.path);
    try {
      forged.exec('DROP TRIGGER audit_events_no_update');
      forged.prepare("UPDATE audit_events SET record=json_set(record,'$.event.policyRevision','forged-revision') WHERE scope_id=? AND sequence=?").run('s', row.sequence);
    } finally { forged.close(); }
    const tampered = await publicShow();
    expect(tampered.exit).not.toBe(0);
    expect(tampered.err).toContain('AUDIT_INTEGRITY');
    expect(tampered.out).toBe('');

  }
  return result;
}

for (const [cli, decision] of [['codex', 'allow'], ['claude', 'deny']] as const) {
  it.skipIf(process.platform !== 'linux')(`${cli}: one native subscription call produces one verified plan and person card (${decision})`, async () => {
    await run(cli, decision);
  }, 45_000);
}

it.skipIf(process.platform !== 'linux')('approval refuses a draft that current masking would change without a second body read or model call', async () => {
  await run('codex', 'masking-changed');
}, 45_000);

it.skipIf(process.platform !== 'linux')('approval refuses a draft when current masking changes only its original JSON text', async () => {
  await run('codex', 'raw-masking-changed');
}, 45_000);

it.skipIf(process.platform !== 'linux')('private read denial, lost connection and corrupt body stop before proposal, and cancellation stops at an open card', async () => {
  for (const decision of ['refuse', 'lost', 'corrupt', 'cancel-card'] as const) {
    await run('codex', decision);
    for (const close of cleanups.splice(0).reverse()) await close();
    vi.restoreAllMocks(); vi.clearAllMocks();
  }
}, 90_000);

it.skipIf(process.platform !== 'linux')('attributes a retained read refusal to the fresh policy that denied it', async () => {
  await run('codex', 'fresh-refusal');
}, 45_000);

it.skipIf(process.platform !== 'linux')('downgrades a verified candidate when the installation rebinds at the same ledger path', async () => {
  await run('codex', 'refuse', 'rebind');
}, 45_000);

it.skipIf(process.platform !== 'linux')('a keyed sign or append failure preserves the refusal and reaches only the original chat result note', async () => {
  const original = await run('codex', 'refuse', 'rebind');
  expect(original).toBeDefined();
  for (const fault of ['sign-failure', 'append-failure'] as const) {
    for (const close of cleanups.splice(0).reverse()) await close();
    vi.restoreAllMocks(); vi.clearAllMocks();
    const failed = await run('codex', 'refuse', fault);
    expect(failed).toEqual({ ...original, note: original!.note + ' ' + t('agent.refusalAudit.failed') });
  }
}, 90_000);
