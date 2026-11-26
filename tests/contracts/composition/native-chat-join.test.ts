import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';
import { createClaudeAgentDriver, toolSessionSchema, type ToolSessionPort } from '#capabilities/index.js';
import { createServerTurnChannel } from '#adapters/core/local-runtime-socket/index.js';
import { nativeQuotaPolicy } from '#adapters/core/native-connection/index.js';
import { FAMILY, PINNED, rateLimitLine } from '../../fixtures/native-headless/stream.js';
import { cancelPeerConfiguredModelInvocation, notifyNativeBuiltinPlugins, notifyNativePaidUsage } from '#composition/core/model-invocation/index.js';
import { createModelInvocationResponseEvidence, ModelInvocationStoreError, type ModelInvocationResult } from '#engine/core/model-invocation/index.js';
import { writeFakeCli, uiLine, initLine, assistantLine, resultLine } from '../../fixtures/native-headless/stream.js';
import { createServer, request, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { brainProviderFixture } from '../support/brain-provider.js';
import { createTerminalRuntimeClient, terminalRuntimePeer } from '../support/terminal-runtime-client.js';
import { NATIVE_CLI_HEADLESS_ADAPTER_ID, firstRunPolicyTemplate, modelInvocationProfileSchema, type ModelInvocationClaim, type AgentTurnMessage, type AgentTurnStreamEvent, type AgentToolCall } from '#domain/index.js';
import { createRuntimeChatTurnHost, runPeerConfiguredChatTurn, cancelPeerConfiguredChatTurn, type NativeChatRuntime } from '#composition/core/agent-turn/index.js';
import { describeTerminalChat, inspectNativeChat } from '#composition/core/terminal-chat/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { createNativeAgentDriver, nativeAgentFlagSetDigest, preflightNativeAgent } from '#adapters/core/native-cli-headless/index.js';
import { nativeAgentRealmAvailable, writeFakeAgentCli } from '../../fixtures/native-headless/agent.js';
import { cleanupConnections, connection, testIsolation } from '../../fixtures/native-headless/connection.js';
import { bindCapacityResource, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { headlessCapacityBinding } from '#adapters/core/sqlite-model-invocation/index.js';
import { readLocalOsIdentity, localPrincipalChannel, LocalOsSessionAuthority } from '#adapters/core/local-principal/index.js';
import { FIRST_RUN_TOOL_NAMES, ModelInvocationControllers, ModelInvocationPolicyAuthorization, fitChatTurnResult, modelInvocationProfileDigest } from '#engine/index.js';
import { clearConfigCache, clockText, ErrorRegistry, headlessDiagnostic, redactForRecord, SystemTrustedClock, t } from '#platform/index.js';
import { openSqliteAgentTurnStore } from '#adapters/index.js';
import * as adapters from '#adapters/index.js';
import { runDurableAgentTurn } from '#engine/index.js';
import { bindSessionScope, streamLineTurn, type TurnDelta } from '#surfaces/core/terminal-kit/index.js';
import { streamTerminalAgentTurn } from '#surfaces/core/terminal-turn/index.js';
import { mountWorkline } from '../support/workline-harness.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function unsupportedPeer() {
  if (process.platform === 'linux') return false;
  // Keep the unsupported native-session refusal active; never claim this as a walked PTY variant.
  await expect(LocalOsSessionAuthority.create(['s'], 1000, new SystemTrustedClock())).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
  console.log('verify-not-run: ' + JSON.stringify({ file: expect.getState().testPath, test: expect.getState().currentTestName,
    variant: 'native-chat-linux-PTY', reason: 'platform-unsupported', platform: process.platform }));
  return true;
}
async function fixture(askEdits = true, headless?: { executable: string; configDir: string; stateDir: string; protocolFamily: string }) {
  const owner = readLocalOsIdentity();
  const f = await brainProviderFixture({ headless: { executable: process.execPath, configDir: '/fixture-login', stateDir: '/fixture-state', ...headless,
    delegatedUse: { consentedBy: { issuer: owner.issuer, subject: owner.subject }, atMs: 1, classes: ['ai'] } } });
  cleanups.push(f.close);
  // No CLI/preflight/login runs: a code-only fake native port exercises the real composition, facade and durable stores.
  const profile = modelInvocationProfileSchema.parse(f.config.provider_invocation_profiles.profiles[0]);
  const entry = nativeCliAgent(profile.protocol.family)!;
  const execution = { schemaVersion: 1 as const, capability: 'NativeAgentExecution' as const, executable: process.execPath, cliVersion: '9.0.0',
    flagSetDigest: nativeAgentFlagSetDigest(entry), profileDigest: modelInvocationProfileDigest(profile), ownerUid: process.getuid!() };
  const readiness = { read: vi.fn(async () => ({ cli: true, login: true, environment: true, plugins: true, toolSurface: true, bridge: true, execution })) };
  const person = readLocalOsIdentity(), ai = { issuer: `${person.issuer}/mcp`, subject: person.subject };
  // R4a: the real first-run template (v19), no injected MCP grant; the person chose "ask for edits too", which the AI turn they start follows.
  const template = firstRunPolicyTemplate({ scopeId: 's', principal: { issuer: person.issuer, subject: person.subject }, ...FIRST_RUN_TOOL_NAMES });
  await writeFile(join(f.data, 'policy.json'), JSON.stringify(template.policy), { mode: 0o600 });
  await writeFile(join(f.data, 'bindings.json'), JSON.stringify({ schemaVersion: 3, revision: 'person-ask-edits', bindings: [],
    modes: askEdits ? [{ id: 'person-ask', principal: { issuer: person.issuer, subject: person.subject }, scopes: ['s'], mode: 'standart', askEdits: true }] : [] }), { mode: 0o600 });
  clearConfigCache();
  const peer = await terminalRuntimePeer(createTerminalRuntimeClient(f.project, f.options));
  const state = { limitAfterTool: null as null | 'credits-required' | 'quota', quotaWindow: null as null | { field: string; subtype: string; resetsAtMs: number },
    paidExtraUsage: null as null | { kind: string; status: string; window: string; resetsAtMs: number | null }, builtinPlugins: [] as string[], cliVersion: '2.1.322', servers: [] as Server[], calls: 0, closes: 0, revoked: false, result: '', token: '', prompt: '', channels: [] as (string | undefined)[] };
  const pin = Object.freeze({ scopeId: 's', fixture: true });
  const resolveModelUse = vi.fn<NativeChatRuntime['resolveModelUse']>(async (_profile, actor, check) => {
    expect(actor.issuer).toBe(ai.issuer);
    if (state.revoked) throw new Error('PROJECT_ATTACHMENT_DENIED');
    if (check.action === 'pin') return pin;
    expect(check.pin).toBe(pin);
  });
  const call: AgentToolCall = { id: 'unused', name: 'write_file', argumentsJson: JSON.stringify({ path: 'result.txt', content: 'approved business result\n' }) };
  const runtime: NativeChatRuntime = { readiness, limits: { idleMs: 30_000, maxConnections: 4, replayMaxEntries: 8, replayMaxBytes: 16 * entry.bridge.frameMaxBytes }, resolveModelUse,
    driver: async ({ session, paidExtraUsage, onPaidUsage }) => { expect(paidExtraUsage).toBe('continue'); return { port: session, admit: async () => undefined,
      native: (bridge, secrets) => ({ billingAxis: 'subscription', prepare: async (_profile, _definition, request) => { state.prompt = JSON.stringify(request); return {}; },
        async send(_prepared, signal) {
          state.calls++; state.token = bridge.turnToken;
          if (state.paidExtraUsage) await onPaidUsage?.(state.paidExtraUsage as never);
          expect(redactForRecord(bridge.turnToken, secrets.turn)).not.toContain(bridge.turnToken);
          const server = createServer((req, res) => { void bridge.handle(req, res, () => true); }); state.servers.push(server);
          await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
          const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture-address');
          let sessionId: string | undefined;
          const rpc = (body: object) => new Promise<{ body: string; status: number }>((resolve, reject) => {
            const req = request({ host: '127.0.0.1', port: address.port, method: 'POST', path: bridge.url,
              headers: { host: new URL(bridge.url).hostname, [entry.bridge.tokenHeaderName]: bridge.tokenHeader, accept: 'application/json, text/event-stream',
                'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, signal }, res => {
              sessionId ??= res.headers['mcp-session-id'] as string | undefined;
              let text = ''; res.on('data', chunk => { text += chunk; }); res.on('error', reject);
              res.on('end', () => resolve({ body: text, status: res.statusCode! }));
            }); req.on('error', reject); req.end(JSON.stringify(body));
          });
          expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'k11-fake-driver', version: '1' } } })).status).toBe(200);
          state.channels.push(localPrincipalChannel());
          const quota = state.limitAfterTool === 'quota';
          const args = state.limitAfterTool ? { path: quota ? `quota-${state.quotaWindow ? 'window-' : ''}result.txt` : 'credits-result.txt',
            content: 'retained before the refusal\n' } : JSON.parse(call.argumentsJson);
          const result = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: call.name, arguments: args, _meta: { 'claudecode/toolUseId': 'fake-use-1' } } });
          state.result = result.body;
          if (state.limitAfterTool) {
            return { kind: 'rejected', evidence: createModelInvocationResponseEvidence(profile.adapter, quota ? 'http-status' : 'interrupted', quota ? 429 : null,
              Buffer.from(JSON.stringify({ schemaVersion: 1, refusal: state.limitAfterTool, ...(quota && { status: 429, ...state.quotaWindow }) })), quota) };
          }
          return { schemaVersion: 1, native: { headless: { cliVersion: state.cliVersion, builtinPlugins: state.builtinPlugins, ...(state.paidExtraUsage ? { paidExtraUsage: state.paidExtraUsage } : {}) }, object: 'chat.completion', model: 'vendor/model', choices: [{ index: 0, message: { role: 'assistant', content: 'finished' }, finish_reason: 'stop' }] }, usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
        } }),
      refusal: () => null,
      close: async () => { state.closes++; for (const server of state.servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } } }; } };
  const host = createRuntimeChatTurnHost({ ownerId: 'k11-test-service', controllers: new ModelInvocationControllers(2) }, new AbortController().signal,
    undefined, undefined, () => [], undefined, runtime);
  const events: AgentTurnStreamEvent[] = [];
  let offer!: (event: Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>) => void;
  const offered = new Promise<Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>>(resolve => { offer = resolve; });
  const channel = { signal: new AbortController().signal, room: () => 1_000_000, drained: async () => true,
    emit(event: AgentTurnStreamEvent) { events.push(event); if (event.kind === 'approval.requested') offer(event); } };
  const command = { schemaVersion: 1, scopeId: 's', turnId: 'k11-turn', messages: [{ role: 'user', content: 'write the business result' }] };
  const run = (turnId = command.turnId, messages: readonly AgentTurnMessage[] | typeof command.messages = command.messages) => runPeerConfiguredChatTurn(f.project, { ...command, turnId, messages }, peer, f.options, { maxResultBytes: 65_536 }, host, channel);
  const decide = (event: Awaited<typeof offered>, decision: 'allow' | 'deny') => configuredApproval(f.project, 'decide', { schemaVersion: 1, scopeId: 's', commandId: 'decide-k11', approvalId: event.approvalId,
    expectedRevision: event.revision, decision, reason: 'synthetic person decision', channel: 'local-terminal-card', decisionCapability: event.decisionCapability }, f.options, peer, undefined, {}, host.decisions, host.answers);
  return { f, profile, runtime, execution, state, host, peer, events, run, offered, decide };
}

it('shows tools only for a matching capability, and does not spawn on inspection', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture();
  // R4b: not yet observed is "unverified" (the first turn verifies it), never "no tools"; a known refusal is "none".
  expect((await describeTerminalChat(h.f.project, h.f.options)).tools).toBe('unverified');
  expect((await describeTerminalChat(h.f.project, h.f.options, h.runtime)).tools).toBe('available');
  const ownerUid = h.execution.ownerUid, executable = h.execution.executable;
  h.execution.ownerUid = ownerUid + 1;
  const differentOwner = await describeTerminalChat(h.f.project, h.f.options, h.runtime);
  expect(differentOwner.tools).toBe('none');
  expect.soft(differentOwner.toolsDiagnostic?.localize?.('en').message)
    .toBe('The operating-system user in the agent execution record differs from the configured user.');
  expect.soft(differentOwner.toolsDiagnostic?.localize?.('tr').message)
    .toBe('Ajan yürütme kaydındaki işletim sistemi kullanıcısı yapılandırılan kullanıcıdan farklı.');
  h.execution.ownerUid = ownerUid;
  h.execution.executable = '/fixture/different-recorded-program';
  const differentProgram = await describeTerminalChat(h.f.project, h.f.options, h.runtime);
  expect(differentProgram.tools).toBe('none');
  expect.soft(differentProgram.toolsDiagnostic?.localize?.('en').message)
    .toBe('The verified program path differs from the path in the agent execution record.');
  expect.soft(differentProgram.toolsDiagnostic?.localize?.('tr').message)
    .toBe('Doğrulanan program yolu ajan yürütme kaydındaki yoldan farklı.');
  h.execution.executable = executable;
  h.execution.profileDigest = '0'.repeat(64);
  expect(await inspectNativeChat(h.profile, h.runtime)).toMatchObject({ state: 'unavailable', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' });
  expect((await describeTerminalChat(h.f.project, h.f.options, h.runtime)).tools).toBe('none');
  expect(h.state.calls).toBe(0); expect(h.runtime.resolveModelUse).not.toHaveBeenCalled();
});

it('keeps an AI requester, witnessed person decider, real write, durable replay and token redaction', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture(), running = h.run(), event = await Promise.race([h.offered, running.then(result => { throw new Error(JSON.stringify({ result, events: h.events, calls: h.state.calls })); })]);
  expect(await readFile(join(h.f.project, 'result.txt'), 'utf8').catch(() => null)).toBeNull();
  // R5c: the prompt states the witnessed person's mode (ask for edits too), not the MCP actor's plain standart.
  expect(h.state.prompt).toContain('- Permission mode: standart (the person also asks for every edit)');
  const decided = await h.decide(event, 'allow');
  const result = await running;
  expect(decided).toMatchObject({ request: { requester: { issuer: expect.stringMatching(/\/mcp$/u) } }, decision: { deciderClass: 'human-tty' } });
  expect((decided as { decision: { actor: { issuer: string } } }).decision.actor.issuer).not.toMatch(/\/mcp$/u);
  expect(result).toMatchObject({ finish: 'stop', answer: 'finished', toolCalls: 1, recorded: true });
  expect(await readFile(join(h.f.project, 'result.txt'), 'utf8')).toBe('approved business result\n');
  expect(await h.run()).toMatchObject({ replayed: true, toolCalls: 1 });
  expect(h.state.calls).toBe(1); expect(h.state.closes).toBe(1); expect(h.state.channels).toEqual(['mcp']);
  const resolve = h.runtime.resolveModelUse;
  h.runtime.resolveModelUse = async (profile, actor, check) => check.action === 'pin' ? { ...await resolve(profile, actor, check), companyId: 'changed-company' } : resolve(profile, actor, check);
  await expect(h.run()).rejects.toMatchObject({ code: 'AGENT_TURN_CONFLICT' });
  expect(h.state.calls).toBe(1);
  expect(JSON.stringify(h.events)).not.toContain(h.state.token);
  const db = new DatabaseSync(h.f.path, { readOnly: true });
  try { expect(db.prepare('SELECT COUNT(*) AS n FROM agent_turn_tool_calls').get()).toEqual(expect.objectContaining({ n: 1 })); }
  finally { db.close(); }
});

it('R4a: in the person\'s default standart the AI write runs without a card and is audited as the person\'s mode relaxation', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture(false);
  expect(await h.run()).toMatchObject({ finish: 'stop', toolCalls: 1 });
  expect(h.events.some(event => event.kind === 'approval.requested')).toBe(false);
  expect(await readFile(join(h.f.project, 'result.txt'), 'utf8')).toBe('approved business result\n');
  const db = new DatabaseSync(h.f.path, { readOnly: true });
  try {
    const records = (db.prepare("SELECT record FROM audit_events WHERE kind = 'permission-mode'").all() as { record: string }[]).map(row => JSON.parse(row.record));
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).toMatch(/"mode":"standart","cell":"edit-non-floor"/u);
    expect(JSON.stringify(records[0])).toContain('"company":"first-run-mcp-edit-shell-tools"');
  } finally { db.close(); }
  Object.assign(h.f.options.env, { DECKENT_LANGUAGE: 'en' });
  h.state.limitAfterTool = 'credits-required';
  const failed = await h.run('credits-after-tool');
  const sentence = 'The subscription asks for extra credits for this request.';
  expect(failed).toMatchObject({ finish: 'error', answer: null, toolCalls: 1, recorded: true });
  expect(await readFile(join(h.f.project, 'credits-result.txt'), 'utf8')).toBe('retained before the refusal\n');
  expect.soft(failed.note).toContain(sentence);
  expect.soft(failed.note).not.toMatch(/nothing was accepted|try again/u);
  expect.soft(t('error.HEADLESS_CREDITS_REQUIRED', {}, 'tr')).toBe('Abonelik bu istek için ek kredi istiyor.');
  expect(await h.run('credits-after-tool')).toMatchObject({ replayed: true, toolCalls: 1, note: failed.note });
  const oldAdvice = sentence + ' deckent never buys usage: nothing was accepted and no other model was chosen. Decide in your provider account, then try again.';
  const warning = 'Tool settlement is unknown.';
  const savedCreditNote = failed.note!.replace(sentence, `${warning} ${oldAdvice}`);
  const checkEffects = 'Check this turn’s earlier tool effects before repeating the work.';
  const checkEffectsTr = 'İşi tekrarlamadan önce bu turdaki önceki araç çağrılarının etkilerini denetleyin.';
  const oldQuota = 'Your subscription usage limit was reached. Try again after it resets or choose another model in /model. No API call is made automatically.';
  const historicalQuotaNote = failed.note!.replace(sentence, oldQuota);
  const quotaDiagnosis = `${checkEffects} ${oldQuota}`;
  let replayHistoricalQuota = false;
  const openTurn = adapters.openSqliteAgentTurnStore;
  const history = vi.spyOn(adapters, 'openSqliteAgentTurnStore').mockImplementation(async (...args) => {
    const retained = await openTurn(...args), claim = retained.claim.bind(retained);
    retained.claim = async input => {
      const stored = await claim(input);
      if (stored.status !== 'finished') return stored;
      const note = input.turnId === 'credits-after-tool' ? savedCreditNote : replayHistoricalQuota ? historicalQuotaNote : stored.outcome.note;
      return { ...stored, outcome: { ...stored.outcome, note } };
    };
    return retained;
  });
  try {
    const calls = h.state.calls, replay = await h.run('credits-after-tool');
    expect.soft(replay).toMatchObject({ replayed: true, recorded: true, toolCalls: 1 });
    const [saved, correction] = replay.note?.split('\n', 2) ?? [];
    expect.soft(correction).toBe(`Current correction: ${sentence}`);
    expect.soft(correction).not.toMatch(/nothing was accepted|try again/u);
    expect.soft(saved).toBe(`Saved note (historical wording): ${savedCreditNote}`);
    const capacity = Buffer.byteLength(JSON.stringify({ ...replay, note: null })) + 105;
    expect.soft(fitChatTurnResult({ ...replay, note: savedCreditNote.replace(oldAdvice, sentence) }, capacity).note).toContain(warning);
    expect.soft(fitChatTurnResult(replay, capacity).note).toContain(warning);
    expect(h.state.calls).toBe(calls);
    expect.soft(t('agent.turn.outcome.replayCorrection', { correction: '…' }, 'tr')).toBe('Güncel düzeltme: …');
    expect.soft(t('agent.turn.outcome.replaySavedNote', { note: '…' }, 'tr')).toBe('Kaydedilen not (önceki ifade): …');
    h.state.limitAfterTool = 'quota';
    const quota = await h.run('quota-after-tool');
    expect(quota).toMatchObject({ finish: 'error', answer: null, toolCalls: 1, recorded: true });
    expect(await readFile(join(h.f.project, 'quota-result.txt'), 'utf8')).toBe('retained before the refusal\n');
    expect.soft(quota.note).toContain(quotaDiagnosis);
    expect.soft(quota.note?.replace(quotaDiagnosis, '')).not.toMatch(/try again|choose another model/iu);
    expect.soft(t('headless.chat.quotaAfterTools', {}, 'tr')).toBe(checkEffectsTr);
    expect.soft(t('headless.chat.quotaFallback', {}, 'tr')).toBe('Aboneliğinizin kullanım sınırına ulaşıldı. Sıfırlanmasını bekleyin veya /model ile başka bir model seçin. Otomatik API çağrısı yapılmaz.');
    expect.soft(await h.run('quota-after-tool')).toMatchObject({ replayed: true, note: quota.note });
    replayHistoricalQuota = true;
    const replayedQuota = await h.run('quota-after-tool');
    expect.soft(replayedQuota.note).toBe(`Saved note (historical wording): ${historicalQuotaNote}\nCurrent correction: ${quotaDiagnosis}`);

    h.state.quotaWindow = { field: 'five_hour', subtype: 'rejected', resetsAtMs: 1792773600000 };
    const windowQuota = await h.run('window-quota-after-tool');
    const reset = clockText(h.state.quotaWindow.resetsAtMs);
    expect.soft(windowQuota).toMatchObject({ finish: 'error', answer: null, toolCalls: 1, recorded: true });
    expect.soft(windowQuota.note).toContain(`${checkEffects} The subscription's usage limit is reached (five-hour window). Resets at: ${reset} (local time). deckent made no charge and stopped this turn instead of continuing on paid extra usage. Wait for the reset, sign in with another account (\`deckent models login --connection claude-cli-subscription\`), or use another connection.`);
    expect.soft(t('headless.chat.quota', { window: t('headless.chat.quotaWindow.five_hour', {}, 'tr'), reset }, 'tr'))
      .toBe(`Aboneliğinizin kullanım sınırına ulaşıldı (beş saatlik pencere). Sıfırlanma: ${reset} (yerel saat). deckent ücret almadı ve bu turu ücretli ek kullanımla sürdürmek yerine durdurdu. Sıfırlanmasını bekleyin, başka bir hesapla giriş yapın (\`deckent models login --connection claude-cli-subscription\`) veya başka bir bağlantı kullanın.`);
  } finally { history.mockRestore(); }
});

it('lease revocation during the unchanged approval card prevent the exact requested write', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture(), running = h.run(), event = await Promise.race([h.offered, running.then(result => { throw new Error(JSON.stringify({ result, events: h.events, calls: h.state.calls })); })]);
  h.state.revoked = true;
  await h.decide(event, 'allow');
  await running;
  expect(await readFile(join(h.f.project, 'result.txt'), 'utf8').catch(() => null)).toBeNull();
  expect(h.state.result).not.toContain('wrote result.txt');
  expect(h.state.closes).toBe(1);
});

it('cancels a pending approval from the starting person while the model invocation stays open', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture(), running = h.run(); await Promise.race([h.offered, running.then(result => { throw new Error(JSON.stringify({ result, events: h.events, calls: h.state.calls })); })]);
  expect(await cancelPeerConfiguredChatTurn(h.f.project, { schemaVersion: 1, scopeId: 's', turnId: 'k11-turn' }, h.peer, h.f.options, h.host)).toMatchObject({ state: 'cancelling' });
  expect(await running).toMatchObject({ finish: 'cancelled', recorded: true });
  expect(await readFile(join(h.f.project, 'result.txt'), 'utf8').catch(() => null)).toBeNull();
  expect(h.state.closes).toBe(1);
});

it('keeps the requested target unchanged when the witnessed person denies the card', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture(), running = h.run(), event = await Promise.race([h.offered, running.then(result => { throw new Error(JSON.stringify({ result, events: h.events, calls: h.state.calls })); })]);
  await h.decide(event, 'deny');
  await running;
  expect(await readFile(join(h.f.project, 'result.txt'), 'utf8').catch(() => null)).toBeNull();
  expect(h.state.closes).toBe(1);
});

it('refuses a driver returning another tool session before any model send or effect', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture(), driver = h.runtime.driver;
  h.runtime.driver = async input => {
    const opened = await driver(input);
    return { ...opened, port: { ...opened.port, session: { ...opened.port.session, turnId: 'foreign-turn' } } };
  };
  expect(await h.run()).toMatchObject({ finish: 'error', recorded: true });
  expect(h.state.calls).toBe(0); expect(h.state.closes).toBe(1);
  expect(await readFile(join(h.f.project, 'result.txt'), 'utf8').catch(() => null)).toBeNull();
});

it.each(['admission', 'send'] as const)('renders a path-free typed refusal at the end of a turn after %s fails (EN/TR)', async phase => {
  if (await unsupportedPeer()) return;
  for (const [language, expected] of [
    ['en', 'The model round ended without an answer. The sign-in lock directory could not be created. No tool call ran.'],
    ['tr', 'Model turu yanıt alınamadan sona erdi. Giriş kilidi dizini oluşturulamadı. Hiçbir araç çağrısı çalıştırılmadı.'],
  ] as const) {
    const h = await fixture(), driver = h.runtime.driver;
    Object.assign(h.f.options.env, { DECKENT_LANGUAGE: language });
    const fail = async () => {
      throw ErrorRegistry.retainHeadlessFailedCheck(headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'lock-directory-create' }),
        '/fixture/turn-diagnostic-must-remain-local');
    };
    h.runtime.driver = async input => {
      const opened = await driver(input);
      return phase === 'admission' ? { ...opened, admit: fail } : { ...opened, native: (...args) => ({ ...opened.native(...args), send: fail }) };
    };
    const result = await h.run();
    expect.soft(result.note).toBe(expected);
    expect(result).toMatchObject({ finish: 'error', answer: null, toolCalls: 0, recorded: true });
    expect(result.note).not.toMatch(/yarıda kesildi|interrupted|\/fixture\//u);
  }
  if (phase !== 'send') return;
  const cleanup = await fixture(), cleanupDriver = cleanup.runtime.driver;
  Object.assign(cleanup.f.options.env, { DECKENT_LANGUAGE: 'en' });
  let fault = headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'agent-run-remove' });
  cleanup.runtime.driver = async input => {
    const opened = await cleanupDriver(input);
    return { ...opened, native: (...args) => ({ ...opened.native(...args), send: async () => { throw fault; } }) };
  };
  for (const [cause, next, nextTr, key] of [
    ['The agent turn’s temporary directory could not be removed.',
      'Check any tool results above and resolve the cleanup problem before sending another request.',
      'Yukarıdaki araç sonuçları varsa inceleyin ve yeni bir istek göndermeden önce temizlik sorununu giderin.', 'headless.chat.runCleanupNext'],
    ['The sign-in lock guard remained held at the end of the wait.',
      'Wait for the other operation to finish, then try again.', 'Diğer işlem bitince yeniden deneyin.', 'headless.chat.loginBusyNext'],
  ] as const) {
    cleanup.events.length = 0;
    const directory = join(cleanup.f.data, 'terminal-test-sessions');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const sessions = adapters.openTerminalSessionStore(directory), bound = bindSessionScope(sessions, 's', () => 1);
    const saved = Promise.withResolvers<string>(), deltas: TurnDelta[] = [];
    const note = `The model round ended without an answer. ${cause} No tool call ran.`;
    const view = mountWorkline({ sessions: { ...bound, async save(snapshot) { await bound.save(snapshot); saved.resolve(snapshot.sessionId); } },
      streamTurn: async function* (messages) {
        const input = { projectRoot: cleanup.f.project, scopeId: 's', messages, options: cleanup.f.options };
        const stream = streamTerminalAgentTurn(input, { async chatTurn(_root, command, onEvent) {
          const result = await cleanup.run(command.turnId, command.messages);
          expect.soft(result).toMatchObject({ finish: 'error', answer: null, toolCalls: 0, recorded: true, note });
          cleanup.events.forEach(onEvent);
          return result;
        }, cancelChatTurn: async () => { throw new Error('unexpected cancel'); } });
        for await (const delta of stream) { deltas.push(delta); yield delta; }
      } }, 220);
    try {
      await view.instance.waitUntilRenderFlush();
      view.stdin.write('fixture question\r');
      const sessionId = await saved.promise;
      const expected = { schemaVersion: 1, sessionId, scopeId: 's', updatedAtMs: 1, messages: [{ role: 'user', content: 'fixture question' }] };
      expect.soft(await readFile(join(directory, `${sessionId}.json`), 'utf8')).toBe(JSON.stringify(expected));
      expect.soft(await sessions.load('s', sessionId)).toEqual(expected.messages);
      await view.instance.waitUntilRenderFlush();
      expect.soft(view.stdout.text).toContain(next);
      let drawn = '';
      const line = await streamLineTurn((async function* () { yield* deltas; })(), {
        out: { write: text => { drawn += text; } }, err: { write: () => {} }, cancel: () => {}, project: text => text,
        toolLine: () => '', approvalLine: () => '',
      });
      expect.soft(drawn).toContain(note);
      expect.soft(drawn).toContain(next);
      expect.soft(line).toMatchObject({ finish: 'error', answer: note, appended: [] });
      expect.soft(t(key, {}, 'tr')).toBe(nextTr);
    } finally { view.instance.unmount(); }
    fault = headlessDiagnostic('HEADLESS_LOGIN_BUSY', { holder: 'guard' });
  }

  // Y25/Y26: a model refusal returned as the turn's rejection whose receipt cannot be recorded still names its check in the final note.
  const h = await fixture(), driver = h.runtime.driver, open = adapters.openSqliteModelInvocationStore;
  Object.assign(h.f.options.env, { DECKENT_LANGUAGE: 'en' });
  const store = vi.spyOn(adapters, 'openSqliteModelInvocationStore').mockImplementation(async (...args) => Object.assign(await open(...args),
    { recordRejected: async () => { throw new Error('fixture-record-failed'); } }));
  h.runtime.driver = async input => {
    const opened = await driver(input), body = Buffer.from(JSON.stringify({ schemaVersion: 1, refusal: 'model-mismatch', field: 'assistant', subtype: 'model-reported' }));
    return { ...opened, returnedRefusal: () => ({ reason: 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED' as const, check: 'agent-surface:assistant' }),
      native: (...args) => ({ ...opened.native(...args), send: async () => ({ kind: 'rejected' as const,
        evidence: createModelInvocationResponseEvidence(input.profile.adapter, 'model-mismatch', null, body, true) }) }) };
  };
  try {
    expect.soft((await h.run()).note).toBe("The model round ended without an answer. The CLI's tool surface or tool protocol could not be verified as expected."
      + ' (agent-surface:assistant) No tool call ran.');
  } finally { store.mockRestore(); }

  const sample = await adapters.openSqliteModelInvocationReader(h.f.path, { busyTimeoutMs: 1000 });
  const readerMethods = Object.getPrototypeOf(sample) as Pick<typeof sample, 'loadInspection'>;
  sample.close();
  const reader = vi.spyOn(readerMethods, 'loadInspection').mockRejectedValue(new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE'));
  try {
    const result = await h.run('model-inspection-unavailable');
    expect(reader).toHaveBeenCalledOnce();
    expect.soft(result.note).toContain('(agent-surface:assistant)');
    expect(result).toMatchObject({ finish: 'error', answer: null, recorded: true });
    const authorize = ModelInvocationPolicyAuthorization.prototype.authorize;
    const policy = vi.spyOn(ModelInvocationPolicyAuthorization.prototype, 'authorize').mockImplementation(function (this: ModelInvocationPolicyAuthorization, ...args) {
      if (args[0] === 'inspect-content') return Promise.reject(ErrorRegistry.createError('POLICY_DENIED'));
      return authorize.apply(this, args);
    });
    try {
      expect((await h.run('model-inspection-denied')).note).not.toContain('agent-surface:assistant');
    } finally { policy.mockRestore(); }
  } finally { reader.mockRestore(); }

  const providerBody = { schemaVersion: 1, refusal: 'quota', status: 429 } as const;
  const write = vi.spyOn(adapters, 'openSqliteModelInvocationStore').mockImplementation(async (...args) => Object.assign(await open(...args),
    { recordUnknown: async () => { throw new Error('fixture-unknown-record-failed'); } }));
  h.runtime.driver = async input => {
    const opened = await driver(input);
    return { ...opened, returnedRefusal: () => ({ body: providerBody }),
      native: (...args) => ({ ...opened.native(...args), send: async () => ({ kind: 'rejected' as const,
        evidence: createModelInvocationResponseEvidence(input.profile.adapter, 'interrupted', null, Buffer.from(JSON.stringify(providerBody)), false) }) }) };
  };
  try {
    const result = await h.run('provider-record-unknown-failed');
    expect(result).toMatchObject({ finish: 'error', answer: null, toolCalls: 0, recorded: true });
    expect.soft(result.note).toContain('usage limit');
  } finally { write.mockRestore(); }

  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const c = await connection();
  cleanups.push(cleanupConnections);
  const protocolFamily = 'codex-jsonl', executable = await writeFakeAgentCli(join(c.root, 'bin'), protocolFamily,
    { events: [{ type: 'turn.failed', error: { message: 'Rate limit reached' } }] });
  const codex = await fixture(false, { executable, configDir: c.configDir, stateDir: join(c.root, 'codex-state'), protocolFamily });
  Object.assign(codex.f.options.env, { DECKENT_LANGUAGE: 'en' });
  const sealed = await preflightNativeAgent(codex.profile, Date.now, testIsolation);
  Object.assign(codex.execution, sealed.execution);
  codex.runtime.driver = async ({ profile, execution, session }) => createNativeAgentDriver({ profile, execution, session, now: Date.now, isolation: testIsolation });
  const quotaWithoutTools = 'Your subscription usage limit was reached. Try again after it resets or choose another model in /model. No API call is made automatically.';
  const rejectWrite = vi.fn(async () => { throw new Error('fixture-codex-record-failed'); });
  const rejectStore = vi.spyOn(adapters, 'openSqliteModelInvocationStore').mockImplementation(async (...args) => Object.assign(await open(...args),
    { recordRejected: rejectWrite }));
  try {
    const result = await codex.run('codex-rejection-write-failed');
    expect(rejectWrite).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ finish: 'error', answer: null, toolCalls: 0, recorded: true });
    expect.soft(result.note).toContain(quotaWithoutTools);
    expect.soft(result.note).not.toContain('it is recorded');
  } finally { rejectStore.mockRestore(); }
  const unavailableRead = vi.spyOn(readerMethods, 'loadInspection').mockRejectedValue(new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE'));
  try {
    const result = await codex.run('codex-inspection-unavailable');
    expect(unavailableRead).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ finish: 'error', answer: null, toolCalls: 0, recorded: true });
    expect.soft(result.note).toContain(quotaWithoutTools);
  } finally { unavailableRead.mockRestore(); }
});

it('keeps the summary refusal before and after claim in the final note in EN and TR', async () => {
  if (await unsupportedPeer()) return;
  const refusal = ErrorRegistry.retainHeadlessFailedCheck(headlessDiagnostic('HEADLESS_LOGIN_REQUIRED', { reason: 'reported-signed-out' }),
    '/fixture/summary-diagnostic-must-remain-local');
  const history: AgentTurnMessage[] = [...Array.from({ length: 16 }, (_, index): AgentTurnMessage => index % 2
    ? { role: 'assistant', content: 'Earlier answer', toolCalls: [] } : { role: 'user', content: 'Earlier question' }),
  { role: 'user', content: 'Continue' }];
  for (const [language, expected] of [
    ['en', 'The status check reported that the subscription CLI was signed out.'],
    ['tr', "Durum denetimi abonelik CLI'ında oturum açılmadığını bildirdi."],
  ] as const) {
    const h = await fixture();
    Object.assign(h.f.options.env, { DECKENT_LANGUAGE: language });
    const config = { ...h.f.config, terminal: { ...h.f.config.terminal,
      chat: { ...h.f.config.terminal.chat, compactionThresholdTokens: 1 } } };
    await writeFile(join(h.f.project, '.deckent/config.json'), JSON.stringify(config));
    clearConfigCache();
    const preflight = vi.fn(async () => undefined);
    const send = vi.fn<ReturnType<typeof adapters.createNativeCliHeadlessPort>['send']>(async () => { throw refusal; });
    const port = vi.spyOn(adapters, 'createNativeCliHeadlessPort').mockReturnValue({
      billingAxis: 'subscription', preflight, prepare: async () => ({}), send,
    });
    try {
      preflight.mockRejectedValueOnce(refusal);
      const admission = await h.run('summary-admission', history);
      expect(preflight).toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      const returned = await h.run('summary-returned', history);
      expect(send).toHaveBeenCalledOnce();
      for (const result of [admission, returned]) {
        expect(result).toMatchObject({ finish: 'error', answer: null, toolCalls: 0 });
        expect.soft(result.note).toContain(expected);
        expect.soft(result.note).toContain(language === 'en' ? 'Sign in through the subscription CLI' : 'abonelik CLI\'ı üzerinden oturum açın');
        expect.soft(result.note).toMatch(language === 'en' ? /could not be compacted.*Nothing more was sent/u : /kısaltılamadı.*Yeni bir istek gönderilmedi/u);
        expect.soft(result.note).not.toMatch(/Send the message again|iletiyi yeniden gönderin|\/fixture\//u);
      }
      send.mockResolvedValueOnce({ kind: 'rejected', evidence: createModelInvocationResponseEvidence(h.profile.adapter,
        'response-limit', null, Buffer.from(JSON.stringify({ schemaVersion: 1, refusal: 'resource-limit', field: 'cpu-time' })), true) });
      const bounded = await h.run('summary-resource-bound', history);
      expect.soft(bounded.note).toContain(language === 'en' ? 'The isolated process returned a status reserved for the CPU-time limit.'
        : 'Yalıtılmış süreç, CPU süresi sınırına ayrılan çıkış kodunu döndürdü.');
      expect.soft(bounded.note).not.toMatch(/Send the message again|iletiyi yeniden gönderin/u);
      for (const [scenario, body, reason, complete, en, tr] of [
        ['guard', { schemaVersion: 1, refusal: 'guard', field: '/fixture/private-guard' }, 'invalid-response', true,
          'A safety check refused the subscription CLI result.', "Bir güvenlik denetimi abonelik CLI'ının sonucunu reddetti."],
        ['output', { schemaVersion: 1, refusal: 'response-limit' }, 'response-limit', true,
          'An output limit was reached while processing the subscription CLI call.', 'Abonelik CLI çağrısı işlenirken bir çıktı sınırına ulaşıldı.'],
        ['signal', { schemaVersion: 4, refusal: 'process-exit', exitCode: null, signal: 'SIGTERM', stderrSummary: '/fixture/private-stderr' }, 'interrupted', false,
          'A signal was observed for the launched isolation command. The invocation outcome is unknown.', 'Başlatılan yalıtım komutunda bir sinyal gözlendi. Çağrının sonucu belirsiz.'],
        ['code', { code: 'HEADLESS_PREFLIGHT_FAILED' }, 'interrupted', false,
          'The record contains the error code HEADLESS_PREFLIGHT_FAILED. The specific cause could not be determined.',
          'Kayıtta HEADLESS_PREFLIGHT_FAILED hata kodu var. Hatanın kesin nedeni belirlenemedi.'],
      ] as const) {
        send.mockResolvedValueOnce({ kind: 'rejected', evidence: createModelInvocationResponseEvidence(h.profile.adapter,
          reason, null, Buffer.from(JSON.stringify(body)), complete) });
        const result = await h.run(`summary-${scenario}`, history);
        expect(result).toMatchObject({ finish: 'error', answer: null, toolCalls: 0 });
        expect.soft(result.note).toContain(language === 'en' ? en : tr);
        expect.soft(result.note).not.toMatch(/Send the message again|iletiyi yeniden gönderin|\/fixture\/|SIGTERM/u);
      }
      expect(h.events.some(event => event.kind === 'compacted')).toBe(false);
      expect(h.state.calls).toBe(0);
    } finally { port.mockRestore(); }
  }
});

it('derives verification execution and readiness from the same guarded observation', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture();
  const common = { cli: true, login: true, environment: true, plugins: true, toolSurface: true, execution: h.execution };
  const mismatch = 'The operating-system user in the agent execution record differs from the configured user.\n';
  h.runtime.preflight = vi.fn(async () => undefined);
  const read = vi.fn<NativeChatRuntime['readiness']['read']>();
  h.runtime.readiness.read = read;
  for (const [turnId, later, bridge] of [['stale-bridge-refusal', { ...common, bridge: false }, true],
    ['stale-unknown', { diagnostic: headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'recorded-program-unverified' }) }, undefined]] as const) {
    h.events.length = 0;
    read.mockReset().mockResolvedValueOnce(common)
      .mockResolvedValueOnce({ ...common, ...(bridge === true && { bridge }), execution: { ...h.execution, ownerUid: h.execution.ownerUid + 1 } })
      .mockResolvedValue(later);
    const result = await h.run(turnId);
    expect.soft(result.note).toContain(mismatch.trim());
    expect.soft(h.events.find(event => event.kind === 'text')).toMatchObject({ text: mismatch });
    expect.soft(read).toHaveBeenCalledTimes(2);
    expect.soft((await h.run(turnId)).note).toBe(result.note);
    expect(h.state.calls).toBe(0);
  }
  h.events.length = 0;
  read.mockReset().mockResolvedValueOnce(common).mockResolvedValue({ ...common, bridge: false });
  await h.run('observed-bridge-refusal');
  expect(h.events.find(event => event.kind === 'text')).toMatchObject({ text: 'The governed tool bridge is unavailable. No agent tool can run until it is ready.\n' });
  expect(h.state.calls).toBe(0);

  const nativeSend = vi.fn(async () => ({ schemaVersion: 1 as const, native: { object: 'chat.completion', model: 'vendor/model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'recorded native answer' }, finish_reason: 'stop' }] }, usage: {} }));
  const driver = h.runtime.driver;
  h.runtime.driver = async input => {
    const opened = await driver(input);
    return { ...opened, native: (...args) => ({ ...opened.native(...args), send: nativeSend }) };
  };
  read.mockReset().mockResolvedValue({ ...common, bridge: true });
  const recorded = await h.run('recorded-native');
  expect(recorded).toMatchObject({ finish: 'stop', answer: 'recorded native answer', toolCalls: 0, recorded: true });

  read.mockReset().mockResolvedValueOnce({ ...common, toolSurface: null, plugins: null })
    .mockResolvedValueOnce({ ...common, bridge: true })
    .mockResolvedValue({ ...common, bridge: false });
  await expect.soft(h.run('recorded-native')).resolves.toMatchObject({ ...recorded, replayed: true });
  expect(read).toHaveBeenCalledTimes(2);
  expect(nativeSend).toHaveBeenCalledOnce();
  expect(h.state.calls).toBe(0);
});

it('owner 2026-11-05: an unrecognised CLI event the turn went on through is the turn\'s recorded note, not a pause', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture(false), driver = h.runtime.driver;
  h.runtime.driver = async input => ({ ...await driver(input), notices: () => ['system/future_notice'] });
  h.state.builtinPlugins = ['cc-plugin-unseen', 'cc-plugin-unseen'];
  h.state.paidExtraUsage = { kind: 'overage', status: 'rejected', window: 'five_hour', resetsAtMs: 1792773600000 };
  const result = await h.run();
  expect(result).toMatchObject({ finish: 'stop', answer: 'finished', recorded: true });
  expect(result.note).toContain('system/future_notice');
  expect(result.note).toContain('Paid extra usage of your provider account is in use');
  const message = '[deckent] Claude CLI 2.1.322 loaded a new built-in plugin: cc-plugin-unseen. Nothing was blocked; this observation is recorded with the turn.';
  expect(result.note?.split(message)).toHaveLength(2);
  expect((await h.run()).note).toBe(result.note); // Durable replay; no new invocation.
  const again = await h.run('builtin-again');
  expect(again.note).not.toContain('cc-plugin-unseen'); expect(again.note).not.toContain('Paid extra usage');
  h.state.cliVersion = '2.1.323';
  expect((await h.run('builtin-next-version')).note).toContain('CLI 2.1.323');
  const ledger = openSqliteLedger(h.f.path, { busyTimeoutMs: 1000, journalMode: 'delete', durability: 'full' }, 'forbid');
  try {
    const outcomes = ledger.prepare("SELECT record FROM agent_turns WHERE turn_id='k11-turn'").get();
    expect(JSON.stringify(outcomes)).toContain('cc-plugin-unseen');
    // The existing invocation content retains version/name on every call, even when notice suppression applies.
    const records = ledger.prepare("SELECT record FROM model_invocation_contents ORDER BY invocation_id").all();
    const observed = records.map(row => JSON.parse(String(row.record))).filter(row => JSON.stringify(row).includes('cc-plugin-unseen'));
    expect(observed).toHaveLength(3);
    expect(JSON.stringify(observed)).toContain('2.1.322');
    expect(JSON.stringify(observed)).toContain('paidExtraUsage');
    expect(JSON.stringify(observed)).toContain('2.1.323');
  } finally { ledger.close(); }

  expect(await readFile(join(h.f.project, 'result.txt'), 'utf8')).toBe('approved business result\n');
});

it('shows a plugin mismatch and keeps the same subscription text path usable with tools off', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture(), bin = join(h.f.data, 'fake-bin'), login = join(h.f.data, 'fake-login');
  await mkdir(bin, { mode: 0o700 }); await mkdir(login, { mode: 0o700 });
  const logPath = join(login, '.claude.json');
  const executable = await writeFakeCli(bin, { logPath, initCwd: 'actual', steps: [uiLine(), initLine({ model: 'vendor/model' }),
    assistantLine('tools-off text answer', 'vendor/model'), resultLine('tools-off text answer', {}, 'vendor/model')].map(line => ({ line })) });
  const configFile = join(h.f.project, '.deckent', 'config.json'), config = JSON.parse(await readFile(configFile, 'utf8'));
  Object.assign(config.provider_invocation_profiles.profiles[0].adapter.definition, { executable, configDir: login, stateDir: join(h.f.data, 'fake-state') });
  // This replacement login has its own resource, just as a witnessed reconnect would persist.
  const db = openSqliteLedger(h.f.path, { busyTimeoutMs: 1000, journalMode: 'delete', durability: 'full' }, 'forbid');
  try { bindCapacityResource(db, headlessCapacityBinding(config.provider_invocation_profiles.profiles[0].adapter.definition), {
    executionSlots: h.profile.allocation.maxInFlight, inFlightSlots: h.profile.allocation.maxInFlight,
  }); } finally { db.close(); }
  await writeFile(configFile, JSON.stringify(config)); clearConfigCache();
  const preflight = h.runtime.preflight = vi.fn(async () => {});
  h.runtime.readiness.read = async () => ({ cli: true, login: true, environment: true, toolSurface: true, bridge: true, plugins: false, execution: h.execution });
  expect(await h.run()).toMatchObject({ answer: 'tools-off text answer', toolCalls: 0, recorded: true });
  expect(h.events.some(event => event.kind === 'text' && /plugin/iu.test(event.text))).toBe(true);
  expect(preflight).not.toHaveBeenCalled();
  expect(h.runtime.resolveModelUse).not.toHaveBeenCalled(); expect(h.state.calls).toBe(0);
  const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(calls.filter(row => row.mode === 'call')).toHaveLength(1);
});

it('shows the current driver plugin refusal even after an earlier readiness seal, with no fallback or effect', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture(), driver = h.runtime.driver;
  h.runtime.driver = async input => {
    const opened = await driver(input);
    return { ...opened, refusal: () => 'NATIVE_AGENT_PLUGIN_UNEXPECTED', native: () => ({ billingAxis: 'subscription', prepare: async () => ({}),
      send: async () => ({ schemaVersion: 1, native: { object: 'chat.completion', model: 'vendor/model', choices: [{ index: 0,
        message: { role: 'assistant', content: 'must be withheld' }, finish_reason: 'stop' }] }, usage: {} }) }) };
  };
  const result = await h.run();
  expect(result).toMatchObject({ finish: 'error', answer: null, recorded: true });
  expect(result.note).toMatch(/plugin/iu);
  expect(h.state.calls).toBe(0); expect(h.state.closes).toBe(1);
  expect(await readFile(join(h.f.project, 'result.txt'), 'utf8').catch(() => null)).toBeNull();
});

it('cancels the first no-model preflight from the starting person before any model send or tool effect', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let probeSignal: AbortSignal | undefined;
  h.runtime.readiness.read = async () => ({ cli: true, login: true, environment: true, execution: h.execution });
  h.runtime.preflight = async (_profile, signal) => {
    probeSignal = signal; started.resolve(); await release.promise; signal.throwIfAborted();
    throw Object.assign(new Error('fixture-preflight-ended'), { code: 'HEADLESS_ISOLATION_UNAVAILABLE' });
  };
  const pending = h.run();
  try {
    await started.promise;
    expect(await cancelPeerConfiguredChatTurn(h.f.project, { schemaVersion: 1, scopeId: 's', turnId: 'k11-turn' }, h.peer, h.f.options, h.host)).toMatchObject({ state: 'cancelling' });
    expect(probeSignal?.aborted).toBe(true);
    release.resolve();
    expect(await pending).toMatchObject({ finish: 'cancelled', toolCalls: 0, recorded: true });
    expect(h.state.calls).toBe(0); expect(h.host.running.size).toBe(0);
    expect(h.events.filter(event => event.kind === 'text')).toEqual([]);
    expect(await readFile(join(h.f.project, 'result.txt'), 'utf8').catch(() => null)).toBeNull();
  } finally { release.resolve(); await pending.catch(() => undefined); }
});

it('retains a preflight refusal in the replayed note when cancellation arrives first', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture(), started = Promise.withResolvers<void>();
  h.runtime.readiness.read = async () => ({ cli: true, login: true, environment: true, execution: h.execution });
  h.runtime.preflight = async (_profile, signal) => {
    started.resolve();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    throw headlessDiagnostic('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'login-lock', reason: 'guard-unsafe' });
  };
  const pending = h.run();
  await started.promise;
  expect(await cancelPeerConfiguredChatTurn(h.f.project, { schemaVersion: 1, scopeId: 's', turnId: 'k11-turn' }, h.peer, h.f.options, h.host)).toMatchObject({ state: 'cancelling' });
  const first = await pending;
  expect(first).toMatchObject({ finish: 'cancelled', recorded: true });
  expect.soft(first.note).toContain('The sign-in lock guard failed its safety check.');
  delete h.runtime.preflight;
  expect(await h.run()).toMatchObject({ finish: 'cancelled', replayed: true, note: first.note });
  h.runtime.preflight = async () => { throw headlessDiagnostic('HEADLESS_ISOLATION_UNAVAILABLE', { check: 'login-lock', reason: 'guard-unsafe' }); };
  const fallback = await h.run('ordinary-fallback');
  expect.soft(fallback.note).toContain('The sign-in lock guard failed its safety check.');
  expect(await h.run('ordinary-fallback')).toMatchObject({ replayed: true, note: fallback.note });
  expect(h.state.calls).toBe(0);
});

it('ends compaction when only its governed invocation was cancelled', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture(), sent = Promise.withResolvers<void>();
  const config = { ...h.f.config, terminal: { ...h.f.config.terminal,
    chat: { ...h.f.config.terminal.chat, compactionThresholdTokens: 1 } } };
  await writeFile(join(h.f.project, '.deckent/config.json'), JSON.stringify(config));
  clearConfigCache();
  const history: AgentTurnMessage[] = [...Array.from({ length: 16 }, (_, index): AgentTurnMessage => index % 2
    ? { role: 'assistant', content: 'Earlier answer', toolCalls: [] } : { role: 'user', content: 'Earlier question' }),
  { role: 'user', content: 'Continue' }];
  const port = vi.spyOn(adapters, 'createNativeCliHeadlessPort').mockReturnValue({
    billingAxis: 'subscription', preflight: async () => undefined, prepare: async () => ({}),
    async send(_prepared, signal) {
      sent.resolve();
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
      signal!.throwIfAborted();
      throw new Error('fixture invocation did not abort');
    },
  });
  const register = h.host.model.controllers.register.bind(h.host.model.controllers);
  let claim!: ModelInvocationClaim;
  const controller = vi.spyOn(h.host.model.controllers, 'register').mockImplementation((row, owner) => {
    claim = row;
    return register(row, owner);
  });
  try {
    const pending = h.run('summary-invocation-cancelled', history);
    await sent.promise;
    await cancelPeerConfiguredModelInvocation(h.f.project, { schemaVersion: 1, commandId: 'cancel-summary-only', scopeId: 's',
      targetCommandId: claim.commandId, expectedRequestDigest: claim.requestDigest, reference: h.profile.reference },
      h.peer, h.f.options, undefined, h.host.model.controllers);
    expect(await pending).toMatchObject({ finish: 'cancelled', answer: null, note: expect.stringContaining('The summary call was cancelled.') });
    expect(h.state.calls).toBe(0);
  } finally { controller.mockRestore(); port.mockRestore(); }
});

it('builtin notices use session memory once per terminal/version/name with EN/TR text and no persistent counters', async () => {
  const f = await brainProviderFixture({ headless: { executable: process.execPath, configDir: '/fixture-login', stateDir: '/fixture-state' } });
  cleanups.push(f.close);
  const session = {}, notices: string[] = [];
  const result = { replayed: false, receipt: { profile: f.config.provider_invocation_profiles.profiles[0], claim: { scopeId: 's' } },
    response: { native: { headless: { cliVersion: '2.1.322', builtinPlugins: ['cc-plugin-unseen', 'cc-plugin-unseen'] } } } } as unknown as ModelInvocationResult;
  const notify = (value = result, language: 'en' | 'tr' = 'en', terminal = 'terminal-1', host = session) =>
    notifyNativeBuiltinPlugins(value, language, host, terminal, text => { notices.push(text); });
  await Promise.all([notify(), notify()]);
  expect(notices).toEqual(['[deckent] Claude CLI 2.1.322 loaded a new built-in plugin: cc-plugin-unseen. Nothing was blocked; this observation is recorded with the turn.']);
  await notify(); expect(notices).toHaveLength(1);
  const next = { ...result, response: { schemaVersion: 1 as const, native: { headless: { cliVersion: '2.1.323', builtinPlugins: ['cc-plugin-unseen'] } }, usage: null } };
  await notify(next, 'tr');
  expect(notices[1]).toBe('[deckent] Claude CLI 2.1.323 yeni bir yerleşik eklenti yükledi: cc-plugin-unseen. Hiçbir şey engellenmedi; bu gözlem turun kanıtına kaydedildi.');
  await notify({ ...next, replayed: true }); expect(notices).toHaveLength(2);
  await notify(result, 'en', 'terminal-2'); expect(notices).toHaveLength(3);
  await notify(result, 'en', 'terminal-1', {}); expect(notices).toHaveLength(4); // A fresh runtime may show it again.
  const db = new DatabaseSync(f.path, { readOnly: true });
  try { expect(db.prepare("SELECT count(*) AS total FROM audit_counters WHERE counter LIKE 'native-builtin:%'").get()?.total).toBe(0); }
  finally { db.close(); }
});

const pluginResult = (builtinPlugins: string[], cliVersion = '2.1.322') => ({ replayed: false,
  receipt: { profile: { adapter: { id: NATIVE_CLI_HEADLESS_ADAPTER_ID } }, claim: { scopeId: 's' } },
  response: { native: { headless: { cliVersion, builtinPlugins } } } }) as unknown as ModelInvocationResult;

it('bounds a very long builtin name and CLI version with a visible cut mark', async () => {
  const result = pluginResult(['x'.repeat(4096)], 'v'.repeat(4096)), notices: string[] = [];
  await notifyNativeBuiltinPlugins(result, 'en', {}, 'terminal', text => { notices.push(text); });
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain(`${'x'.repeat(127)}…`);
  expect(notices[0]).toContain(`${'v'.repeat(63)}…`);
  expect(notices[0]!.length).toBeLessThan(512);
  expect(JSON.stringify(result)).toContain('x'.repeat(4096)); // Private evidence is not rewritten.
});

it('caps a builtin notice list and tells the person how many more names were observed in EN/TR', async () => {
  const result = pluginResult(Array.from({ length: 100 }, (_, i) => `unseen-${i}`));
  for (const [language, more] of [['en', '+96 more'], ['tr', '+96 tane daha']] as const) {
    const session = {}, notices: string[] = [];
    const notify = () => notifyNativeBuiltinPlugins(result, language, session, 'terminal', text => { notices.push(text); });
    await notify(); await notify();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(`unseen-0, unseen-1, unseen-2, unseen-3, ${more}`);
    expect(notices[0]).not.toContain('unseen-4');
  }
});

it('projects builtin control characters, newlines and tabs to a single line without changing identity deduplication', async () => {
  const session = {}, notices: string[] = [];
  const notify = (names: string[]) => notifyNativeBuiltinPlugins(pluginResult(names, '2.1.\n\t322'), 'en', session, 'terminal', text => { notices.push(text); });
  await notify(['cc\n\r\t\u0007\u007f\u0085\u2028\u2029\u202e-plugin-odd']);
  expect(notices[0]).toContain('CLI 2.1.322');
  expect(notices[0]).toContain('cc-plugin-odd');
  expect(notices[0]).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  await notify(['cc-plugin-odd']);
  expect(notices).toHaveLength(2); // Same presentation, different wire identity.
});

it('retries builtin notice delivery after failure and deduplicates concurrent successful deliveries', async () => {
  const session = {}, result = pluginResult(['cc-plugin-unseen']), delivered: string[] = [];
  await expect(notifyNativeBuiltinPlugins(result, 'en', session, 'terminal', async () => { throw new Error('delivery-failed'); })).rejects.toThrow('delivery-failed');
  const notify = () => notifyNativeBuiltinPlugins(result, 'en', session, 'terminal', async text => { await Promise.resolve(); delivered.push(text); });
  await Promise.all([notify(), notify()]);
  expect(delivered).toHaveLength(1);
});

it('finishes and records a turn with long, many and multiline builtin names within the joined note budget', async () => {
  const f = await brainProviderFixture(); cleanups.push(f.close);
  const store = await openSqliteAgentTurnStore(f.path, { busyTimeoutMs: 1000, journalMode: 'delete', durability: 'full' });
  try {
    const notices: string[] = [], session = {};
    const names = ['x'.repeat(4096), 'cc\n\t\u0007-plugin-odd', ...Array.from({ length: 100 }, (_, i) => `unseen-${i}`)];
    const claim = { scopeId: 's', turnId: 'bounded-plugins', principalKey: 'fixture', requestDigest: 'a'.repeat(64), claimedAtMs: 1 };
    const result = await runDurableAgentTurn({ claim, messages: [], tools: [], signal: new AbortController().signal, emit: () => undefined }, store, {
      async invokeRound() {
        // Multiple successful invocations can contribute notes to one turn.
        for (let i = 0; i < 16; i++) await notifyNativeBuiltinPlugins(pluginResult(names, `2.1.${322 + i}`), 'en', session, 'terminal', text => { notices.push(text); });
        return { status: 'responded', content: 'finished', reasoning: '', toolCalls: [], finish: 'stop', usage: null };
      },
      hostNote: () => notices.join(' '), authorize: async () => 'allow', describe: () => null,
      execute: async () => { throw new Error('no tools'); }, now: () => 2,
    });
    expect(notices.join(' ').length).toBeGreaterThan(4096);
    expect(result).toMatchObject({ finish: 'stop', answer: 'finished', recorded: true });
    expect(result.note!.length).toBeLessThanOrEqual(4096);
    expect(result.note).toContain('cc-plugin-odd');
    expect(result.note).toContain('+98 more');
    expect(result.note).toMatch(/…$/u);
    expect(result.note).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(await store.claim(claim)).toMatchObject({ status: 'finished', outcome: { note: result.note } });
  } finally { store.close(); }
});

it('delivers the paid-usage notice once after successful delivery and records it in the existing turn note', async () => {
  const f = await brainProviderFixture(); cleanups.push(f.close);
  const store = await openSqliteAgentTurnStore(f.path, { busyTimeoutMs: 1000, journalMode: 'delete', durability: 'full' });
  const value = { kind: 'overage' as const, status: 'rejected', window: 'five_hour', resetsAtMs: 1792773600000 };
  try {
    for (const language of ['en', 'tr'] as const) {
      const session = {}, notes: string[] = [], claim = { scopeId: 's', turnId: `paid-${language}`, principalKey: 'fixture', requestDigest: 'a'.repeat(64), claimedAtMs: 1 };
      await expect(notifyNativePaidUsage(value, language, session, 'terminal', 's', () => { throw new Error('delivery-failed'); })).rejects.toThrow('delivery-failed');
      const result = await runDurableAgentTurn({ claim, messages: [], tools: [], signal: new AbortController().signal, emit: () => undefined }, store, {
        async invokeRound() {
          const notify = () => notifyNativePaidUsage(value, language, session, 'terminal', 's', async text => { await Promise.resolve(); notes.push(text); });
          await Promise.all([notify(), notify()]); await notify();
          return { status: 'responded', content: 'finished', reasoning: '', toolCalls: [], finish: 'stop', usage: null };
        }, hostNote: () => notes.join(' '), authorize: async () => 'allow', describe: () => null,
        execute: async () => { throw new Error('no tools'); }, now: () => 2,
      });
      expect(notes).toHaveLength(1);
      expect(result.note).toContain(language === 'en' ? 'Paid extra usage of your provider account is in use' : 'Sağlayıcı hesabınızın ücretli ek kullanımı devrede');
      expect(result.note).toContain(language === 'en' ? 'deckent cannot see the amount' : 'deckent tutarı göremez');
      expect(result.note).toContain("deckent config set models.headless.paidExtraUsage '\"stop-at-limit\"'");
      expect(result.note).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|\{\w+\}/u);
      expect(await store.claim(claim)).toMatchObject({ status: 'finished', outcome: { note: result.note } });
      await expect(notifyNativePaidUsage({ ...value, window: 'x\n' }, language, {}, 'terminal', 's', () => { throw new Error('unsafe'); })).rejects.toThrow();
    }
  } finally { store.close(); }
});

it('retries paid notices dropped by the real channel and refuses cancelled late delivery', async () => {
  // Real channel + Node pipe socket; only the provider stream is synthetic. No CLI or login runs.
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const socket = child.stdin as Socket;
  const entry = nativeCliAgent(FAMILY)!, session = {}, scopeId = 's';
  const tools = toolSessionSchema.parse({ schemaVersion: 1, turnId: 'paid-delivery', generation: 1, tools: [], approvalTtlMs: 120000 });
  const port: ToolSessionPort = { session: tools, propose: async () => { throw new Error('no tool expected'); },
    cancel: async () => { throw new Error('unused'); }, revoke: async () => { throw new Error('unused'); } };
  const event = JSON.stringify(rateLimitLine('rejected', { overageStatus: 'allowed' }));
  let sinks = 0;
  const start = (channel: ReturnType<typeof createServerTurnChannel>) => {
    const driver = createClaudeAgentDriver({ entry, port, model: PINNED, cliVersion: '2.1.322', runDir: '/run/dir', outputMaxBytes: 8192,
      quotaPolicy: nativeQuotaPolicy(), onPaidUsage: (limit, signal) => notifyNativePaidUsage(limit, 'en', session, 'terminal', scopeId, async text => {
        sinks++; channel.emit({ kind: 'text', text });
        if (!await channel.drained()) throw new Error('notice-not-delivered');
      }, signal) });
    expect(driver.line(JSON.stringify(initLine({ model: PINNED, claude_code_version: '2.1.322', cwd: '/run/dir', tools: [],
      mcp_servers: [{ name: entry.bridge.serverName, status: 'connected' }] })))).toBeUndefined();
    return driver;
  };
  try {
    for (const mode of ['error', 'aborted', 'finished', 'overflow', 'late-cancel', 'late-timeout'] as const) {
      const channel = createServerTurnChannel(socket, mode, 8192, mode === 'overflow' ? 1 : 32768);
      const driver = start(channel), before = sinks, controller = new AbortController();
      if (mode === 'aborted') socket.emit('error', new Error('disconnected'));
      if (mode === 'finished') channel.finish();
      if (mode.startsWith('late-')) socket.cork();
      const pending = driver.line(event, controller.signal);
      // Let the actual sink enqueue the event, before the channel's scheduled write.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      if (mode === 'error') socket.emit('error', new Error('disconnected'));
      if (mode.startsWith('late-')) {
        await new Promise<void>(resolve => setImmediate(resolve));
        controller.abort(new Error(mode));
      }
      expect(await pending).toBe('stop');
      socket.uncork(); await new Promise<void>(resolve => setImmediate(resolve));
      expect(sinks).toBe(before + 1); expect(driver.paidExtraUsage()).toBeNull();
      expect(driver.line(JSON.stringify(assistantLine('must not be accepted')))).toBe('stop');
      expect(driver.finish({ reason: 'cancelled', exitCode: null, stdoutTruncated: false, stderrTruncated: false }))
        .toMatchObject({ kind: 'refused', limit: { kind: 'quota' } });
      channel.finish();
    }
    const channel = createServerTurnChannel(socket, 'retry', 8192, 32768), before = sinks;
    const driver = start(channel);
    expect(await driver.line(event)).toBeUndefined(); expect(sinks).toBe(before + 1);
    expect(driver.paidExtraUsage()).toMatchObject({ kind: 'overage' });
    expect(await start(channel).line(event)).toBeUndefined(); expect(sinks).toBe(before + 1);
    channel.finish();
  } finally { socket.uncork(); child.kill('SIGKILL'); await closed; }
});
