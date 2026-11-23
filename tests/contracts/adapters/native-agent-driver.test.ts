import { withRecordedToolError, errorCallArgs } from '../../fixtures/native-headless/recorded-error.js';
import { mkdir, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseModelBindingDefinition, modelInvocationProfileSchema, readHeadlessRejection, type ModelInvocationDelta } from '#domain/index.js';
import { createNativeAgentDriver, preflightNativeAgent, readNativeAgentObservation, headlessFlagSetDigest, nativeCliHeadlessDefinitionSchema } from '#adapters/core/native-cli-headless/index.js';
import { inspectNativeCliWorker } from '#adapters/core/native-cli-worker/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { createNativeToolBridge } from '#adapters/core/native-tool-bridge/index.js';
import { nativeEgressLimits } from '#adapters/core/native-connection/index.js';
import { inspectSubscriptionReadiness } from '#composition/core/subscription-readiness/index.js';
import { inspectNativeChat, nativeChatVerificationExecution } from '#composition/core/terminal-chat/index.js';
import { nativeQuotaText, nativeAgentReasonText, type SameTurnPlanningPort, type SameTurnToolSessionPort, type ToolSessionPort } from '#capabilities/index.js';
import { snapshotKnownSecrets, clockText, t } from '#platform/index.js';
import { connection, cleanupConnections, testIsolation } from '../../fixtures/native-headless/connection.js';
import { fakeCodexNpm } from '../../fixtures/native-headless/codex.js';
import { nativeAgentRealmAvailable, writeFakeAgentCli, type FakeAgentScenario } from '../../fixtures/native-headless/agent.js';
import registry from '../../../assets/native-coding/commands.json' with { type: 'json' };

const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); await cleanupConnections(); });
const families = [registry.adapters.claude.capabilities.eventStream, registry.adapters.codex.headless.protocolFamily];
async function fixture(family: string, scenario: FakeAgentScenario = {}, npm = false) {
  const c = await connection(), bin = join(c.root, 'agent-bin'); await mkdir(bin);
  const executable = await writeFakeAgentCli(bin, family, scenario), entry = nativeCliAgent(family)!;
  const installation = npm ? await fakeCodexNpm(c.root, { logPath: join(c.configDir, 'config.toml') }) : null;
  const connectedPath = installation?.chosen ?? join(bin, 'connected-cli');
  if (installation) await rename(executable, installation.payload); else await symlink(executable, connectedPath);
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
    return { ...sealed, driver, bridge, native, prepared, deltas, run: (signal?: AbortSignal) => native.send(prepared, signal, delta => deltas.push(delta)) };
  };
  return { c, profile, entry, start, propose, port, program: installation?.payload ?? executable };
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
it.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('uses the native program for governed chat and worker readiness, then discards the old observation after a payload update', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const f = await fixture(families[1]!, {}, true), h = await f.start();
  expect(h.execution.executable).toBe(f.program);
  const read = () => readNativeAgentObservation(f.profile), runtime = { readiness: { read } };
  expect(await read()).toMatchObject({ toolSurface: null, plugins: null, bridge: null });
  expect(await nativeChatVerificationExecution(f.profile, runtime)).toEqual(h.execution);
  expect(await h.run()).toMatchObject({ native: { choices: [{ message: { content: 'agent completed' } }] } });
  expect(await read()).toMatchObject({ toolSurface: true, execution: { executable: f.program } });
  expect(await inspectNativeChat(f.profile, runtime)).toEqual({ state: 'ready', execution: h.execution });
  const binding = { schemaVersion: 1 as const, connectionId: '00000000-0000-4000-8000-000000000001', resourceKey: 'npm-fixture',
    profileDigest: h.execution.profileDigest, protocolFamily: f.profile.protocol.family,
    definition: nativeCliHeadlessDefinitionSchema.parse(f.profile.adapter.definition) };
  const readiness = () => inspectNativeCliWorker(binding, { async readiness() {
    const current = await read();
    return current ? { state: 'ready', execution: current.execution } : { state: 'unknown', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' };
  }, f08: async () => h.execution });
  expect(await readiness()).toMatchObject({ state: 'ready', execution: { executable: f.program } });
  await writeFile(f.program, '\n// updated native program\n', { flag: 'a' });
  expect(await read()).toBeNull();
  expect(await readNativeAgentObservation(f.profile, Date.now, true)).toBeNull();
  expect(await nativeChatVerificationExecution(f.profile, runtime)).toBeNull();
  expect(await inspectNativeChat(f.profile, runtime)).toEqual({ state: 'unknown', reason: 'NATIVE_AGENT_CLI_UNAVAILABLE' });
  expect(await readiness()).toMatchObject({ state: 'waiting', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' });
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
