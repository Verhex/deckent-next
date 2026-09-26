import { createHash } from 'node:crypto';
import { EffectError, type AgentToolOutcome, type EffectCommand } from '#domain/index.js';
import { EffectApplication, OperationPolicyAuthorization, agentToolArgumentsDigest, classifyReadOnlyShellCommand, classifyShellRisk,
  type EffectApprovalGate, type ShellRiskClassification } from '#engine/index.js';
import { SystemTrustedClock } from '#platform/index.js';
import { createLocalPeerSession, createShellPathContext, HOST_SHELL_COMMAND_MAX_CHARS, HOST_SHELL_RUN_OPERATION, HOST_SHELL_TARGET_KIND, HostShellTarget,
  openSqliteAttemptStore, type HostShellResult, type LocalPeerIdentity, type RuntimeServiceTurnChannel, type TerminalShellConfig,
  type WorkspaceScope } from '#adapters/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import { boundApprovalPreview } from './preview.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
type ShellPlan = { readonly ok: true; readonly command: string; readonly risk: ShellRiskClassification; readonly silent: boolean }
  | { readonly ok: false; readonly text: string };

/**
 * The agent's host shell in one turn (T-L4 slice 3c, Jev 82858581). A command is classified before authority is asked: only a
 * read-only command of bounded reach (risk `none`: explicit, checked paths) may run without asking, and only where policy allows;
 * traversal and repository-object reads (`low`), anything that modifies, and the destructive table ask the owner in every mode
 * (slice 4 may relax `modify`, never the destructive floor). Every run is a C11 effect of Core `host.shell.run` on the `host-shell`
 * target — session, operation policy, intent before spawn, an uncertain run reported as such and never repeated. Streamed output
 * goes to the turn only while the channel has room; beyond that it is skipped with one visible marker (the result is unaffected).
 */
export function createAgentShell(input: { readonly scope: WorkspaceScope; readonly peer: LocalPeerIdentity; readonly config: TerminalShellConfig;
  readonly context: Awaited<ReturnType<typeof loadPeerInvocationContext>>; readonly scopeId: string; readonly turnId: string; readonly channel: RuntimeServiceTurnChannel }) {
  const { scope, context, scopeId, turnId, channel } = input;
  const plans = new Map<string, ShellPlan>(), approved = new Set<string>(), approvedCommands = new Set<string>();
  const key = (tool: string, args: Record<string, unknown>) => agentToolArgumentsDigest(tool, args);
  const gate: EffectApprovalGate = {
    async admit(descriptor, decision, command) {
      if (descriptor.approval !== 'required' && decision === 'allow') return;
      if (!approvedCommands.has(command.commandId)) throw new EffectError('EFFECT_APPROVAL_REQUIRED');
    },
  };
  const plan = async (tool: string, args: Record<string, unknown>): Promise<ShellPlan> => {
    const command = typeof args['command'] === 'string' ? args['command'] : '';
    if (command.trim() === '') return { ok: false, text: '[deckent] run_shell: error=empty-command' };
    if (command.length > HOST_SHELL_COMMAND_MAX_CHARS) return { ok: false, text: `[deckent] run_shell: error=command-too-long (max ${HOST_SHELL_COMMAND_MAX_CHARS} characters)` };
    const readOnly = await classifyReadOnlyShellCommand(command, createShellPathContext(scope));
    const risk = classifyShellRisk(command, readOnly);
    const planned: ShellPlan = { ok: true, command, risk, silent: risk.risk === 'safe-read' && readOnly.risk === 'none' };
    plans.set(key(tool, args), planned);
    return planned;
  };
  const describeResult = (command: string, result: HostShellResult) => {
    const how = result.status === 'exited' ? `exit ${result.exitCode ?? `signal ${result.signal ?? '?'}`}` : result.status;
    return `[deckent] run_shell: ${how} after ${(result.durationMs / 1000).toFixed(1)}s (${command.length > 120 ? `${command.slice(0, 119)}…` : command})\n${result.output}`;
  };
  return {
    plan,
    /** The owner is asked unless the planned command is read-only with bounded reach. */
    asks(tool: string, args: Record<string, unknown>): boolean { const planned = plans.get(key(tool, args)); return !(planned?.ok && planned.silent); },
    /** The operation policy's decision for running a command at all, asked before the owner so a denied run is never offered. */
    async authority(): Promise<'allow' | 'deny' | 'require-approval'> {
      try { return await new OperationPolicyAuthorization(context.policy).authorize('execute', scopeId, HOST_SHELL_RUN_OPERATION.operation, context.principal); }
      catch { return 'deny'; }
    },
    /** The approval card: the exact command, its risk and why, and what running it means. */
    preview(tool: string, args: Record<string, unknown>): string | undefined {
      const planned = plans.get(key(tool, args));
      if (!planned?.ok) return undefined;
      return boundApprovalPreview(`$ ${planned.command}\nrisk: ${planned.risk.risk} (${planned.risk.reason})\n`
        + 'Runs on this machine as your user in the project root: not a sandbox (files, processes and network are reachable).');
    },
    approved(tool: string, args: Record<string, unknown>) { approved.add(key(tool, args)); },
    async apply(tool: string, args: Record<string, unknown>, signal: AbortSignal, callId: string): Promise<AgentToolOutcome> {
      const callKey = key(tool, args);
      const planned = plans.get(callKey) ?? await plan(tool, args);
      if (!planned.ok) return { status: 'error', text: planned.text };
      const commandId = sha256(`agent-shell-effect:1\0${scopeId}\0${turnId}\0${callKey}\0${callId}`);
      if (approved.has(callKey)) approvedCommands.add(commandId);
      const command: EffectCommand = { schemaVersion: 1, commandId, scopeId, operation: HOST_SHELL_RUN_OPERATION.operation,
        // Each run is its own record, so an uncertain run never makes the shell busy for the next one.
        target: { kind: HOST_SHELL_TARGET_KIND, id: `run-${commandId.slice(0, 32)}` }, idempotencyKey: commandId, input: { command: planned.command }, expectedVersion: null };
      let result: HostShellResult | null = null, skipped = false;
      const onOutput = (stream: 'stdout' | 'stderr', text: string) => {
        if (skipped) return;
        // Presentation only: past half the channel's room the display stops once, visibly; the result keeps its own bounded output.
        if (Buffer.byteLength(text, 'utf8') + 1_024 > channel.room() / 2) {
          skipped = true;
          channel.emit({ kind: 'tool.output', callId, stream: 'stderr', text: '[deckent] output display skipped (the client is not keeping up); the result keeps the output.\n' });
          return;
        }
        channel.emit({ kind: 'tool.output', callId, stream, text });
      };
      const clock = new SystemTrustedClock();
      const sessions = await createLocalPeerSession(input.peer, context.principal.scopeIds, context.config.approvals.sessionTtlMs, clock);
      const target = new HostShellTarget(scope.root, { timeoutMs: input.config.timeoutMs, extraEnv: input.config.environment, signal, onOutput,
        onResult: value => { result = value; } });
      const store = await openSqliteAttemptStore(await context.path(), context.config.storage.sqlite, 'forbid');
      try {
        await new EffectApplication({ async resolve(ref) {
          return ref.id === HOST_SHELL_RUN_OPERATION.operation.id && ref.version === HOST_SHELL_RUN_OPERATION.operation.version ? HOST_SHELL_RUN_OPERATION : null;
        } }, { resolve: kind => kind === HOST_SHELL_TARGET_KIND ? target : null }, store, gate, sessions,
        new OperationPolicyAuthorization(context.policy), clock).execute(command);
        // The streamed display must be delivered before the result joins it on the channel.
        await channel.drained();
        const ran = result as HostShellResult | null;
        if (!ran) return { status: 'error', text: '[deckent] run_shell: error=no-result' };
        return { status: ran.exitCode === 0 ? 'ok' : 'error', text: describeResult(planned.command, ran) };
      } catch (error) {
        const code = error instanceof EffectError ? error.code : (error as { code?: unknown })?.code;
        await channel.drained();
        const ran = result as HostShellResult | null;
        if (ran && ran.status !== 'exited') {
          return { status: 'error', text: `${describeResult(planned.command, ran)}\n[deckent] the command was stopped; what it changed before that is unknown.` };
        }
        const why = code === 'POLICY_DENIED' ? `denied by policy (operation ${HOST_SHELL_RUN_OPERATION.operation.id})`
          : code === 'EFFECT_APPROVAL_REQUIRED' ? 'the command needs an approval that was not given'
          : code === 'EFFECT_REJECTED' ? 'the command could not start' : typeof code === 'string' ? code : 'failed';
        return { status: 'error', text: `[deckent] run_shell: error=${why}` };
      } finally { store.close(); }
    },
  };
}
