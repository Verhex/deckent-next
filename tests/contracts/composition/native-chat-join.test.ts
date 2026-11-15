import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';
import { createClaudeAgentDriver, toolSessionSchema, type ToolSessionPort } from '#capabilities/index.js';
import { createServerTurnChannel } from '#adapters/core/local-runtime-socket/index.js';
import { nativeQuotaPolicy } from '#adapters/core/native-connection/index.js';
import { FAMILY, PINNED, rateLimitLine } from '../../fixtures/native-headless/stream.js';
import { notifyNativeBuiltinPlugins, notifyNativePaidUsage } from '#composition/core/model-invocation/index.js';
import type { ModelInvocationResult } from '#engine/core/model-invocation/index.js';
import { writeFakeCli, uiLine, initLine, assistantLine, resultLine } from '../../fixtures/native-headless/stream.js';
import { createServer, request, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { brainProviderFixture } from '../support/brain-provider.js';
import { createTerminalRuntimeClient, terminalRuntimePeer } from '../support/terminal-runtime-client.js';
import { NATIVE_CLI_HEADLESS_ADAPTER_ID, firstRunPolicyTemplate, modelInvocationProfileSchema, type AgentTurnStreamEvent, type AgentToolCall } from '#domain/index.js';
import { createRuntimeChatTurnHost, runPeerConfiguredChatTurn, cancelPeerConfiguredChatTurn, type NativeChatRuntime } from '#composition/core/agent-turn/index.js';
import { describeTerminalChat, inspectNativeChat } from '#composition/core/terminal-chat/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { nativeAgentFlagSetDigest } from '#adapters/core/native-cli-headless/index.js';
import { bindCapacityResource, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { headlessCapacityBinding } from '#adapters/core/sqlite-model-invocation/index.js';
import { readLocalOsIdentity, localPrincipalChannel, LocalOsSessionAuthority } from '#adapters/core/local-principal/index.js';
import { FIRST_RUN_TOOL_NAMES, ModelInvocationControllers, modelInvocationProfileDigest } from '#engine/index.js';
import { clearConfigCache, redactForRecord, SystemTrustedClock } from '#platform/index.js';
import { openSqliteAgentTurnStore } from '#adapters/index.js';
import { runDurableAgentTurn } from '#engine/index.js';

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
async function fixture(askEdits = true) {
  const owner = readLocalOsIdentity();
  const f = await brainProviderFixture({ headless: { executable: process.execPath, configDir: '/fixture-login', stateDir: '/fixture-state',
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
  const state = { paidExtraUsage: null as null | { kind: string; status: string; window: string; resetsAtMs: number | null }, builtinPlugins: [] as string[], cliVersion: '2.1.322', servers: [] as Server[], calls: 0, closes: 0, revoked: false, result: '', token: '', prompt: '', channels: [] as (string | undefined)[] };
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
          const result = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: call.name, arguments: JSON.parse(call.argumentsJson), _meta: { 'claudecode/toolUseId': 'fake-use-1' } } });
          state.result = result.body;
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
  const run = (turnId = command.turnId) => runPeerConfiguredChatTurn(f.project, { ...command, turnId }, peer, f.options, { maxResultBytes: 65_536 }, host, channel);
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
