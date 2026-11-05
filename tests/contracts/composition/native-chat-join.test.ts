import { writeFakeCli, uiLine, initLine, assistantLine, resultLine } from '../../fixtures/native-headless/stream.js';
import { createServer, request, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { brainProviderFixture } from '../support/brain-provider.js';
import { createTerminalRuntimeClient, terminalRuntimePeer } from '../support/terminal-runtime-client.js';
import { firstRunPolicyTemplate, modelInvocationProfileSchema, type AgentTurnStreamEvent, type AgentToolCall } from '#domain/index.js';
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
  const state = { servers: [] as Server[], calls: 0, closes: 0, revoked: false, result: '', token: '', channels: [] as (string | undefined)[] };
  const pin = Object.freeze({ scopeId: 's', fixture: true });
  const resolveModelUse = vi.fn<NativeChatRuntime['resolveModelUse']>(async (_profile, actor, check) => {
    expect(actor.issuer).toBe(ai.issuer);
    if (state.revoked) throw new Error('PROJECT_ATTACHMENT_DENIED');
    if (check.action === 'pin') return pin;
    expect(check.pin).toBe(pin);
  });
  const call: AgentToolCall = { id: 'unused', name: 'write_file', argumentsJson: JSON.stringify({ path: 'result.txt', content: 'approved business result\n' }) };
  const runtime: NativeChatRuntime = { readiness, limits: { idleMs: 30_000, maxConnections: 4, replayMaxEntries: 8, replayMaxBytes: 16 * entry.bridge.frameMaxBytes }, resolveModelUse,
    driver: async ({ session }) => ({ port: session, admit: async () => undefined,
      native: (bridge, secrets) => ({ billingAxis: 'subscription', prepare: async () => ({}),
        async send(_prepared, signal) {
          state.calls++; state.token = bridge.turnToken;
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
          return { schemaVersion: 1, native: { object: 'chat.completion', model: 'vendor/model', choices: [{ index: 0, message: { role: 'assistant', content: 'finished' }, finish_reason: 'stop' }] }, usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
        } }),
      refusal: () => null,
      close: async () => { state.closes++; for (const server of state.servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } } }) };
  const host = createRuntimeChatTurnHost({ ownerId: 'k11-test-service', controllers: new ModelInvocationControllers(2) }, new AbortController().signal,
    undefined, undefined, () => [], undefined, runtime);
  const events: AgentTurnStreamEvent[] = [];
  let offer!: (event: Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>) => void;
  const offered = new Promise<Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>>(resolve => { offer = resolve; });
  const channel = { signal: new AbortController().signal, room: () => 1_000_000, drained: async () => undefined,
    emit(event: AgentTurnStreamEvent) { events.push(event); if (event.kind === 'approval.requested') offer(event); } };
  const command = { schemaVersion: 1, scopeId: 's', turnId: 'k11-turn', messages: [{ role: 'user', content: 'write the business result' }] };
  const run = () => runPeerConfiguredChatTurn(f.project, command, peer, f.options, { maxResultBytes: 65_536 }, host, channel);
  const decide = (event: Awaited<typeof offered>, decision: 'allow' | 'deny') => configuredApproval(f.project, 'decide', { schemaVersion: 1, scopeId: 's', commandId: 'decide-k11', approvalId: event.approvalId,
    expectedRevision: event.revision, decision, reason: 'synthetic person decision', channel: 'local-terminal-card', decisionCapability: event.decisionCapability }, f.options, peer, undefined, {}, host.decisions, host.answers);
  return { f, profile, runtime, execution, state, host, peer, events, run, offered, decide };
}

it('shows tools only for a matching capability, and does not spawn on inspection', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture();
  expect((await describeTerminalChat(h.f.project, h.f.options)).tools).toBe('none');
  expect((await describeTerminalChat(h.f.project, h.f.options, h.runtime)).tools).toBe('available');
  h.execution.profileDigest = '0'.repeat(64);
  expect(await inspectNativeChat(h.profile, h.runtime)).toMatchObject({ state: 'unavailable', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' });
  expect(h.state.calls).toBe(0); expect(h.runtime.resolveModelUse).not.toHaveBeenCalled();
});

it('keeps an AI requester, witnessed person decider, real write, durable replay and token redaction', async () => {
  if (await unsupportedPeer()) return;
  const h = await fixture(), running = h.run(), event = await Promise.race([h.offered, running.then(result => { throw new Error(JSON.stringify({ result, events: h.events, calls: h.state.calls })); })]);
  expect(await readFile(join(h.f.project, 'result.txt'), 'utf8').catch(() => null)).toBeNull();
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
