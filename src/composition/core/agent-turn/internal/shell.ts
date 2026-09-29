import { relative, resolve, sep } from 'node:path';
import { EffectError, type AgentToolOutcome, type EffectCommand } from '#domain/index.js';
import { EffectApplication, OperationPolicyAuthorization, agentToolArgumentsDigest, boundApprovalPreview, classifyReadOnlyShellCommand, classifyShellContainment, classifyShellMutation,
  classifyShellRisk, shellPermissionTier, type EffectApprovalGate, type ShellPermissionTier, type ShellRiskClassification } from '#engine/index.js';
import { globalStateRoot, SystemTrustedClock } from '#platform/index.js';
import { agentShellEffectCommandId, createGlobMatcher, createLocalPeerSession, createShellPathContext, createShellProtectedNames, createShellWriteContext, describeHostShellResult,
  describeShellEffectRefusal, hostShellCleanupNote, HOST_SHELL_COMMAND_MAX_CHARS, HOST_SHELL_RUN_OPERATION, HOST_SHELL_TARGET_KIND, HostShellTarget, HOST_SHELL_NOTES, resolveShellRealm,
  describeSandboxWriteSet, prepareSandboxWriteSetDirectory, removeSandboxWriteSetDirectory, type SandboxWriteDecider, sandboxWriteView, shellSandboxCapabilities, shellWritePosture,
  type ShellCallAuthority, type ShellRealmResolution, openSqliteAttemptStore, type HostShellResult, type LocalPeerIdentity, type ShellSandbox,
  type RuntimeServiceTurnChannel, type TerminalShellConfig, type WorkspaceScope } from '#adapters/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import { settleSandboxWriteSet } from './sandbox-writes.js';

type ShellPlan = { readonly ok: true; readonly command: string; readonly risk: ShellRiskClassification; readonly tier: ShellPermissionTier; readonly realm: Extract<ShellRealmResolution, { ok: true }>;
  readonly contained: boolean }
  | { readonly ok: false; readonly text: string };

/**
 * The agent's host shell in one turn (T-L4 slice 3c, Jev 82858581). A command is classified into a permission tier: only a
 * read-only command of bounded reach (risk `none`: explicit, checked paths) runs without asking under allow; traversal and
 * repository-object reads (`low`), the destructive table, the always-ask floor and any other modification ask in every mode; the
 * narrow mutating set asks unless the turn's decision lowers a company-eligible require-approval in full-auto (slice 4a). Every run is a C11 effect of Core `host.shell.run` on the `host-shell`
 * target — session, operation policy, intent before spawn, an uncertain run reported as such and never repeated. Streamed output
 * goes to the turn only while the channel has room; beyond that it is skipped with one visible marker (the result is unaffected).
 */
export function createAgentShell(input: { readonly scope: WorkspaceScope; readonly peer: LocalPeerIdentity; readonly config: TerminalShellConfig;
  readonly context: Awaited<ReturnType<typeof loadPeerInvocationContext>>; readonly scopeId: string; readonly turnId: string; readonly channel: RuntimeServiceTurnChannel;
  /** SCR-A: the conversation's scratch area — the command's `TMPDIR`, and a second root its path checks accept. */
  readonly scratch: { readonly scope: WorkspaceScope; readonly dir: string } | null;
  /** S9: sandbox providers in preference order; the realm is resolved per call against the service's host measurement. */
  readonly sandboxes: readonly ShellSandbox[];
  /** Astra 2162 (owner F2): deny patterns of the product's own state — a command that names one is refused, never offered for approval. */
  readonly productState: readonly string[];
  /** MODES-3: the turn was launched in full access (its sandbox layout: the configuration file as the floor, `.git` writable). */
  readonly fullAccess?: boolean;
  /** SHELL-OVERLAY: the installation's configuration file inside the project (a write-set entry there is `edit-authority`). */
  readonly authority?: (rel: string) => boolean;
  /** SHELL-OVERLAY: where this turn's write-set directories live (outside the project), or null when nowhere can (no write sets). */
  readonly writeSetRoot?: () => Promise<string | null> }) {
  const { scope, context, scopeId, turnId, channel } = input, roots = input.scratch ? [input.scratch.scope] : [];
  const productState = input.productState.map(createGlobMatcher), protectedNames = createShellProtectedNames(scope.root, productState);
  const namesProductState = (detail: string | undefined) => detail !== undefined
    && productState.some(match => match(relative(scope.root, resolve(scope.root, detail)).split(sep).join('/')));
  const plans = new Map<string, ShellPlan>();
  const key = (tool: string, args: Record<string, unknown>) => agentToolArgumentsDigest(tool, args);
  const plan = async (tool: string, args: Record<string, unknown>): Promise<ShellPlan> => {
    const command = typeof args['command'] === 'string' ? args['command'] : '';
    if (command.trim() === '') return { ok: false, text: '[deckent] run_shell: error=empty-command' };
    if (command.length > HOST_SHELL_COMMAND_MAX_CHARS) return { ok: false, text: `[deckent] run_shell: error=command-too-long (max ${HOST_SHELL_COMMAND_MAX_CHARS} characters)` };
    const realm = resolveShellRealm(input.config.realm, await shellSandboxCapabilities(globalStateRoot()), input.sandboxes);
    if (!realm.ok) return { ok: false, text: `[deckent] run_shell: error=${realm.code}; nothing was run` };
    const paths = createShellPathContext(scope, undefined, roots);
    const readOnly = await classifyReadOnlyShellCommand(command, paths);
    const risk = classifyShellRisk(command, readOnly);
    // The narrow mutating tier is asked only for a command that is neither read-only nor destructive (it never demotes either).
    const mutation = readOnly.readOnly || risk.risk === 'destructive' ? { tier: 'unrecognized' as const, reasonCode: 'NOT_NARROW' as const }
      : await classifyShellMutation(command, paths, createShellWriteContext(scope, roots));
    // A protected path that is the product's own state is a hard floor: refused here, never turned into a risk tier for approval.
    for (const verdict of [readOnly, mutation]) {
      if (verdict.reasonCode === 'PATH_PROTECTED' && namesProductState(verdict.detail)) return { ok: false, text: `[deckent] run_shell: error=PRODUCT_STATE_PROTECTED (${verdict.detail}); Deckent's own state is not opened by any approval; nothing was run` };
    }
    const planned: ShellPlan = { ok: true, realm, command, risk, tier: shellPermissionTier(risk, readOnly, mutation), contained: classifyShellContainment(command, protectedNames).contained };
    plans.set(key(tool, args), planned);
    return planned;
  };
  return {
    plan,
    /** The planned command's permission tier (the mode decision's cell), or null when it was not planned. */
    tier(tool: string, args: Record<string, unknown>): ShellPermissionTier | null { const planned = plans.get(key(tool, args)); return planned?.ok ? planned.tier : null; },
    /** SHELL-AUTONOMY: the planned realm's containment and whether the command is contained (the decision's `shell` input). */
    containment(tool: string, args: Record<string, unknown>) { const planned = plans.get(key(tool, args)); return planned?.ok ? { realm: planned.realm.containment, contained: planned.contained } : undefined; },
    /**
     * The approval card: the exact command, its risk and why, and what running it means. A card is requested only when the decision
     * needed one (`createAgentCallDecisions.authorize`, `require-approval`), and `.execute` then always runs that call as
     * `owner-approved` (mode.ts) — never `full-access` or the unattended read-only posture, whatever the turn — so the text uses the
     * same authority the effect will use; only `.git` still depends on the turn (MODES-3).
     */
    preview(tool: string, args: Record<string, unknown>): string | undefined {
      const planned = plans.get(key(tool, args));
      if (!planned?.ok) return undefined;
      const write = shellWritePosture('owner-approved', planned.tier, input.fullAccess === true);
      const view = sandboxWriteView({ repositoryWritable: input.fullAccess === true }, write);
      return boundApprovalPreview(`$ ${planned.command}\nrisk: ${planned.risk.risk} (${planned.risk.reason})\n${planned.realm.posture(view)}`);
    },
    /** Runs the call as a C11 effect; `gate` is the caller's durable-record approval gate for exactly this call (C12 G3). */
    async apply(tool: string, args: Record<string, unknown>, signal: AbortSignal, callId: string,
      execution: { readonly round: number; readonly index: number }, gate: EffectApprovalGate, authority: ShellCallAuthority = 'unattended',
      writes?: SandboxWriteDecider): Promise<AgentToolOutcome> {
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
        const note = hostShellCleanupNote(ran.cleanup);
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
      // The call's write posture in a sandbox realm, derived once (`shellWritePosture`); the host realm has no such boundary.
      const posture = shellWritePosture(authority, planned.tier, input.fullAccess === true, planned.realm.writeSets === true && writes !== undefined);
      // SHELL-OVERLAY: the write set's private directory; where none can be made, the call keeps the read-only posture (said in the result).
      const root = posture.writeSet ? await input.writeSetRoot?.() ?? null : null;
      const directory = root ? await prepareSandboxWriteSetDirectory(root, commandId.slice(0, 32)) : null;
      const { writeFloorReadOnly } = posture, projectReadOnly = posture.projectReadOnly || (posture.writeSet && !directory);
      const unavailable = posture.writeSet && !directory ? `\n${HOST_SHELL_NOTES.writeSetUnavailable}` : '';
      const target = new HostShellTarget(scope.root, { realm: planned.realm, timeoutMs: input.config.timeoutMs, extraEnv: input.config.environment, signal, onOutput, writeFloorReadOnly, projectReadOnly,
        ...(directory ? { writeSet: { upper: directory.upper, work: directory.work } } : {}),
        ...(input.scratch ? { fixedEnv: { TMPDIR: input.scratch.dir } } : {}), onResult: value => { result = value; } });
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
        const note = projectReadOnly && ran.exitCode !== 0 && planned.realm.containment !== 'host' ? `\n${HOST_SHELL_NOTES.projectReadOnly}` : '';
        // SHELL-OVERLAY: the command exited (whatever its code: a direct-write posture keeps its writes too), so its write set is decided
        // and applied now, entry by entry, like edits; the directory is removed afterwards.
        const settled = directory && writes ? describeSandboxWriteSet(await settleSandboxWriteSet({ directory, scope, decider: writes, authority: input.authority ?? (() => false),
          context, peer: input.peer, scopeId, shellCommandId: commandId, signal })) : '';
        return { status: ran.exitCode === 0 ? 'ok' : 'error', text: `${describeHostShellResult(planned.command, ran, planned.realm)}${note}${unavailable}${settled ? `\n${settled}` : ''}`,
          cleanup: ran.cleanup };
      } catch (error) {
        const code = error instanceof EffectError ? error.code : (error as { code?: unknown })?.code;
        await channel.drained();
        const ran = result as HostShellResult | null;
        if (ran) await showCleanup(ran);
        // A run that did not finish (stopped, timed out, not started) leaves nothing to apply: its write set is discarded.
        const discarded = directory && ran && ran.status !== 'spawn-failed' ? `\n${HOST_SHELL_NOTES.writeSetDiscarded}` : '';
        if (ran && ran.status !== 'exited') {
          // A realm that could not start the command (e.g. its sandbox could not be set up) says why; nothing ran, so nothing is unknown.
          return { status: 'error', text: `${describeHostShellResult(planned.command, ran, planned.realm)}${ran.status === 'spawn-failed' ? ''
            : discarded || `\n${HOST_SHELL_NOTES.stoppedUnknown}`}`, cleanup: ran.cleanup };
        }
        return { status: 'error', text: describeShellEffectRefusal(code) };
      } finally {
        store.close();
        if (directory) await removeSandboxWriteSetDirectory(directory.dir);
      }
    },
  };
}
