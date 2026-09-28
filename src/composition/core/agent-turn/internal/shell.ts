import { createHash } from 'node:crypto';
import { EffectError, type AgentToolOutcome, type EffectCommand } from '#domain/index.js';
import { EffectApplication, OperationPolicyAuthorization, agentToolArgumentsDigest, classifyReadOnlyShellCommand, classifyShellMutation, classifyShellRisk,
  shellPermissionTier, type EffectApprovalGate, type ShellPathVerdict, type ShellPermissionTier, type ShellRiskClassification,
  type ShellWritePathContext } from '#engine/index.js';
import { SystemTrustedClock } from '#platform/index.js';
import { ABSENT_FILE_VERSION, createLocalPeerSession, createShellPathContext, HOST_SHELL_COMMAND_MAX_CHARS, HOST_SHELL_RUN_OPERATION, HOST_SHELL_TARGET_KIND,
  HostShellTarget, resolveShellRealm, shellSandboxCapabilities, type ShellRealmResolution, isWriteApprovalFloored, openSqliteAttemptStore, readWritableFile, resolveWritable, type HostShellResult, type LocalPeerIdentity,
  type RuntimeServiceTurnChannel, type TerminalShellConfig, type WorkspaceScope } from '#adapters/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import { boundApprovalPreview } from './preview.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/**
 * Effect identity of one shell call (Astra 2113): the turn, the call's position in it (model round, index in the response) and the
 * exact arguments. A replay of the same call is the same C11 effect (never run twice); another call is another effect even with the
 * same command and a provider call id reused across responses.
 */
export const agentShellEffectCommandId = (scopeId: string, turnId: string, execution: { readonly round: number; readonly index: number }, argsDigest: string) =>
  sha256(`agent-shell-effect:2\0${scopeId}\0${turnId}\0${execution.round}\0${execution.index}\0${argsDigest}`);
/**
 * What the result says about processes the command left behind (Astra 2124), within the host shell's process-group contract:
 * `clean` adds nothing; `group-ended` names members of the command's group that were ended (the group was then observed empty);
 * `unverified` says the output may be incomplete and a process the command started may still run, possibly outside its group.
 * Nothing here claims a process outside the group was seen or ended.
 */
function cleanupNote(cleanup: HostShellResult['cleanup']): string | null {
  if (cleanup === 'unverified') {
    return '[deckent] cleanup unverified: the output may be incomplete, and a process the command started may still be running, possibly '
      + 'outside its process group (that everything ended could not be verified); this is not a sandbox.';
  }
  return cleanup === 'group-ended' ? '[deckent] cleanup: processes the command left running in its process group were ended; '
    + 'a process that left the group is not observed.' : null;
}
type ShellPlan = { readonly ok: true; readonly command: string; readonly risk: ShellRiskClassification; readonly tier: ShellPermissionTier; readonly realm: Extract<ShellRealmResolution, { ok: true }> }
  | { readonly ok: false; readonly text: string };

/**
 * Write targets of the narrow mutating tier (T-L4 slice 4a), over the same workspace scope and write floor as agent edits: inside the
 * workspace, not denied, parent a real directory inside, not on the write floor (a new directory is refused when anything under it
 * would be), and the target absent (new directory), absent or a single-link regular file (file), or such an existing file (the source
 * of `mv`). Anything else makes the command not narrow — it then asks, as before.
 */
export function createShellWriteContext(scope: WorkspaceScope): ShellWritePathContext {
  return {
    async checkWrite(word, kind): Promise<ShellPathVerdict> {
      const refuse = (reasonCode: 'PATH_OUTSIDE_ROOT' | 'PATH_PROTECTED' | 'PATH_UNRESOLVED'): ShellPathVerdict => ({ ok: false, reasonCode, detail: word.text });
      const target = await resolveWritable(scope, word.text);
      if (!target.ok) return refuse(target.error === 'outside-workspace' ? 'PATH_OUTSIDE_ROOT' : target.error === 'denied' ? 'PATH_PROTECTED' : 'PATH_UNRESOLVED');
      if (isWriteApprovalFloored(target.rel) || (kind === 'new-directory' && isWriteApprovalFloored(`${target.rel}/-`))) return refuse('PATH_PROTECTED');
      // An existing directory, link or multi-link file is refused here (`not-a-file`, `is-link`, `hard-linked`): `cp`/`mv` onto a
      // directory would write `target/basename(source)`, a path this check never saw (Astra 2133), so a directory target is not narrow.
      const current = await readWritableFile(scope, target).catch(() => null);
      if (!current?.ok) return refuse('PATH_UNRESOLVED');
      const absent = current.version === ABSENT_FILE_VERSION;
      return (kind === 'new-directory' && !absent) || (kind === 'existing-file' && absent) ? refuse('PATH_UNRESOLVED') : { ok: true };
    },
  };
}

/**
 * The agent's host shell in one turn (T-L4 slice 3c, Jev 82858581). A command is classified into a permission tier: only a
 * read-only command of bounded reach (risk `none`: explicit, checked paths) runs without asking under allow; traversal and
 * repository-object reads (`low`), the destructive table, the always-ask floor and any other modification ask in every mode; the
 * narrow mutating set asks unless the turn's decision lowers a company-eligible require-approval in full-auto (slice 4a). Every run is a C11 effect of Core `host.shell.run` on the `host-shell`
 * target — session, operation policy, intent before spawn, an uncertain run reported as such and never repeated. Streamed output
 * goes to the turn only while the channel has room; beyond that it is skipped with one visible marker (the result is unaffected).
 */
export function createAgentShell(input: { readonly scope: WorkspaceScope; readonly peer: LocalPeerIdentity; readonly config: TerminalShellConfig;
  readonly context: Awaited<ReturnType<typeof loadPeerInvocationContext>>; readonly scopeId: string; readonly turnId: string; readonly channel: RuntimeServiceTurnChannel }) {
  const { scope, context, scopeId, turnId, channel } = input;
  const plans = new Map<string, ShellPlan>();
  const key = (tool: string, args: Record<string, unknown>) => agentToolArgumentsDigest(tool, args);
  const plan = async (tool: string, args: Record<string, unknown>): Promise<ShellPlan> => {
    const command = typeof args['command'] === 'string' ? args['command'] : '';
    if (command.trim() === '') return { ok: false, text: '[deckent] run_shell: error=empty-command' };
    if (command.length > HOST_SHELL_COMMAND_MAX_CHARS) return { ok: false, text: `[deckent] run_shell: error=command-too-long (max ${HOST_SHELL_COMMAND_MAX_CHARS} characters)` };
    const realm = resolveShellRealm(input.config.realm, await shellSandboxCapabilities());
    if (!realm.ok) return { ok: false, text: `[deckent] run_shell: error=${realm.code}; nothing was run` };
    const paths = createShellPathContext(scope);
    const readOnly = await classifyReadOnlyShellCommand(command, paths);
    const risk = classifyShellRisk(command, readOnly);
    // The narrow mutating tier is asked only for a command that is neither read-only nor destructive (it never demotes either).
    const mutation = readOnly.readOnly || risk.risk === 'destructive' ? { tier: 'unrecognized' as const, reasonCode: 'NOT_NARROW' as const }
      : await classifyShellMutation(command, paths, createShellWriteContext(scope));
    const planned: ShellPlan = { ok: true, realm, command, risk, tier: shellPermissionTier(risk, readOnly, mutation) };
    plans.set(key(tool, args), planned);
    return planned;
  };
  const describeResult = (command: string, result: HostShellResult, notice: string | null) => {
    const how = result.status === 'exited' ? `exit ${result.exitCode ?? `signal ${result.signal ?? '?'}`}` : result.status;
    const note = cleanupNote(result.cleanup);
    return `[deckent] run_shell: ${notice ? 'sandbox: none; ' : ''}${how} after ${(result.durationMs / 1000).toFixed(1)}s (${command.length > 120 ? `${command.slice(0, 119)}…` : command})\n${result.output}`
      + (notice ? `\n${notice}` : '')
      + (note ? `${!notice && (result.output.endsWith('\n') || result.output === '') ? '' : '\n'}${note}` : '');
  };
  return {
    plan,
    /** The planned command's permission tier (the mode decision's cell), or null when it was not planned. */
    tier(tool: string, args: Record<string, unknown>): ShellPermissionTier | null { const planned = plans.get(key(tool, args)); return planned?.ok ? planned.tier : null; },
    /** The approval card: the exact command, its risk and why, and what running it means. */
    preview(tool: string, args: Record<string, unknown>): string | undefined {
      const planned = plans.get(key(tool, args));
      if (!planned?.ok) return undefined;
      return boundApprovalPreview(`$ ${planned.command}\nrisk: ${planned.risk.risk} (${planned.risk.reason})\n`
        + (planned.realm.notice ?? 'Runs on this machine as your user in the project root: not a sandbox (files, processes and network are reachable).'));
    },
    /** Runs the call as a C11 effect; `gate` is the caller's durable-record approval gate for exactly this call (C12 G3). */
    async apply(tool: string, args: Record<string, unknown>, signal: AbortSignal, callId: string,
      execution: { readonly round: number; readonly index: number }, gate: EffectApprovalGate): Promise<AgentToolOutcome> {
      const callKey = key(tool, args);
      const planned = plans.get(callKey) ?? await plan(tool, args);
      if (!planned.ok) return { status: 'error', text: planned.text };
      const commandId = agentShellEffectCommandId(scopeId, turnId, execution, callKey);
      const command: EffectCommand = { schemaVersion: 1, commandId, scopeId, operation: HOST_SHELL_RUN_OPERATION.operation,
        // Each run is its own record, so an uncertain run never makes the shell busy for the next one.
        target: { kind: HOST_SHELL_TARGET_KIND, id: `run-${commandId.slice(0, 32)}` }, idempotencyKey: commandId, input: { command: planned.command }, expectedVersion: null };
      let result: HostShellResult | null = null, skipped = false;
      // The owner sees the cleanup note on the call's streamed output (the display surfaces show for the call), before the result.
      const showCleanup = async (ran: HostShellResult) => {
        const note = cleanupNote(ran.cleanup);
        if (!note) return;
        channel.emit({ kind: 'tool.output', callId, stream: 'stderr', text: `${note}\n` });
        await channel.drained();
      };
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
      const target = new HostShellTarget(scope.root, { realm: planned.realm, timeoutMs: input.config.timeoutMs, extraEnv: input.config.environment, signal, onOutput,
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
        await showCleanup(ran);
        // Astra 2124 durable marker: the same verified cleanup carried in the note also rides the outcome, for `tool.finished`.
        return { status: ran.exitCode === 0 ? 'ok' : 'error', text: describeResult(planned.command, ran, planned.realm.notice), cleanup: ran.cleanup };
      } catch (error) {
        const code = error instanceof EffectError ? error.code : (error as { code?: unknown })?.code;
        await channel.drained();
        const ran = result as HostShellResult | null;
        if (ran) await showCleanup(ran);
        if (ran && ran.status !== 'exited') {
          return { status: 'error', text: `${describeResult(planned.command, ran, planned.realm.notice)}\n[deckent] the command was stopped; what it changed before that is unknown.`, cleanup: ran.cleanup };
        }
        const why = code === 'POLICY_DENIED' ? `denied by policy (operation ${HOST_SHELL_RUN_OPERATION.operation.id})`
          : code === 'EFFECT_APPROVAL_REQUIRED' ? 'the command needs an approval that was not given'
          : code === 'EFFECT_REJECTED' ? 'the command could not start'
          : typeof code === 'string' && code.startsWith('APPROVAL_') ? `the approval for this call could not be verified (${code}); nothing was run`
          : typeof code === 'string' ? code : 'failed';
        return { status: 'error', text: `[deckent] run_shell: error=${why}` };
      } finally { store.close(); }
    },
  };
}
