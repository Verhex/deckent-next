import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseModelBindingDefinition, modelInvocationProfileSchema, readHeadlessRejection, type ModelInvocationDelta } from '#domain/index.js';
import { createNativeAgentDriver, preflightNativeAgent, readNativeAgentObservation, headlessFlagSetDigest } from '#adapters/core/native-cli-headless/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { createNativeToolBridge } from '#adapters/core/native-tool-bridge/index.js';
import { nativeEgressLimits } from '#adapters/core/native-connection/index.js';
import { inspectSubscriptionReadiness } from '#composition/core/subscription-readiness/index.js';
import { inspectNativeChat } from '#composition/core/terminal-chat/index.js';
import type { ToolSessionPort } from '#capabilities/index.js';
import { snapshotKnownSecrets } from '#platform/index.js';
import { connection, cleanupConnections, testIsolation } from '../../fixtures/native-headless/connection.js';
import { nativeAgentRealmAvailable, writeFakeAgentCli, type FakeAgentScenario } from '../../fixtures/native-headless/agent.js';
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
  const start = async () => {
    const sealed = await preflightNativeAgent(profile, Date.now, testIsolation);
    const driver = createNativeAgentDriver({ profile, execution: sealed.execution, session: port, now: Date.now, isolation: testIsolation });
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
    const prepared = await native.prepare(profile, binding, { model, messages: [{ role: 'system', content: 'Use governed tools.' }, { role: 'user', content: 'Read the scoped fixture.' }], stream: false });
    const deltas: ModelInvocationDelta[] = [];
    return { ...sealed, driver, bridge, native, prepared, deltas, run: (signal?: AbortSignal) => native.send(prepared, signal, delta => deltas.push(delta)) };
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
  const f = await fixture(family, { events: [{ type: 'system', subtype: 'permission_denied' }], calls }), h = await f.start(), result = await h.run();
  expect(result.kind === 'rejected' ? readHeadlessRejection(result.evidence) : null).toMatchObject({ field: 'agent-surface:event', subtype: 'system/permission_denied' });
  await notPaused(f.profile);
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
