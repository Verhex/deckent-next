import { withRecordedToolError, errorCallArgs } from '../../fixtures/native-headless/recorded-error.js';
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseModelBindingDefinition, modelInvocationProfileSchema, readHeadlessRejection, type AgentTurnEvent, type ModelInvocationDelta, type ModelInvocationDeltaSink } from '#domain/index.js';
import { createNativeAgentDriver, preflightNativeAgent, readNativeAgentObservation, headlessFlagSetDigest } from '#adapters/core/native-cli-headless/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { createNativeToolBridge } from '#adapters/core/native-tool-bridge/index.js';
import { openSqliteAgentTurnStore } from '#adapters/core/sqlite-agent-turn/index.js';
import { nativeEgressLimits, nativeQuotaPolicy } from '#adapters/core/native-connection/index.js';
import { inspectSubscriptionReadiness } from '#composition/core/subscription-readiness/index.js';
import { inspectNativeChat } from '#composition/core/terminal-chat/index.js';
import { createClaudeAgentDriver, nativeQuotaText, nativeAgentReasonText, type SameTurnPlanningPort, type SameTurnToolSessionPort, type ToolSessionPort } from '#capabilities/index.js';
import { snapshotKnownSecrets, clockText, t } from '#platform/index.js';
import { runDurableAgentTurn, type AgentTurnPorts } from '#engine/core/agent-turn/index.js';
import { renderAssistantStream, startAssistantStream, type AssistantUnit } from '#surfaces/core/terminal/index.js';
import { streamTerminalAgentTurn } from '#surfaces/core/terminal-turn/index.js';
import { connection, cleanupConnections, testIsolation } from '../../fixtures/native-headless/connection.js';
import { nativeAgentRealmAvailable, writeFakeAgentCli, type FakeAgentScenario } from '../../fixtures/native-headless/agent.js';
import { assistantLine, initLine, PINNED, resultLine } from '../../fixtures/native-headless/stream.js';
import registry from '../../../assets/native-coding/commands.json' with { type: 'json' };

const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); await cleanupConnections(); });
const families = [registry.adapters.claude.capabilities.eventStream, registry.adapters.codex.headless.protocolFamily];
async function fixture(family: string, scenario: FakeAgentScenario = {}) {
  const c = await connection(), bin = join(c.root, 'agent-bin'); await mkdir(bin);
  const executable = await writeFakeAgentCli(bin, family, scenario), entry = nativeCliAgent(family)!;
  const connectedPath = join(bin, 'connected-cli'); await symlink(executable, connectedPath);
  const profile = modelInvocationProfileSchema.parse({ ...c.profile, protocol: { family, version: 'v1' },
    adapter: { ...c.profile.adapter, definition: { ...c.profile.adapter.definition, executable: connectedPath } } });
  const session = { schemaVersion: 1 as const, turnId: 'agent-fixture', generation: 1, approvalTtlMs: 120_000,
    tools: [{ name: 'read_file', version: 1, toolClass: 'read' as const, description: 'Read a scoped file', inputSchema: { type: 'object' as const, properties: {} } }] };
  const closure = { turnId: session.turnId, generation: 1, pendingCallIds: [], termination: 'confirmed' as const, effects: 'unknown' as const };
  const propose = vi.fn<ToolSessionPort['propose']>(async call => ({ schemaVersion: 1, turnId: session.turnId, generation: 1,
    deckentCallId: call.id, outcome: { status: 'ok', text: 'scoped read result' + (scenario.loginCanary ?? '') } }));
  const port: ToolSessionPort = { session, propose, cancel: async () => ({ ...closure, kind: 'cancelled' }), revoke: async () => ({ ...closure, kind: 'revoked' }) };
  const start = async (paidExtraUsage: 'continue' | 'stop-at-limit' = 'continue', onPaidUsage: (() => Promise<void>) | null = async () => undefined, host: SameTurnToolSessionPort = port, user = 'Read the scoped fixture.') => {
    const sealed = await preflightNativeAgent(profile, Date.now, testIsolation);
    const driver = createNativeAgentDriver({ profile, execution: sealed.execution, session: host, now: Date.now, isolation: testIsolation, paidExtraUsage, ...(onPaidUsage ? { onPaidUsage } : {}) });
    close.push(() => driver.close());
    const configured = snapshotKnownSecrets(scenario.loginCanary ? [{ name: 'FIXTURE_LOGIN', value: scenario.loginCanary }] : []);
    const bridge = await createNativeToolBridge({ port: driver.port, bridge: entry.bridge, knownSecrets: configured,
      correlationKind: entry.agent.transport.kind === 'claude-mcp' ? 'claude-tool-use' : 'codex-mcp',
      limits: { idleMs: nativeEgressLimits().idleMs, maxConnections: entry.bridge.maxConnections!, replayMaxEntries: entry.bridge.replayMaxEntries!, replayMaxBytes: entry.bridge.replayMaxBytes! } });
    close.push(() => bridge.close());
    const native = driver.native(bridge, { configured,
      turn: snapshotKnownSecrets([{ name: bridge.tokenEnvName, value: bridge.turnToken }]) });
    const model = 'vendor-model-pinned';
    const binding = parseModelBindingDefinition({ encodingVersion: 1, provider: { id: profile.reference.providerId, version: 1 }, model: { id: profile.reference.modelId,
      version: 1, nativeId: model, protocols: [{ family, version: 'v1', capabilities: [] }] } });
    await driver.admit();
    const prepared = await native.prepare(profile, binding, { model, messages: [{ role: 'system', content: 'Use governed tools.' }, { role: 'user', content: user }], stream: false });
    const deltas: ModelInvocationDelta[] = [];
    return { ...sealed, driver, bridge, native, prepared, deltas, run: (signal?: AbortSignal, onDelta?: ModelInvocationDeltaSink) => native.send(prepared, signal, delta => {
      deltas.push(delta); onDelta?.(delta);
    }) };
  };
  return { c, profile, entry, start, propose, port };
}

/** Owner 2026-11-05: a refused turn writes no negative observation, so the next turn is not paused. */
async function notPaused(profile: Parameters<typeof readNativeAgentObservation>[0]) {
  const observed = await readNativeAgentObservation(profile);
  expect(observed?.toolSurface).not.toBe(false); expect(observed?.plugins).not.toBe(false);
}
it('keeps no-model preflight observations incomplete, never upgrades text seals, and invalidates executable metadata changes', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const f = await fixture(families[0]!);
  expect(await readNativeAgentObservation(f.profile)).toBeNull();
  const before = headlessFlagSetDigest(f.entry), sealed = await preflightNativeAgent(f.profile, Date.now, testIsolation);
  const observed = await readNativeAgentObservation(f.profile);
  expect(observed).toMatchObject({ cli: true, login: true, environment: true, execution: sealed.execution });
  expect(observed?.toolSurface).toBeNull(); expect(observed?.plugins).toBeNull();
  expect(sealed.execution.flagSetDigest).not.toBe(before); expect(headlessFlagSetDigest(f.entry)).toBe(before);
  const state = await inspectSubscriptionReadiness({ surface: 'chat', scopeId: f.profile.scopeId, reference: f.profile.reference,
    profileDigest: sealed.execution.profileDigest, flagSetDigest: sealed.execution.flagSetDigest }, { read: async () => observed });
  expect(state.state).toBe('unknown');
  expect(f.propose).not.toHaveBeenCalled();
  expect(await readNativeAgentObservation(f.profile, () => Date.now() + f.entry.agent.observationMaxAgeMs! + 1)).toBeNull();
  await writeFile(String(f.profile.adapter.definition['executable']), '\n', { flag: 'a' });
  expect(await readNativeAgentObservation(f.profile)).toBeNull();
});

it('runs both real isolated CLI drivers through R with exact correlation, readonly MCP config and no token/login canary in deltas or receipts', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  for (const family of families) {
    const f = await fixture(family!, { calls: [{ name: 'read_file', arguments: { path: 'scoped.txt' } }], preamble: 'Before the tool.\n', echoToken: true, loginCanary: 'FIXTURE-LOGIN-CANARY-4cf027' });
    const h = await f.start(), result = await h.run();
    expect(result).toMatchObject({ schemaVersion: 1, native: { choices: [{ message: { content: expect.stringContaining('agent completed') }, finish_reason: 'stop' }] } });
    const content = (result as { native: { choices: { message: { content: string } }[] } }).native.choices[0]!.message.content;
    expect(content).toBe(h.deltas.map(delta => delta.text).join('')); expect(content).toMatch(/^Before the tool\.\n/u);
    expect(h.deltas.every(delta => delta.kind === 'text')).toBe(true);
    expect(content.match(/Before the tool\./gu)).toHaveLength(1);
    expect(f.propose).toHaveBeenCalledOnce();
    expect(f.propose.mock.calls[0]![1]).toMatchObject({ kind: f.entry.agent.transport.kind === 'claude-mcp' ? 'claude-tool-use' : 'codex-mcp' });
    const projected = JSON.stringify({ result, deltas: h.deltas });
    expect(projected).not.toContain(h.bridge.turnToken); expect(projected).not.toContain('FIXTURE-LOGIN-CANARY-4cf027');
    expect(await readNativeAgentObservation(f.profile)).toMatchObject({ toolSurface: true, plugins: true, bridge: true, execution: h.execution });
    expect(await inspectNativeChat(f.profile, { readiness: { read: async () => readNativeAgentObservation(f.profile) } })).toMatchObject({ state: 'ready' });
    const records = (await readdir(join(f.c.root, 'state'))).filter(name => name.startsWith('agent-'));
    expect(records).toHaveLength(1);
    const path = join(f.c.root, 'state', records[0]!);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).not.toContain(h.bridge.turnToken);
    expect(await readdir(join(f.c.root, 'state', 'run'))).toEqual([]);
  }
});

const claudeProse = (id: string, ...chunks: string[]) => ({
  ...assistantLine(''), message: { id, type: 'message', role: 'assistant', model: PINNED, content: chunks.map(text => ({ type: 'text', text })) },
});

it('preserves Claude text block and record chunks within one message ID across a tool exchange', async () => {
  const { entry, port } = await fixture(families[0]!);
  const deltas: string[] = [];
  const driver = createClaudeAgentDriver({ entry, port, model: PINNED, cliVersion: '9.1.0', runDir: '/run/dir',
    outputMaxBytes: 8192, quotaPolicy: nativeQuotaPolicy(), onDelta: delta => deltas.push(delta.text) });
  const feed = (event: unknown) => expect(driver.line(JSON.stringify(event))).toBeUndefined();
  const name = entry.bridge.toolPrefix + 'read_file', input = { path: 'scoped.txt' }, id = 'read-1';
  feed(initLine({ tools: [name], mcp_servers: [{ name: entry.bridge.serverName, status: 'connected' }] }));
  feed(claudeProse('preamble', 'I will che'));
  feed(claudeProse('preamble', '', 'ck the ', 'file.'));
  const tool = claudeProse('preamble');
  feed({ ...tool, message: { ...tool.message, content: [{ type: 'tool_use', id, name, input }] } });
  await driver.propose({ id, name: 'read_file', argumentsJson: JSON.stringify(input) },
    { kind: 'claude-tool-use', toolUseId: id, deckentCallId: id }, new AbortController().signal);
  feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
  feed(claudeProse('answer', '', 'The file is ', 'readable.'));
  feed(claudeProse('follow-up', ' Already spaced.'));
  feed(claudeProse('no-tool', 'Still contiguous.'));
  feed(resultLine('The file is readable. Already spaced.'));
  expect(driver.finish({ reason: 'exit', exitCode: 0, stdoutTruncated: false, stderrTruncated: false })).toMatchObject({ kind: 'completed' });
  expect(deltas).toEqual(['I will che', 'ck the ', 'file.', '\n\nThe file is ', 'readable.', ' Already spaced.', 'Still contiguous.']);
});

it.each(['tool first', 'text first', 'same message', 'existing whitespace', 'unsettled tool'] as const)(
  'uses only an intervening verified Claude tool for a paragraph boundary (%s)', async order => {
    const { entry, port } = await fixture(families[0]!);
    const deltas: string[] = [];
    const driver = createClaudeAgentDriver({ entry, port, model: PINNED, cliVersion: '9.1.0', runDir: '/run/dir',
      outputMaxBytes: 8192, quotaPolicy: nativeQuotaPolicy(), onDelta: delta => deltas.push(delta.text) });
    const feed = (event: unknown) => expect(driver.line(JSON.stringify(event))).toBeUndefined();
    const name = entry.bridge.toolPrefix + 'read_file', input = { path: 'scoped.txt' }, id = 'read-1';
    const settle = () => driver.propose({ id, name: 'read_file', argumentsJson: JSON.stringify(input) },
      { kind: 'claude-tool-use', toolUseId: id, deckentCallId: id }, new AbortController().signal);
    feed(initLine({ tools: [name], mcp_servers: [{ name: entry.bridge.serverName, status: 'connected' }] }));
    feed(claudeProse('first', 'Before.'));
    if (order !== 'unsettled tool') await settle();
    const prose = order === 'existing whitespace' ? ' After.' : 'After.';
    const line = claudeProse(order === 'same message' ? 'first' : 'second', prose), tool = { type: 'tool_use', id, name, input };
    const blocks = line.message.content;
    feed({ ...line, message: { ...line.message, content: order === 'text first' ? [...blocks, tool] : [tool, ...blocks] } });
    if (order === 'unsettled tool') await settle();
    feed(claudeProse('third', 'Next.'));
    expect(deltas).toEqual(['Before.', order === 'tool first' ? '\n\n' + prose : prose,
      order === 'text first' || order === 'unsettled tool' ? '\n\nNext.' : 'Next.']);
  });

it.each(['Claude', 'Codex'] as const)('separates %s prose around a settled tool in streamed and retained text', async provider => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const canary = 'FIXTURE-LOGIN-CANARY-4cf027', masked = '‹secret:FIXTURE_LOGIN›';
  const before = 'I will check the file.', after = 'The file is readable.';
  const events = [claudeProse('preamble', 'I will che'), claudeProse('preamble', `ck the ${canary.slice(0, 12)}`, `${canary.slice(12)} file.`)];
  const f = await fixture(families[provider === 'Claude' ? 0 : 1]!, {
    calls: [{ name: 'read_file', arguments: { path: 'scoped.txt' } }],
    ...(provider === 'Claude' ? { events } : { preamble: before }),
    answer: after, loginCanary: canary,
  });
  const h = await f.start(), result = await h.run();
  const expectedBefore = provider === 'Claude' ? `I will check the ${masked} file.` : before;
  const expected = `${expectedBefore}\n\n${after} ${masked}`;
  expect(f.propose).toHaveBeenCalledOnce();
  expect(h.deltas.map(delta => delta.text).join('')).toBe(expected);
  expect(result).toMatchObject({ native: { choices: [{ message: { content: expected } }] } });
});

it.each(['ordinary prose', 'split registered secret'] as const)('renders real native deltas around a declined call and replays the recorded answer (%s)', async variant => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const split = variant === 'split registered secret', prefix = 'fragment.', suffix = 'continuation-572394abc';
  const before = 'I will check the file.', after = 'The file was skipped.';
  const f = await fixture(families[0]!, { calls: [{ name: 'read_file', arguments: { path: 'scoped.txt' } }],
    events: [claudeProse('preamble', split ? `I saw ${prefix}` : before)], answer: split ? suffix : after,
    ...(split ? { loginCanary: prefix + suffix } : {}) });
  const expected = split ? 'I saw ‹secret:FIXTURE_LOGIN› ‹secret:FIXTURE_LOGIN›' : `${before}\n\n${after}`;
  const store = await openSqliteAgentTurnStore(join(f.c.root, 't5.sqlite'), { journalMode: 'wal', durability: 'full', busyTimeoutMs: 2_000 });
  close.push(async () => store.close());
  const tool = f.port.session.tools[0]!;
  const tools = [{ ...tool, inputSchema: { ...tool.inputSchema, properties: { path: { type: 'string' as const } } } }];
  const nativeSession = { ...f.port.session, tools }, messages = [{ role: 'user' as const, content: 'Read the scoped fixture.' }];
  const claim = { scopeId: 'scope', turnId: nativeSession.turnId, principalKey: 'fixture', requestDigest: 'a'.repeat(64), claimedAtMs: 1_000 };
  const input = { claim, messages, tools, nativeSession, signal: new AbortController().signal };
  const live: AgentTurnEvent[] = [], execute = vi.fn<AgentTurnPorts['execute']>();
  const invokeAgent = vi.fn<NonNullable<AgentTurnPorts['invokeAgent']>>(async ({ session }, onDelta, signal) => {
    const h = await f.start('continue', null, session);
    const response = await h.run(signal, onDelta);
    if (!('native' in response)) throw new Error('Expected native completion');
    const content = (response.native as { choices: { message: { content: string } }[] }).choices[0]!.message.content;
    return { status: 'responded', content, reasoning: '', toolCalls: [], finish: 'stop', usage: null };
  });
  const ports: AgentTurnPorts = { invokeAgent, execute, now: () => 1_000, describe: () => 'scoped.txt',
    invokeRound: async () => { throw new Error('unexpected pull round'); }, authorize: async () => 'require-approval',
    async requestApproval({ call }) {
      live.push({ kind: 'approval.requested', callId: call.id, approvalId: 'a', revision: 0, summary: 'Read the file', preview: 'scoped.txt', expiresAt: 2_000 });
      live.push({ kind: 'approval.settled', callId: call.id, approvalId: 'a', outcome: 'deny' });
      return 'deny';
    },
  };
  const result = await runDurableAgentTurn({ ...input, emit: event => live.push(event) }, store, ports);
  expect(result).toMatchObject({ finish: 'stop', answer: expected, toolCalls: 0, recorded: true, replayed: false });
  expect(live.filter(event => event.kind === 'text').map(event => event.text).join('')).toBe(expected);
  const units: AssistantUnit[] = [];
  let state = startAssistantStream(1_000);
  for await (const delta of streamTerminalAgentTurn({ projectRoot: f.c.root, scopeId: claim.scopeId, messages, options: {} }, {
    async chatTurn(_root, { turnId }, onEvent) {
      for (const event of live) if (event.kind !== 'done') onEvent(event);
      return { ...result, turnId, notices: [] };
    }, cancelChatTurn: async () => undefined, toolClass: () => 'read',
  })) {
    const step = renderAssistantStream(state, delta, 1_000);
    state = step.state; units.push(...step.staticUnits);
    if (split) for (const fragment of [prefix, suffix]) {
      expect(JSON.stringify({ units, tail: step.liveTail, delta })).not.toContain(fragment);
    }
  }
  expect(units).toMatchObject(split ? [
    { kind: 'text', markdown: 'I saw ', lead: true },
    { kind: 'tool', name: 'read_file', status: 'denied', declined: true },
    { kind: 'text', markdown: '‹secret:FIXTURE_LOGIN› ‹secret:FIXTURE_LOGIN›', lead: false },
  ] : [
    { kind: 'text', markdown: before, lead: true },
    { kind: 'tool', name: 'read_file', target: 'scoped.txt', status: 'denied', declined: true },
    { kind: 'text', markdown: after, lead: false },
  ]);
  const replay: AgentTurnEvent[] = [];
  await expect(runDurableAgentTurn({ ...input, emit: event => replay.push(event) }, store, ports))
    .resolves.toMatchObject({ answer: expected, recorded: true, replayed: true, appendedCount: 0 });
  expect(replay).toEqual([{ kind: 'text', text: expected }, { kind: 'done', finish: 'stop', note: null }]);
  expect(invokeAgent).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
});

it('WER-A chat continues after synthetic nonzero and sealed NO, and stops session and uncertain records', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  for (const variant of ['nonzero', 'person-no', 'session', 'uncertain'] as const) {
    const f = await fixture(families[1]!, { failedTool: true, calls: [{ name: 'run_shell', arguments: errorCallArgs }] });
    await withRecordedToolError(f.c.root, variant, async port => {
      const h = await f.start('continue', null, port), response = await h.run();
      expect(response, variant).toMatchObject(variant === 'nonzero' || variant === 'person-no' ?
        { native: { choices: [{ message: { content: 'agent completed' } }] } } : { kind: 'rejected' });
    });
  }
});
it('stops unexpected Claude plugins and Codex native items before accepting tools; the refusal stops only that turn', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  for (const family of families) {
    const f = await fixture(family!, { pluginMismatch: true, nativeItem: true, calls: [{ name: 'read_file', arguments: { path: 'scoped.txt' } }] });
    const h = await f.start();
    expect(await h.run()).toMatchObject({ kind: 'rejected' });
    expect(f.propose).not.toHaveBeenCalled();
    expect(h.driver.refusal()).toBe(f.entry.agent.transport.kind === 'claude-mcp' ? 'NATIVE_AGENT_PLUGIN_UNEXPECTED' : 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
    await notPaused(f.profile);
  }
});

it('R5b: retains which Claude stream check refused and identifier-only facts, never the call arguments', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const f = await fixture(registry.adapters.claude.capabilities.eventStream!, { calls: [{ name: 'list_dir', arguments: { path: '/secret-argument-canary' } }] });
  const h = await f.start(), result = await h.run();
  expect(result).toMatchObject({ kind: 'rejected' });
  const body = result.kind === 'rejected' ? readHeadlessRejection(result.evidence) : null;
  expect(body).toMatchObject({ refusal: 'guard', field: 'agent-surface:tool-use', subtype: "name=? prefix=1 offered=0" });
  expect(JSON.stringify(body)).not.toContain('secret-argument-canary');
  expect(f.propose).not.toHaveBeenCalled();
  await notPaused(f.profile);
});
it('R6b/R5b: Claude keepalive and thinking-token notices keep the turn; a keepalive naming an unknown call still stops it', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const calls = [{ name: 'read_file', arguments: { path: 'scoped.txt' } }], family = registry.adapters.claude.capabilities.eventStream!;
  const ok = await (await fixture(family, { heartbeat: 'known', thinkingTokens: true, calls })).start();
  expect(await ok.run()).toMatchObject({ native: { choices: [{ message: { content: 'agent completed' } }] } });
  const foreign = await fixture(family, { heartbeat: 'foreign', calls }), h = await foreign.start(), result = await h.run();
  expect(result.kind === 'rejected' ? readHeadlessRejection(result.evidence) : null).toMatchObject({ field: 'agent-surface:subagent' });
});
it('owner 2026-11-05: an unrecognised Claude event is a turn note; a registry stop event stops only that turn', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const calls = [{ name: 'read_file', arguments: { path: 'scoped.txt' } }], family = registry.adapters.claude.capabilities.eventStream!;
  const noted = await (await fixture(family, { events: [{ type: 'system', subtype: 'future_notice', text: 'never echoed' }], calls })).start();
  expect(await noted.run()).toMatchObject({ native: { choices: [{ message: { content: 'agent completed' } }] } });
  expect(noted.driver.notices()).toEqual(['system/future_notice']);
  const names = ['cc-plugin-sec-default', 'cc-plugin-agents-md', 'cc-plugin-telemetry', 'cc-plugin-privacy', 'cc-plugin-plugin-authoring', 'cc-plugin-unseen'];
  const plugins = names.map(name => ({ name, path: 'builtin', source: `${name}@builtin` }));
  const builtin = await (await fixture(family, { init: { plugins }, calls })).start();
  expect(await builtin.run()).toMatchObject({ native: { headless: { builtinPlugins: expect.arrayContaining(['cc-plugin-unseen']) } } });
  for (const init of [{ plugin_errors: [{ plugin: 'cc-plugin-unseen', type: 'failed' }] }, { skills: ['extra'] }, { slash_commands: ['extra'] }]) {
    const bad = await fixture(family, { init: { plugins, ...init }, calls }), blocked = await bad.start();
    expect(await blocked.run()).toMatchObject({ kind: 'rejected' });
    expect(bad.propose).not.toHaveBeenCalled();
  }

  const f = await fixture(family, { events: [{ type: 'system', subtype: 'permission_denied' }], calls }), h = await f.start(), result = await h.run();
  expect(result.kind === 'rejected' ? readHeadlessRejection(result.evidence) : null).toMatchObject({ field: 'agent-surface:event', subtype: 'system/permission_denied' });
  await notPaused(f.profile);
  for (const event of [{ type: 'system', subtype: 'Permission_Denied' }, { type: 'system', subtype: 'odd name' }]) {
    const g = await fixture(family, { events: [event], calls }), r = await (await g.start()).run();
    expect(r.kind === 'rejected' ? readHeadlessRejection(r.evidence) : null).toMatchObject({ field: 'agent-surface:event' });
  }
});
it('keeps cancelled calls unknown, closes the process and removes token-bearing files for both CLI families', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  for (const family of families) {
    const f = await fixture(family!, { hang: true }), h = await f.start();
    await expect(h.run(AbortSignal.timeout(750))).rejects.toThrow('HEADLESS_OUTCOME_UNKNOWN');
    expect(await readdir(join(f.c.root, 'state', 'run'))).toEqual([]);
    expect(await readNativeAgentObservation(f.profile)).not.toMatchObject({ toolSurface: true });
    expect(f.propose).not.toHaveBeenCalled();
  }
});

it('records Claude subscription limits in the existing strict refusal and renders the same EN/TR family as plain chat', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  for (const info of [
    { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1792773600 },
    { status: 'rejected', rateLimitType: 'seven_day_opus', overageStatus: 'rejected' },
    { status: 'rejected', rateLimitType: 'odd\n\u001b' + 'x'.repeat(200) },
    { status: 'future-status', rateLimitType: 'seven_day' }, {},
    { status: 'rejected', errorCode: 'credits_required' },
  ]) {
    const f = await fixture(families[0]!, { events: [{ type: 'rate_limit_event', rate_limit_info: info }] });
    const h = await f.start(), result = await h.run();
    expect(result.kind).toBe('rejected');
    const body = result.kind === 'rejected' ? readHeadlessRejection(result.evidence) : null;
    expect(body).not.toBeNull(); expect(body!.schemaVersion).toBe(1);
    expect(body).toMatchObject({ resetsAtMs: 'resetsAt' in info ? 1792773600000 : null });
    expect(f.propose).not.toHaveBeenCalled();
    expect(h.driver.refusal()).toBeNull(); // A limit never becomes the misleading unexpected-tool notice.
    for (const language of ['en', 'tr'] as const) {
      const text = nativeQuotaText(body!, language)!;
      expect(text).not.toMatch(/\{\w+\}/u); expect(text).not.toContain('\n'); expect(text).not.toContain('\u001b');
      if ('errorCode' in info) { expect(text).toContain(language === 'en' ? 'extra credits' : 'ek kredi'); continue; }
      if (!('status' in info) || info.status === 'future-status') {
        expect(text).toContain(language === 'en' ? 'Unknown limit status' : 'Bilinmeyen limit durumu');
        expect(text).toContain('status' in info ? 'future-status' : '?'); continue;
      }
      expect(body).toMatchObject({ refusal: 'quota', subtype: 'rejected' });
      expect(text).toContain(language === 'en' ? 'stopped this turn instead of continuing on paid extra usage' : 'bu turu ücretli ek kullanımla sürdürmek yerine durdurdu');
      expect(text).toContain('deckent models login --connection claude-cli-subscription');
      expect(text).toContain('resetsAt' in info ? clockText(1792773600000) : language === 'en' ? 'unknown' : 'bilinmiyor');
      if (info.rateLimitType === 'five_hour') expect(text).toContain(language === 'en' ? 'five-hour window' : 'beş saatlik pencere');
      if (info.rateLimitType === 'seven_day_opus') expect(text).toContain(language === 'en' ? 'weekly window for Opus' : 'Opus için haftalık pencere');
      if (info.rateLimitType?.startsWith('odd')) { expect(body).toMatchObject({ field: 'odd__' + 'x'.repeat(19) }); expect(text).toContain('odd__' + 'x'.repeat(19)); }
    }
  }
});

it('D2 preserves a typed Codex usage limit and names a guard check without claiming an unexpected tool', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const quota = await (await fixture(families[1]!, { events: [{ type: 'turn.failed', error: { message: 'Rate limit reached' } }] })).start();
  const result = await quota.run();
  expect(result.kind).toBe('rejected');
  const guard = await (await fixture(families[1]!, { events: [{ type: 'turn.completed', usage: null }] })).start();
  expect(await guard.run()).toMatchObject({ kind: 'rejected' });
  expect(guard.driver.refusalCheck()).toBe('usage');
  const body = result.kind === 'rejected' ? readHeadlessRejection(result.evidence) : null;
  expect(body).toMatchObject({ refusal: 'quota' }); expect(quota.driver.refusal()).toBeNull();
  for (const locale of ['en', 'tr'] as const) {
    expect(nativeQuotaText(body!, locale)).toContain(locale === 'en' ? 'usage limit' : 'kullanım sınırı');
    const text = nativeAgentReasonText(guard.driver.refusal()!, locale, false, true, guard.driver.refusalCheck());
    expect(text).toContain(locale === 'en' ? 'safety check refused' : 'güvenlik denetimi');
    expect(text).not.toContain(locale === 'en' ? 'unexpected tool' : 'beklenmedik bir araç');
  }
});

it('keeps paid extra usage in open native evidence and stops it only on the configured choice', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  for (const info of [{ status: 'rejected', overageStatus: 'allowed', rateLimitType: 'five_hour', resetsAt: 1792773600 },
    { status: 'allowed', overageInUse: true }]) {
    const f = await fixture(families[0]!, { events: [{ type: 'rate_limit_event', rate_limit_info: info }] });
    const delivered = vi.fn(async () => { expect(continued.deltas).toEqual([]); });
    const continued = await f.start('continue', delivered);
    expect(await continued.run()).toMatchObject({ native: { headless: { paidExtraUsage: { kind: 'overage', status: info.status } } } });
    expect(delivered).toHaveBeenCalledTimes(1);
    const noNotice = await f.start('continue', null), refused = await noNotice.run();
    expect(refused.kind).toBe('rejected');
    if (refused.kind === 'rejected') expect(readHeadlessRejection(refused.evidence)).toMatchObject({ refusal: 'quota' });
    const throws = await f.start('continue', async () => { throw new Error('delivery'); });
    expect((await throws.run()).kind).toBe('rejected');
    const stopped = await f.start('stop-at-limit'), result = await stopped.run();
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(readHeadlessRejection(result.evidence)).toMatchObject({ refusal: 'quota', subtype: info.status });
  }
});

it('refuses a Codex collaboration item before a Deckent proposal even when the first surface has no seal', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const f = await fixture(families[1]!, { nativeItem: 'collab_tool_call', calls: [{ name: 'read_file', arguments: { path: 'scoped.txt' } }] });
  const h = await f.start();
  expect(await h.run()).toMatchObject({ kind: 'rejected' });
  expect(f.propose).not.toHaveBeenCalled();
  expect(h.driver.refusal()).toBe('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
  await notPaused(f.profile);
  expect(f.entry.agent.args).toContain('agents.enabled=false');
  expect(f.entry.agent.args).toContain('features.plugins=false');
});

it('refuses a Codex MCP proposal before its guarded item instead of delegating it', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const f = await fixture(families[1]!, { proposalBeforeItem: true, calls: [{ name: 'read_file', arguments: { path: 'scoped.txt' } }] });
  const h = await f.start();
  expect(await h.run()).toMatchObject({ kind: 'rejected' });
  expect(f.propose).not.toHaveBeenCalled();
  expect(h.driver.refusal()).toBe('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
  await notPaused(f.profile);
});

it('Card 168 stops the Codex chat turn with the reservation reason and accepts the next message on the same target', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const family = families[1]!, name = 'read_file', args = { path: 'scoped.txt' }, entry = nativeCliAgent(family)!;
  const f = await fixture(family, { calls: [{ name, arguments: args }], turns: [{ when: 'Read the scoped fixture.', hang: true,
    events: [{ type: 'item.started', item: { id: 'open-item', type: 'mcp_tool_call', server: entry.bridge.serverName,
      tool: name, arguments: args, status: 'in_progress', result: null, error: null } }] }] });
  const h = await f.start(), stop = new AbortController(), pending = h.run(stop.signal);
  const propose = (id: string) => h.driver.port.propose({ id, name, argumentsJson: JSON.stringify(args) },
    { kind: 'codex-mcp', callId: id, itemId: `wire-${id}`, deckentCallId: id }, stop.signal);
  try {
    await vi.waitFor(() => expect(h.deltas.map(delta => delta.text).join('')).toContain('K16-WAITING'));
    const first = await propose('first');
    await expect(propose('second')).rejects.toMatchObject({ code: 'HEADLESS_REQUEST_INVALID' });
    expect(first).toMatchObject({ deckentCallId: 'first', outcome: { status: 'ok', text: 'scoped read result' } });
    expect(f.propose).toHaveBeenCalledOnce();
    const result = await pending;
    expect(result.kind === 'rejected' && readHeadlessRejection(result.evidence)).toMatchObject({ refusal: 'guard', field: 'mcp-item-reservation' });
    expect(h.driver.refusalCheck()).toBe('mcp-item-reservation');
    await notPaused(f.profile);
  } finally { stop.abort(); await pending.catch(() => undefined); }
  const next = await f.start('continue', null, f.port, 'Read the fixture again.');
  expect(await next.run()).toMatchObject({ native: { choices: [{ message: { content: 'agent completed' } }] } });
  expect(f.propose).toHaveBeenCalledTimes(2);
});

it('Card 168 renders the reservation refusal in both languages during active Codex planning', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const family = families[1]!, name = 'propose_work', args = { request: 'Prepare work' }, entry = nativeCliAgent(family)!;
  const f = await fixture(family, { hang: true, events: [{ type: 'item.started', item: { id: 'open-item', type: 'mcp_tool_call',
    server: entry.bridge.serverName, tool: name, arguments: args, status: 'in_progress', result: null, error: null } }] });
  let active = false;
  const planning: SameTurnPlanningPort = {
    get active() { return active; }, pin: null, normalClosed: false, bindDeliveryProjection: vi.fn(), bindNativeSession: vi.fn(),
    beforeTool: vi.fn(), privateResult: () => null, preparationSettled: vi.fn(), preparationDelivered: vi.fn(),
    terminalEnvelope: vi.fn(), nativeClosed: vi.fn(), responseBody: vi.fn(), abandon: vi.fn(),
  };
  const host: SameTurnToolSessionPort = {
    ...f.port, planning, session: { ...f.port.session, tools: [{ ...f.port.session.tools[0]!, name }] },
    propose: (...parameters) => { active = true; return f.propose(...parameters); },
  };
  const h = await f.start('continue', null, host), stop = new AbortController();
  const pending = expect(h.run(stop.signal)).rejects.toMatchObject({ code: 'BRAIN_SAME_TURN_REFUSED' });
  const propose = (id: string) => h.driver.port.propose({ id, name, argumentsJson: JSON.stringify(args) },
    { kind: 'codex-mcp', callId: id, itemId: `wire-${id}`, deckentCallId: id }, stop.signal);
  try {
    await vi.waitFor(() => expect(h.deltas.map(delta => delta.text).join('')).toContain('K16-WAITING'));
    expect(await propose('first')).toMatchObject({ deckentCallId: 'first' });
    expect(planning.active).toBe(true);
    await expect(propose('second')).rejects.toMatchObject({ code: 'HEADLESS_REQUEST_INVALID' });
    expect(f.propose).toHaveBeenCalledOnce();
    await pending;
    const reason = h.driver.refusal();
    expect(reason).toBe('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
    for (const locale of ['en', 'tr'] as const) {
      expect.soft(nativeAgentReasonText(reason!, locale, false, true, h.driver.refusalCheck())).toBe(t('headless.agent.toolItemStopped', {}, locale));
    }
  } finally { stop.abort(); await pending.catch(() => undefined); }
});
