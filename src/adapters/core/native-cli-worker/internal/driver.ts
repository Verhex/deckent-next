import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { HeadlessEgress } from '#domain/index.js';
import { modelInvocationProfileDigest } from '#engine/index.js';
import { nativeCliAgent, nativeEffortArgs } from '#adapters/core/native-cli-registry/index.js';
import { buildHeadlessEnv, codexAgentArgv, codexAgentTurn } from '#adapters/core/native-cli-headless/index.js';
import { createNativeLineObserver, createNormalizerState, createCodexState, flushUnmapped } from '#adapters/core/native-connection/index.js';
import type { ProcessCommand, ProcessEvidence, ProcessLineConsumer } from '#adapters/core/process-runner/index.js';
import type { ToolSessionPort, NativeAgentExecution } from '#capabilities/index.js';
import type { NativeCliWorkerPorts, NativeCliWorkerDriver } from './ports.js';
import { NativeCliWorkerError } from './profile.js';

type Prepared = Parameters<typeof codexAgentTurn>[0];
type Preflight = Parameters<typeof codexAgentTurn>[1];
type Entry = NonNullable<ReturnType<typeof nativeCliAgent>>;
type Bounds = Omit<Extract<ProcessCommand, { schemaVersion: 2 }>, 'requestId' | 'executable' | 'args' | 'cwd' | 'env' | 'schemaVersion'>;
type Bridge = Parameters<NativeCliWorkerDriver['run']>[0];
type ClaudeDriver = ToolSessionPort & { readonly signal: AbortSignal; line: ProcessLineConsumer;
  finish(evidence: ProcessEvidence): { kind: 'completed'; text: string } | { kind: 'refused'; reason: import('#capabilities/index.js').NativeAgentReadinessReason } | { kind: 'cancelled' | 'failed' } };
/** K16 binds its public preflight/realm and K2 exports here. No adapter-internal import or host-spawn alternative. */
export interface NativeCliWorkerTransport {
  readonly profile: Prepared['profile'];
  preflight(signal: AbortSignal): Promise<{ execution: NativeAgentExecution; preflight: Preflight }>;
  claudeDriver(input: { entry: Entry; port: ToolSessionPort; model: string; cliVersion: string; runDir: string; outputMaxBytes: number }): ClaudeDriver;
  claudeRun(entry: Entry, session: ToolSessionPort['session'], input: { runDir: string; model: string; system: string; turnToken: string; effort?: string }): Promise<{
    args: readonly string[]; configFile: string; promptFile: string; dispose(): Promise<void> }>;
  runIsolated(entry: Entry, spawn: { executable: string; args: readonly string[]; env: Readonly<Record<string, string>>; stateDir: string; runDir: string; configDir: string;
    promptFile: string; mcpConfigFile?: string; mcp: Bridge; now: () => number }, bounds: Bounds, signal: AbortSignal,
    line: ProcessLineConsumer): Promise<ProcessEvidence & { egress: HeadlessEgress; limit: string | null }>;
}

/** Pure factory. The sole model spawn is run(), using K16's existing isolated runner and login lock. */
export function createNativeCliWorkerDriver(input: Parameters<NativeCliWorkerPorts['driver']>[0], transport: NativeCliWorkerTransport,
  signal: AbortSignal): NativeCliWorkerDriver {
  const entry = nativeCliAgent(input.binding.protocolFamily);
  if (!entry || modelInvocationProfileDigest(transport.profile) !== input.binding.profileDigest
    || !isDeepStrictEqual(transport.profile.adapter.definition, input.binding.definition)
    || input.maxTurns !== undefined && !entry.command.capabilities.maxTurns
    || Buffer.byteLength(input.user) > entry.headless.limits.stdinMaxBytes || Buffer.byteLength(input.system) > entry.headless.limits.stdinMaxBytes)
    throw new NativeCliWorkerError('NATIVE_CLI_WORKER_UNAVAILABLE');
  const calls = new Map<string, NonNullable<ReturnType<Parameters<typeof codexAgentTurn>[3]>>>();
  let claude: ClaudeDriver | undefined, runDir: string | undefined, dispose: (() => Promise<void>) | undefined, used = false, ended = false;
  const tools: ToolSessionPort = { session: input.tools.session,
    async propose(call, correlation, callSignal) {
      if (signal.aborted || ended) throw new NativeCliWorkerError('NATIVE_CLI_WORKER_UNAVAILABLE');
      if (entry.agent.transport.kind === 'claude-mcp') {
        if (!claude) throw new NativeCliWorkerError('NATIVE_CLI_WORKER_UNAVAILABLE');
        return claude.propose(call, correlation, callSignal);
      }
      const result = await input.tools.propose(call, correlation, callSignal);
      calls.set(call.id, { call, result }); return result;
    }, cancel: () => input.tools.cancel(), revoke: () => input.tools.revoke() };
  return { tools,
    async run(bridge, runSignal) {
      if (used) throw new NativeCliWorkerError('NATIVE_CLI_WORKER_UNAVAILABLE'); used = true;
      const combined = AbortSignal.any([signal, runSignal]), checked = await transport.preflight(combined);
      if (!isDeepStrictEqual(checked.execution, input.execution)) throw new NativeCliWorkerError('NATIVE_CLI_WORKER_UNAVAILABLE');
      runDir = await realpath(await mkdtemp(join(input.binding.definition.stateDir, 'worker-run-')));
      const effortArgs = input.effort ? nativeEffortArgs(entry.command.capabilities.reasoningEffort, input.effort) : [];
      const prepared: Prepared = { profile: transport.profile, definition: input.binding.definition, entry, model: input.model,
        system: input.system, user: input.user, effortArgs };
      claude = entry.agent.transport.kind === 'claude-mcp' ? transport.claudeDriver({ entry, port: input.tools, model: input.model,
        cliVersion: checked.preflight.version, runDir, outputMaxBytes: input.outputBytes }) : undefined;
      const turn = claude ? undefined : codexAgentTurn(prepared, checked.preflight, tools.session, id => calls.get(id));
      let args: readonly string[], configFile: string | undefined, promptFile = join(runDir, entry.headless.systemPromptFile);
      if (claude) {
        const files = await transport.claudeRun(entry, tools.session, { runDir, model: input.model, system: input.system, turnToken: bridge.turnToken,
          ...(input.effort?.level ? { effort: input.effort.level } : {}) });
        args = [...files.args, ...(input.maxTurns === undefined ? [] : [entry.command.capabilities.maxTurns!.flag, String(input.maxTurns)])];
        promptFile = files.promptFile; configFile = files.configFile; dispose = () => files.dispose();
      } else {
        args = codexAgentArgv(entry, tools.session, runDir, input.model, effortArgs, bridge.url);
        await writeFile(promptFile, input.system, { mode: 0o600, flag: 'wx' });
      }
      const state = createNormalizerState([bridge.turnToken]), observer = createNativeLineObserver(entry.command.capabilities.eventStream, state, createCodexState(),
        events => input.onEvents?.(events as import('#domain/index.js').WorkerEvent[]));
      let refused = false;
      const evidence = await transport.runIsolated(entry, { executable: checked.preflight.executable, args,
        env: { ...buildHeadlessEnv(entry.headless, runDir, input.binding.definition.configDir), ...(claude ? {} : { [bridge.tokenEnvName]: bridge.turnToken }) },
        stateDir: input.binding.definition.stateDir, runDir, configDir: input.binding.definition.configDir, promptFile,
        ...(configFile ? { mcpConfigFile: configFile } : {}), mcp: bridge, now: Date.now },
      { timeoutMs: input.deadlineMs, outputBytes: 2 * input.outputBytes + entry.headless.limits.responseFramingBytes, stderrBytes: entry.headless.limits.stderrMaxBytes,
        maxLineBytes: entry.headless.limits.maxLineBytes, interruptGraceMs: entry.headless.limits.killGraceMs, stdinBase64: Buffer.from(input.user).toString('base64') },
      claude ? AbortSignal.any([combined, claude.signal]) : combined, raw => {
        const stop = claude ? claude.line(raw) === 'stop' : !!turn!.line(raw);
        if (stop) { refused = true; return 'stop'; }
        observer.observe(Buffer.from(raw + '\n'));
      });
      ended = true; observer.flush(); input.onEvents?.(flushUnmapped(state) as import('#domain/index.js').WorkerEvent[]);
      const finished = claude?.finish(evidence), result = turn?.end({ exited: evidence.reason === 'exit', exitCode: evidence.exitCode }, evidence.egress);
      if (finished?.kind === 'refused' || refused) return { termination: 'confirmed', status: 'failed', text: '',
        refusal: finished?.kind === 'refused' ? finished.reason : 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED' };
      if (combined.aborted || evidence.reason === 'cancelled' || evidence.reason === 'timeout') return { termination: 'confirmed', status: 'cancelled', text: '' };
      if (evidence.limit || evidence.stdoutTruncated || evidence.stderrTruncated) return { termination: 'confirmed', status: 'failed', text: '' };
      if (finished?.kind === 'completed') return { termination: 'confirmed', status: 'completed', text: finished.text };
      if (result && 'response' in result) {
        const native = result.response.native as { choices?: { message?: { content?: unknown } }[] }, content = native.choices?.[0]?.message?.content;
        if (typeof content === 'string') return { termination: 'confirmed', status: 'completed', text: content };
      }
      return { termination: 'confirmed', status: 'failed', text: '' };
    },
    async close() {
      // A thrown runner has no process-end proof; retain private files for reconciliation rather than remove a live CLI's files.
      if (used && !ended) return;
      try { await dispose?.(); } finally { if (runDir) await rm(runDir, { recursive: true, force: true }); calls.clear(); }
    },
  };
}
