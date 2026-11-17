import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import * as headless from '#adapters/core/native-cli-headless/index.js';
import * as invocationStore from '#adapters/core/sqlite-model-invocation/index.js';
import { nativeCliAgent, readLocalOsIdentity } from '#adapters/index.js';
import { firstRunPolicyTemplate, modelInvocationProfileSchema, type AgentTurnStreamEvent } from '#domain/index.js';
import { brainPlannerConfigSchema } from '#capabilities/core/run-planner/index.js';
import { FIRST_RUN_TOOL_NAMES, ModelInvocationControllers, modelInvocationProfileDigest } from '#engine/index.js';
import { createRuntimeChatTurnHost, runPeerConfiguredChatTurn, type NativeChatRuntime } from '#composition/core/agent-turn/index.js';
import { planServiceRun } from '#composition/core/run-planner/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { loadProposalViews } from '#surfaces/index.js';
import { clearConfigCache } from '#platform/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import { createTerminalRuntimeClient, terminalRuntimePeer } from '../support/terminal-runtime-client.js';
import { CODEX_FAMILY } from '../../fixtures/native-headless/codex.js';
import { FAMILY } from '../../fixtures/native-headless/stream.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
// Existing known-red convention: executable body retained under it.todo (setup-init-wired-pty.test.ts).
// Explicit opt-in runs the real RED; the green transition also needs challenge/draft/normal-close replay (README.txt).
for (const family of [CODEX_FAMILY, FAMILY]) {
  const name = `K3a ${family}: one subscription slot reaches one person card inside its open chat claim`;
  const check = async () => {
    if (process.platform !== 'linux') throw new Error('REQUIRES_LINUX_TERMINAL_PEER');
    const owner = readLocalOsIdentity(), f = await brainProviderFixture({ maxInFlight: 1, headless: {
      executable: process.execPath, configDir: '/fixture-login', stateDir: '/fixture-state', protocolFamily: family,
      delegatedUse: { consentedBy: { issuer: owner.issuer, subject: owner.subject }, atMs: 1, classes: ['ai'] },
    } });
    cleanups.push(f.close);
    const profile = modelInvocationProfileSchema.parse(f.config.provider_invocation_profiles.profiles[0]), entry = nativeCliAgent(family)!;
    expect(f.config.provider_invocation_profiles.profiles).toHaveLength(1);
    expect(profile.billingAxis).toBe('subscription'); expect(profile.allocation.maxInFlight).toBe(1);
    expect(brainPlannerConfigSchema.parse((await loadComposedConfig(f.project, f.options))['brain_planner'] ?? {}))
      .toMatchObject({ maxCompletionTokens: null, reasoning: 'model-default' });
    const policy = firstRunPolicyTemplate({ scopeId: 's', principal: { issuer: owner.issuer, subject: owner.subject }, ...FIRST_RUN_TOOL_NAMES });
    await writeFile(join(f.data, 'policy.json'), JSON.stringify(policy.policy), { mode: 0o600 });
    await writeFile(join(f.data, 'bindings.json'), JSON.stringify({ schemaVersion: 3, revision: 'fixture', bindings: [], modes: [] }), { mode: 0o600 }); clearConfigCache();
    const peer = await terminalRuntimePeer(createTerminalRuntimeClient(f.project, f.options));
    const trace: Record<string, unknown>[] = [], events: AgentTurnStreamEvent[] = [], abort = new AbortController();
    let reached!: () => void;
    const barrier = new Promise<void>(resolve => { reached = resolve; });
    const register = ModelInvocationControllers.prototype.register;
    vi.spyOn(ModelInvocationControllers.prototype, 'register').mockImplementation(function (this: ModelInvocationControllers, claim, ownerId) {
      trace.push({ event: 'claim-register-attempt', commandId: claim.commandId });
      try { return register.call(this, claim, ownerId); }
      catch (error) { trace.push({ event: 'claim-register-refused', code: (error as { code: string }).code }); reached(); throw error; }
    });
    const openStore = invocationStore.openSqliteModelInvocationStore;
    vi.spyOn(invocationStore, 'openSqliteModelInvocationStore').mockImplementation(async (...args) => {
      const store = await openStore(...args), claim = store.claim.bind(store);
      vi.spyOn(store, 'claim').mockImplementation(async input => {
        trace.push({ event: 'claim-attempt', commandId: input.command.commandId, reference: input.command.reference });
        try { const result = await claim(input); trace.push({ event: 'claimed', commandId: input.command.commandId }); return result; }
        catch (error) { trace.push({ event: 'claim-refused', code: (error as { code: string }).code }); reached(); throw error; }
      });
      return store;
    });
    // External CLI boundary only: no binary, preflight, login or provider is ever used. The real store still owns claim/send permission.
    vi.spyOn(headless, 'createNativeCliHeadlessPort').mockImplementation(() => ({ billingAxis: 'subscription', preflight: async () => undefined,
      prepare: async (_profile, _definition, request) => { trace.push({ event: 'brain-prepare', cap: request['max_completion_tokens'], reasoning: request['reasoning_effort'] ?? 'model-default' }); return {}; },
      send: async () => { trace.push({ event: 'brain-send' }); throw new Error('UNEXPECTED_SECOND_SEND'); },
    }) as ReturnType<typeof headless.createNativeCliHeadlessPort>);
    const runtime: NativeChatRuntime = {
      readiness: { read: async () => ({ cli: true, login: true, environment: true, plugins: true, toolSurface: true, bridge: true,
        execution: { schemaVersion: 1, capability: 'NativeAgentExecution', executable: process.execPath, cliVersion: '9.0.0',
          flagSetDigest: headless.nativeAgentFlagSetDigest(entry), profileDigest: modelInvocationProfileDigest(profile), ownerUid: process.getuid!() } }) },
      limits: { idleMs: 10_000, maxConnections: 1, replayMaxEntries: 1, replayMaxBytes: entry.bridge.frameMaxBytes },
      resolveModelUse: async () => Object.freeze({ fixture: true }),
      driver: async ({ session }) => ({ port: session, admit: async () => undefined, refusal: () => null, close: async () => undefined,
        native: () => ({ billingAxis: 'subscription', prepare: async () => ({}), send: async (_prepared, signal) => {
          trace.push({ event: 'outer-send' });
          const call = { id: 'prepare-work', name: 'propose_work', argumentsJson: '{"request":"prepare a purchase with durable readback"}' };
          const correlation = family === CODEX_FAMILY ? { kind: 'codex-mcp' as const, callId: 'rpc-1', itemId: 'item-1', deckentCallId: call.id }
            : { kind: 'claude-tool-use' as const, toolUseId: 'tool-1', deckentCallId: call.id };
          trace.push({ event: 'propose_work' });
          const result = await session.propose(call, correlation, signal!); trace.push({ event: 'preparation-result', outcome: result.outcome });
          // Keep the outer claim held until the test owner has inspected the refusal/card barrier and cancelled it.
          if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
          throw new Error('FIXTURE_CANCELLED');
        } }),
      }),
    };
    // Track both prospective claims so the real single-slot SQLite allocation/resource, rather than the custody-map bound, refuses the second.
    const host = createRuntimeChatTurnHost({ ownerId: 'same-turn-fixture', controllers: new ModelInvocationControllers(2) }, abort.signal,
      undefined, undefined, () => [], undefined, runtime, planServiceRun,
      () => loadProposalViews().then(([planning, config]) => ({ cardLines: planning.brainProposalCardLines, schemaChoices: config.configSchemaChoices })));
    const running = runPeerConfiguredChatTurn(f.project, { schemaVersion: 1, scopeId: 's', turnId: 'same-turn', messages: [{ role: 'user', content: 'prepare a purchase' }] },
      peer, f.options, { maxResultBytes: 65_536 }, host, { signal: abort.signal, room: () => 1_000_000, drained: async () => true,
        emit(event) { events.push(event); if (event.kind === 'approval.requested') reached(); } });
    const settled = running.then(result => ({ result }), error => ({ error: String(error) }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([barrier, settled.then(result => { throw new Error('EARLY_TURN_EXIT ' + JSON.stringify(result)); }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('OWNED_BARRIER_TIMEOUT ' + JSON.stringify(trace))), 10_000); })]);
      const db = new DatabaseSync(f.path, { readOnly: true });
      let claimed: unknown, runs: unknown, capacity: unknown;
      try {
        claimed = db.prepare("SELECT command_id,state FROM model_invocations WHERE state='claimed'").all(); runs = db.prepare('SELECT COUNT(*) AS n FROM runs').get();
        capacity = db.prepare('SELECT execution_slots,in_flight_slots FROM capacity_resources WHERE binding_kind=?').all(profile.adapter.id);
      }
      finally { db.close(); }
      const cards = events.filter(event => event.kind === 'approval.requested');
      console.log('K3a barrier ' + JSON.stringify({ family, trace, claimed, capacity, runs, cards: cards.length }));
      expect(capacity).toEqual([{ execution_slots: 1, in_flight_slots: 1 }]);
      expect(claimed).toHaveLength(1); expect(runs).toMatchObject({ n: 0 });
      expect(trace.filter(row => row['event'] === 'outer-send')).toHaveLength(1);
      if (cards.length === 0) {
        expect(trace.filter(row => row['event'] === 'claim-register-attempt')).toHaveLength(2);
        expect(trace.filter(row => row['event'] === 'claim-attempt')).toHaveLength(2);
        expect(trace.at(-1)).toMatchObject({ event: 'claim-refused', code: 'MODEL_INVOCATION_CAPACITY_EXHAUSTED' });
        expect(trace.filter(row => row['event'] === 'brain-send')).toHaveLength(0);
        // Today's separate Brain call: its own cap setting is null, so the request carries the terminal fixture's inherited output cap.
        expect(trace.find(row => row['event'] === 'brain-prepare')).toMatchObject({ cap: 8, reasoning: 'model-default' });
      }
      expect(cards, 'K3a: separate Brain attempted a second claim while the outer chat claim owns the single subscription slot; expected one person card').toHaveLength(1);
      expect(trace.filter(row => row['event'] === 'claim-register-attempt')).toHaveLength(1);
      expect(trace.filter(row => row['event'] === 'brain-send')).toHaveLength(0);
    } finally { clearTimeout(timer); abort.abort(); await settled; await host.mcp.close(); }
  };
  if (process.env['DECKENT_SAME_TURN_RED'] === '1') it(name, check, 30_000);
  else {
    console.log('verify-not-run: ' + JSON.stringify({ file: expect.getState().testPath, test: name,
      variant: 'K3a-known-red', reason: 'separate-Brain-second-claim; run with DECKENT_SAME_TURN_RED=1; awaiting K1/K2 and recording replay' }));
    it.todo(name, check, 30_000);
  }
}
