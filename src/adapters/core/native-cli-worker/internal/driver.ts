import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { nativeCallObservationSchema, type HeadlessEgress, type RateLimitFact } from '#domain/index.js';
import { modelInvocationProfileDigest } from '#engine/index.js';
import type { DeckentError } from '#platform/index.js';
import { nativeCliAgent, nativeEffortArgs } from '#adapters/core/native-cli-registry/index.js';
import { codexAgentTurn, nativeAgentLaunch } from '#adapters/core/native-cli-headless/index.js';
import { createNativeLineObserver, createNormalizerState, createCodexState, flushUnmapped, nativeQuotaPolicy } from '#adapters/core/native-connection/index.js';
import type { ProcessCommand, ProcessEvidence, ProcessLineConsumer } from '#adapters/core/process-runner/index.js';
import { CODEX_TOOL_ITEM_RESERVATION, nativeWorkerPreflight, nativeWorkerToolGate, nativeWorkerProcessResult, type ToolSessionPort, type NativeAgentExecution, type ClaudeAgentResult } from '#capabilities/index.js';
import type { NativeCliWorkerPorts, NativeCliWorkerDriver } from './ports.js';
import { NativeCliWorkerError } from './profile.js';

type Prepared = Parameters<typeof codexAgentTurn>[0];
type Preflight = Parameters<typeof codexAgentTurn>[1];
type Entry = NonNullable<ReturnType<typeof nativeCliAgent>>;
type Bounds = Omit<Extract<ProcessCommand, { schemaVersion: 2 }>, 'requestId' | 'executable' | 'args' | 'cwd' | 'env' | 'schemaVersion'>;
type Bridge = Parameters<NativeCliWorkerDriver['run']>[0];
type ClaudeDriver = ToolSessionPort & { readonly signal: AbortSignal; line: ProcessLineConsumer;
  finish(evidence: ProcessEvidence): ClaudeAgentResult | { kind: 'completed'; text: string };
  observedFacts?(): Readonly<{ builtinPluginCount: number; paidExtraUsage: RateLimitFact | null; terminal: boolean }> };
/** K16 binds its public preflight/realm and K2 exports here. No adapter-internal import or host-spawn alternative. */
export interface NativeCliWorkerTransport {
  readonly profile: Prepared['profile'];
  preflight(signal: AbortSignal): Promise<{ execution: NativeAgentExecution; preflight: Preflight }>;
  claudeDriver(input: { entry: Entry; port: ToolSessionPort; model: string; cliVersion: string; runDir: string; outputMaxBytes: number;
    quotaPolicy: ReturnType<typeof nativeQuotaPolicy> }): ClaudeDriver;
  runIsolated(entry: Entry, spawn: { executable: string; program: Preflight['program']; args: readonly string[]; env: Readonly<Record<string, string>>; stateDir: string; runDir: string; configDir: string;
    promptFile: string; mcpConfigFile?: string; mcp: Bridge; now: () => number }, bounds: Bounds, signal: AbortSignal,
    line: ProcessLineConsumer): Promise<ProcessEvidence & { egress: HeadlessEgress; limit: string | null; cleanupError?: DeckentError }>;
}

/** F2-7: the worker-event class of each bridged Deckent tool (its own spec's class), so a read, edit or command reads as one and an edited path counts as changed. */
const WORKER_CLASS: Readonly<Record<ToolSessionPort['session']['tools'][number]['toolClass'], string>> = { read: 'read', edit: 'edit', shell: 'shell', deckent: 'other', mcp: 'network' };
const bridgeToolClasses = (prefix: string, tools: ToolSessionPort['session']['tools']) => new Map(tools.map(tool => [prefix + tool.name, WORKER_CLASS[tool.toolClass]]));
/** Pure factory. The sole model spawn is run(), using K16's existing isolated runner and login lock. */
export function createNativeCliWorkerDriver(input: Parameters<NativeCliWorkerPorts['driver']>[0], transport: NativeCliWorkerTransport,
  signal: AbortSignal): NativeCliWorkerDriver {
  const entry = nativeCliAgent(input.binding.protocolFamily);
  if (!entry || modelInvocationProfileDigest(transport.profile) !== input.binding.profileDigest
    || !isDeepStrictEqual(transport.profile.adapter.definition, input.binding.definition)
    || input.maxTurns !== undefined && !entry.command.capabilities.maxTurns
    || Buffer.byteLength(input.user) > entry.headless.limits.stdinMaxBytes || Buffer.byteLength(input.system) > entry.headless.limits.stdinMaxBytes)
    throw new NativeCliWorkerError('NATIVE_CLI_WORKER_UNAVAILABLE');
  const gate = nativeWorkerToolGate(input.tools, signal), tools = gate.tools;
  let claude: ClaudeDriver | undefined, runDir: string | undefined, dispose: (() => Promise<void>) | undefined, used = false, ended = false;
  return { tools,
    async run(bridge, runSignal) {
      if (used) throw new NativeCliWorkerError('NATIVE_CLI_WORKER_UNAVAILABLE'); used = true;
      const combined = AbortSignal.any([signal, runSignal]), checked = await nativeWorkerPreflight(() => transport.preflight(combined), combined);
      if (!checked) { ended = true; gate.stop(); return { termination: 'confirmed', status: 'cancelled', text: '', started: false }; }
      if (!isDeepStrictEqual(checked.execution, input.execution)) throw new NativeCliWorkerError('NATIVE_CLI_WORKER_UNAVAILABLE');
      runDir = await realpath(await mkdtemp(join(input.binding.definition.stateDir, 'worker-run-')));
      const effortArgs = input.effort ? nativeEffortArgs(entry.command.capabilities.reasoningEffort, input.effort) : [];
      const prepared: Prepared = { profile: transport.profile, definition: input.binding.definition, entry, model: input.model,
        system: input.system, user: input.user, effortArgs };
      claude = entry.agent.transport.kind === 'claude-mcp' ? transport.claudeDriver({ entry, port: input.tools, model: input.model,
        cliVersion: checked.preflight.version, runDir, outputMaxBytes: input.outputBytes, quotaPolicy: nativeQuotaPolicy() }) : undefined;
      const turn = claude ? undefined : codexAgentTurn(prepared, checked.preflight, tools.session, id => {
        const host = gate.lookup(id);
        if (!host || host.result.outcome.status === 'ok') return host;
        return { ...host, result: JSON.parse(bridge.project(JSON.stringify(host.result))) as typeof host.result };
      }, undefined, undefined, AbortSignal.any([combined, gate.signal]));
      gate.bind(claude ?? { async propose(call, correlation, callSignal) {
        if (!turn?.accepts(call)) throw new NativeCliWorkerError('NATIVE_CLI_WORKER_UNAVAILABLE');
        return input.tools.propose(call, correlation, callSignal);
      } });
      const launch = await nativeAgentLaunch(entry, { session: tools.session, runDir, configDir: input.binding.definition.configDir, model: input.model, system: input.system,
        user: input.user, effortArgs, ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }), turnToken: bridge.turnToken, bridgeUrl: bridge.url,
        timeoutMs: input.deadlineMs, outputMaxBytes: input.outputBytes }); dispose = launch.dispose;
      const state = createNormalizerState([bridge.turnToken], Date.now(), undefined, bridgeToolClasses(entry.bridge.toolPrefix, tools.session.tools)), observer = createNativeLineObserver(entry.command.capabilities.eventStream, state, createCodexState(),
        events => input.onEvents?.(events as import('#domain/index.js').WorkerEvent[]));
      let lineStopped = false, observed = false;
      // N0: at most one count-only observation from host-known values: before session.ended on an accepted result line, otherwise once the runner settles;
      // N0 R5 (owner D5): a runner that reports no started process offers none (a rejected runner's start stays unknown and still does).
      const observe = () => {
        const facts = claude?.observedFacts?.(); if (observed || !facts || !input.onEvents) return; observed = true;
        const observation = nativeCallObservationSchema.safeParse({ schemaVersion: 1, cliVersion: checked.preflight.version,
          builtinPlugins: facts.builtinPluginCount ? { names: [], omitted: facts.builtinPluginCount } : null, paidExtraUsage: facts.paidExtraUsage });
        if (observation.success) input.onEvents([{ schemaVersion: 1, kind: 'cli.observation', sequence: ++state.sequence, atMs: Math.max(0, Date.now() - state.startMs), observation: observation.data }]);
      };
      const evidence = await transport.runIsolated(entry, { ...launch.spawn, executable: checked.preflight.executable, program: checked.preflight.program, stateDir: input.binding.definition.stateDir,
        mcp: bridge, now: Date.now }, launch.bounds, AbortSignal.any([combined, gate.signal, ...(claude ? [claude.signal] : [])]), raw => {
        const stop = claude ? claude.line(raw) === 'stop' : !!turn!.line(raw);
        if (stop) { lineStopped = true; return 'stop'; }
        if (claude?.observedFacts?.().terminal) observe();
        observer.observe(Buffer.from(raw + '\n'));
      }).then(settled => { if (settled.started) observe(); return settled; }, (error: unknown) => { observe(); throw error; });
      ended = true; gate.stop(); observer.flush(); input.onEvents?.(flushUnmapped(state) as import('#domain/index.js').WorkerEvent[]);
      const finished = claude?.finish(evidence), result = turn?.end({ exited: evidence.reason === 'exit', exitCode: evidence.exitCode }, evidence.egress);
      // A clean-up failure keeps the established classification below; the turn-only refusal applies to a settled run.
      if (!evidence.cleanupError && result && 'refusal' in result && 'field' in result.refusal.body && result.refusal.body.field === CODEX_TOOL_ITEM_RESERVATION)
        return { termination: 'confirmed', status: 'failed', text: CODEX_TOOL_ITEM_RESERVATION, refusal: 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', started: evidence.started };
      // N0 R5 (owner D5): the runner's own start fact travels up; a runner that threw leaves it unknown (realm: only a pre-callback cancel proves none).
      return { ...nativeWorkerProcessResult(evidence, combined.aborted, gate.refused(), finished,
        result ? { ...result, lineStopped } : undefined, gate.terminalFailure()), started: evidence.started };
    },
    async close() {
      // A thrown runner has no process-end proof; retain private files for reconciliation rather than remove a live CLI's files.
      if (used && !ended) return;
      try { await dispose?.(); } finally { if (runDir) await rm(runDir, { recursive: true, force: true }); gate.clear(); }
    },
  };
}
