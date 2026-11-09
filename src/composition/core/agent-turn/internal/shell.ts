import { relative, resolve, sep } from 'node:path';
import { PRINCIPAL_EFFECT_PRODUCER, type ModelInvocationProfile, EffectError, type AgentToolOutcome, type EffectCommand } from '#domain/index.js';
import { EffectApplication, OperationPolicyAuthorization, SessionAuthenticationError, type SessionVerifier, type SessionAuthority, agentToolArgumentsDigest, type AgentTurnShellPosture, boundApprovalPreview, classifyReadOnlyShellCommand, classifyShellContainment, classifyShellMutation,
  classifyShellAuthority, classifyShellRisk, scanShellCommand, shellNamedPaths, shellPermissionTier, type EffectApprovalGate, type ShellPermissionTier, type ShellRiskClassification, isolatesAsSubscription } from '#engine/index.js';
import { globalStateRoot, loadConfig, SystemTrustedClock, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { agentGlobalStateRoots, agentLoginIdentityPaths, createShellGlobalStateCheck, hostGlobalStateUnresolved, agentShellEffectCommandId, createGlobMatcher, createLocalPeerSession, createShellPathContext, createShellProtectedNames, createShellWriteContext, describeHostShellResult,
  describeShellEffectRefusal, hostShellCleanupNote, HOST_SHELL_COMMAND_MAX_CHARS, HOST_SHELL_RUN_OPERATION, HOST_SHELL_TARGET_KIND, HostShellTarget, HOST_SHELL_NOTES, resolveShellRealm,
  describeSandboxWriteSetResult, openShellRealm, prepareSandboxWriteSetDirectory, removeSandboxWriteSetDirectory, type SandboxWriteDecider, sandboxWriteView, shellPostureFacts, shellSandboxCapabilities, shellWritePosture,
  type ShellCallAuthority, type ShellRealmResolution, openSqliteAttemptStore, type HostShellResult, type LocalPeerIdentity, type ShellSandbox,
  type RuntimeServiceTurnChannel, type TerminalShellConfig, type WorkspaceScope, inspectAgentShellRealm, readTerminalShellConfig, sandboxNotStartedNote,
  compareTrackedFiles, describeTrackedFilesChange, describeTrackedFilesUnchecked, snapshotTrackedFiles, type TrackedFilesChange, protectedPathShellNote, onWriteFloor } from '#adapters/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import { settleSandboxWriteSet } from './sandbox-writes.js';

/** REALM-NOTICE (doctor): the realm a shell call here gets (configured mode, the service's state root and providers, measured read-only) and its self-test. */
export async function inspectConfiguredShellRealm(projectRoot: string, options: ConfigLoadOptions) {
  const config = await loadConfig(projectRoot, { ...options, heal: false }), env = options.env ?? process.env, mode = readTerminalShellConfig(config as unknown as Record<string, unknown>).realm;
  return inspectAgentShellRealm({ mode, stateDir: globalStateRoot(env), projectRoot, layout: config.productLayout, env });
}
type ShellPlan = { readonly ok: true; readonly command: string; readonly risk: ShellRiskClassification; readonly tier: ShellPermissionTier; readonly realm: Extract<ShellRealmResolution, { ok: true }>;
  readonly contained: boolean; readonly warning: string | null }
  | { readonly ok: false; readonly text: string };

/** Permission-tiered, C11-governed shell calls: policy and intent precede spawn; uncertain effects are never repeated. */
export function createAgentShell(input: { readonly scope: WorkspaceScope; readonly peer?: LocalPeerIdentity; readonly sessions?: () => Promise<SessionVerifier & SessionAuthority>; readonly config: TerminalShellConfig;
  readonly context: Awaited<ReturnType<typeof loadPeerInvocationContext>>; readonly scopeId: string; readonly turnId: string; readonly channel: RuntimeServiceTurnChannel;
  /** SCR-A: the conversation's scratch area — the command's `TMPDIR`, and a second root its path checks accept. */
  readonly scratch: { readonly scope: WorkspaceScope; readonly dir: string } | null;
  /** S9: sandbox providers in preference order; the realm is resolved per call against the service's host measurement. */
  readonly sandboxes: readonly ShellSandbox[];
  /** Astra 2162 (owner F2): deny patterns of the product's own state — a command that names one is refused, never offered for approval. */
  readonly productState: readonly string[];
  /** K15: installation-global roots, including process and configuration environments, even outside the workspace. */
  readonly globalStateRoots?: readonly string[];
  /** Trusted selected profile: a subscription never executes shell on the host, including prefer-sandbox fallback. */
  readonly profile?: ModelInvocationProfile;
  /** MODES-3: the turn was launched in full access (its sandbox layout: the configuration file as the floor, `.git` writable). */
  readonly fullAccess?: boolean;
  /** SHELL-OVERLAY: the installation's configuration file inside the project (a write-set entry there is `edit-authority`). */
  readonly authority?: (rel: string) => boolean; readonly selfSource?: boolean; readonly writeFloor?: (rel: string) => boolean; readonly sealed?: (rel: string) => boolean;
  /** SHELL-OVERLAY: where this turn's write-set directories live (outside the project), or null when nowhere can (no write sets). */
  readonly writeSetRoot?: () => Promise<string | null>;
  /** The person's locale (the turn's reply language): the language of the notes a result explains itself with (B3). */
  readonly language?: Locale; /** R9: a Run worker's shell (the read-only classifier owns `safe-read`). */ readonly worker?: true }) {
  const { scope, context, scopeId, turnId, channel } = input, roots = input.scratch ? [input.scratch.scope] : [];
  const productState = input.productState.map(createGlobMatcher), protectedNames = createShellProtectedNames(scope.root, productState), floorNames = createShellProtectedNames(scope.root, [], input.writeFloor ?? (() => false));
  const namesProductState = (detail: string | undefined) => detail !== undefined
    && productState.some(match => match(relative(scope.root, resolve(scope.root, detail)).split(sep).join('/')));
  const globalRoots = input.globalStateRoots ?? agentGlobalStateRoots([process.env]);
  const globalState = createShellGlobalStateCheck(scope.root, globalRoots, process.env, agentLoginIdentityPaths(globalRoots));
  const subscription = input.profile && isolatesAsSubscription(input.profile);
  const plans = new Map<string, ShellPlan>();
  const key = (tool: string, args: Record<string, unknown>) => agentToolArgumentsDigest(tool, args);
  /** The realm a call of this turn resolves: the configured mode against the service's (memoized) host measurement and the turn's providers. */
  const resolveRealm = async () => resolveShellRealm(input.config.realm, await shellSandboxCapabilities(globalStateRoot()), input.sandboxes);
  /** OPEN-SANDBOX: the realm a call runs in — an open write posture on a realm that cannot open refuses (`openShellRealm`). One rule
   * for the card, the effect and the prompt's posture. */
  const callRealm = (realm: Extract<ShellRealmResolution, { ok: true }>, open: boolean) => open ? openShellRealm(realm, input.config.realm) : realm;
  /** The approval card's view of a planned call: `.execute` runs a carded call as `owner-approved` (mode.ts), so the card uses that authority;
   * only `.git` depends on the turn (MODES-3). OPEN-SANDBOX: the realm the call will actually run in. */
  const cardView = (tool: string, args: Record<string, unknown>) => {
    const planned = plans.get(key(tool, args));
    if (!planned?.ok) return null;
    const write = shellWritePosture('owner-approved', planned.tier, input.fullAccess === true, planned.tier === 'destructive' && planned.realm.writeSets === true);
    const realm = callRealm(planned.realm, write.open);
    return realm.ok ? { planned, view: sandboxWriteView({ repositoryWritable: input.fullAccess === true }, write), realm } : null;
  };
  const previewText = (tool: string, args: Record<string, unknown>, posture = true): string | undefined => { // R7a: `posture: false` where the card words `postureFacts` itself; an open (full-access) view keeps its HOME/network sentence the facts lack
    const card = cardView(tool, args);
    return card ? `${card.planned.warning ? `${card.planned.warning}\n` : ''}$ ${card.planned.command}\nrisk: ${card.planned.risk.risk} (${card.planned.risk.reason})${posture || card.view.open === true ? `\n${card.realm.posture(card.view)}` : ''}` : undefined;
  };
  const plan = async (tool: string, args: Record<string, unknown>): Promise<ShellPlan> => {
    const command = typeof args['command'] === 'string' ? args['command'] : '';
    if (command.trim() === '') return { ok: false, text: '[deckent] run_shell: error=empty-command' };
    if (command.length > HOST_SHELL_COMMAND_MAX_CHARS) return { ok: false, text: `[deckent] run_shell: error=command-too-long (max ${HOST_SHELL_COMMAND_MAX_CHARS} characters)` };
    const scan = scanShellCommand(command);
    const globalName = await globalState;
    for (const name of shellNamedPaths(command, () => true, scan).flatMap(word => word.split(/[<>]/u))) {
      if (await globalName(name)) return { ok: false, text: `[deckent] run_shell: error=PRODUCT_STATE_PROTECTED; ${t('agent.shell.productStateProtected', {}, input.language)}` };
    }
    const realm = await resolveRealm();
    if (!realm.ok) return { ok: false, text: `[deckent] run_shell: error=${realm.code}; nothing was run` };
    if (subscription && realm.containment === 'host') return { ok: false, text: `[deckent] run_shell: error=SUBSCRIPTION_HOST_SHELL_REFUSED; ${t('agent.shell.subscriptionHostRefused', {}, input.language)}` };
    const warning = realm.containment === 'host' && await hostGlobalStateUnresolved(command, globalRoots, scan) ? t('headless.agent.host.chatWarning', {}, input.language) : null;
    if (input.fullAccess === true && !callRealm(realm, true).ok) return { ok: false, text: `[deckent] run_shell: error=SHELL_SANDBOX_UNAVAILABLE; ${t('agent.shell.fullAccessUnavailable', {}, input.language)}` };
    const paths = createShellPathContext(scope, undefined, roots);
    const readOnly = await classifyReadOnlyShellCommand(command, paths, 'posix', scan);
    const risk = classifyShellRisk(command, readOnly, input.worker === true, scan);
    // The narrow mutating tier is asked only for a command that is neither read-only nor destructive (it never demotes either).
    const mutation = readOnly.readOnly || risk.risk === 'destructive' ? { tier: 'unrecognized' as const, reasonCode: 'NOT_NARROW' as const }
      : await classifyShellMutation(command, paths, createShellWriteContext(scope, roots, input.writeFloor), 'posix', scan);
    // A protected path that is the product's own state is a hard floor: refused here, never turned into a risk tier for approval.
    for (const verdict of [readOnly, mutation]) {
      if (verdict.reasonCode === 'PATH_PROTECTED' && namesProductState(verdict.detail)) return { ok: false, text: `[deckent] run_shell: error=PRODUCT_STATE_PROTECTED (${verdict.detail}); Deckent's own state is not opened by any approval; nothing was run` };
    }
    const tier = shellPermissionTier(risk, readOnly, mutation, classifyShellAuthority(command, scan));
    const planned: ShellPlan = { ok: true, realm, command, risk, warning, tier: warning !== null && tier !== 'destructive' && tier !== 'authority' ? 'always-ask' : tier, contained: classifyShellContainment(command, protectedNames, 'posix', input.fullAccess !== true && realm.containment === 'sandbox' ? path => floorNames(path) && !namesProductState(path) : undefined, scan).contained };
    plans.set(key(tool, args), planned);
    return planned;
  };
  return {
    plan,
    /** Prompt posture uses the call's realm/open-view resolution; unavailable open views and subscription host execution refuse. */
    async posture(): Promise<AgentTurnShellPosture> {
      const resolved = await resolveRealm();
      if (!resolved.ok || (subscription && resolved.containment === 'host')) return { kind: 'unavailable' };
      const fullAccess = input.fullAccess === true, approved = shellWritePosture('owner-approved', 'other-modify', fullAccess);
      const open = shellWritePosture(fullAccess ? 'full-access' : 'owner-approved', 'other-modify', fullAccess).open;
      const realm = callRealm(resolved, open);
      if (!realm.ok) return { kind: 'unavailable' };
      if (realm.containment === 'host' || realm.realm.kind === 'host') return { kind: 'host' };
      return open && realm.opens === true ? { kind: 'sandbox', realm: realm.realm.kind, open: true, configuration: approved.writeFloorReadOnly ? 'read-only' : 'owner-approved' }
        : { kind: 'sandbox', realm: realm.realm.kind, open: false };
    },
    tier(tool: string, args: Record<string, unknown>): ShellPermissionTier | null { const planned = plans.get(key(tool, args)); return planned?.ok ? planned.tier : null; },
    /** SHELL-AUTONOMY: the planned realm's containment and whether the command is contained (the decision's `shell` input). */
    containment(tool: string, args: Record<string, unknown>) { const planned = plans.get(key(tool, args)); return planned?.ok ? { realm: planned.realm.containment, contained: planned.contained } : undefined; },
    /**
     * The approval card: the exact command, its risk and why, and what running it means. A card is requested only when the decision
     * needed one (`createAgentCallDecisions.authorize`, `require-approval`), and `.execute` then always runs that call as
     * `owner-approved` (mode.ts) — never `full-access` or the unattended read-only posture, whatever the turn — so the text uses the
     * same authority the effect will use; only `.git` still depends on the turn (MODES-3).
     */
    preview(tool: string, args: Record<string, unknown>): string | undefined { const text = previewText(tool, args); return text === undefined ? undefined : boundApprovalPreview(text); },
    /** The card's preview text before the preview bound (the turn bounds it once and keeps the cut's facts). */
    previewText,
    /** Astra 2431: the card's fields as data — the whole command (never cut) and the classifier's tier and reason. */
    cardCall(tool: string, args: Record<string, unknown>): { readonly kind: 'shell'; readonly command: string; readonly tier: string; readonly reason: string } | undefined {
      const planned = plans.get(key(tool, args));
      return planned?.ok ? { kind: 'shell', command: planned.command, tier: planned.risk.risk, reason: [planned.warning, planned.risk.reason].filter(Boolean).join('\n') } : undefined;
    },
    /** POSTURE (T2-FOLLOWUP): the same card's realm and write view as structured facts (the surface words them); null when not planned. */
    postureFacts(tool: string, args: Record<string, unknown>) { const card = cardView(tool, args); return card ? shellPostureFacts(card.realm, card.view) : null; },
    /** Runs the call as a C11 effect; `gate` is the caller's durable-record approval gate for exactly this call (C12 G3). */
    async apply(tool: string, args: Record<string, unknown>, signal: AbortSignal, callId: string,
      execution: { readonly round: number; readonly index: number }, gate: EffectApprovalGate, authority: ShellCallAuthority = 'unattended',
      writes?: SandboxWriteDecider, track?: (change: TrackedFilesChange) => Promise<boolean>): Promise<AgentToolOutcome> {
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
      const sessions = await (input.sessions ? input.sessions() : input.peer ? createLocalPeerSession(input.peer, context.principal.scopeIds, context.config.approvals.sessionTtlMs, clock) : Promise.reject(new SessionAuthenticationError('SESSION_REQUIRED')));
      // The call's write posture in a sandbox realm, derived once (`shellWritePosture`); the host realm has no such boundary.
      const posture = shellWritePosture(authority, planned.tier, input.fullAccess === true, planned.realm.writeSets === true && writes !== undefined);
      // Full access requires an enforcing open sandbox, before any effect target or write-set directory exists.
      const realm = callRealm(planned.realm, posture.open);
      if (!realm.ok) return { status: 'error' as const, text: `[deckent] run_shell: error=${realm.code}; nothing was run` };
      // SHELL-OVERLAY: the write set's private directory (none → read-only posture, said in the result); every exit after it removes it (Astra 2557).
      const root = posture.writeSet ? await input.writeSetRoot?.() ?? null : null;
      const directory = root ? await prepareSandboxWriteSetDirectory(root, commandId.slice(0, 32), input.config.clockStepToleranceMs) : null;
      const { writeFloorReadOnly } = posture, projectReadOnly = posture.projectReadOnly || (posture.writeSet && !directory);
      const unavailable = posture.writeSet && !directory ? `\n${HOST_SHELL_NOTES.writeSetUnavailable}` : '';
      const open = posture.open && realm.opens === true;
      const target = new HostShellTarget(scope.root, { realm, ...(open ? { open: true } : {}), timeoutMs: input.config.timeoutMs, extraEnv: input.config.environment, signal, onOutput, writeFloorReadOnly, projectReadOnly,
        ...(directory ? { writeSet: { upper: directory.upper, work: directory.work } } : {}),
        ...(input.scratch ? { fixedEnv: { TMPDIR: input.scratch.dir } } : {}), onResult: value => { result = value; } });
      // FA-TRACKED-WARN (owner 2026-09-30): a full-access call's effect on git-tracked files is measured around it — shown, told to the model, audited through `track` (the sealed `tracked-files-changed` event), never blocked.
      const baseline = authority === 'full-access' ? await snapshotTrackedFiles(scope.root) : null;
      // The counts lead the result's first line (`describeHostShellResult`); protocol v18 has no typed field for them (v19 hook, docs-delta).
      const tracked = async (ran: HostShellResult | null): Promise<{ readonly text: string; readonly counts?: { readonly deleted: number; readonly overwritten: number } }> => {
        if (!baseline || !ran || ran.status === 'spawn-failed') return { text: '' };
        const change = baseline.kind === 'measured' ? await compareTrackedFiles(baseline) : null;
        const line = change ? describeTrackedFilesChange(change, await track?.(change) === true) : describeTrackedFilesUnchecked(baseline);
        if (!line) return { text: '' };
        channel.emit({ kind: 'tool.output', callId, stream: 'stderr', text: `${line}\n` });
        await channel.drained();
        return { text: `\n${line}`, ...(change ? { counts: { deleted: change.deleted.count, overwritten: change.overwritten.count } } : {}) };
      };
      const store = await (async () => openSqliteAttemptStore(await context.path(), context.config.storage.sqlite, { now: Date.now, timeoutMs: context.config.runRuntime.parking.timeoutMs }, 'forbid'))()
        .catch(async (error: unknown) => { if (directory) await removeSandboxWriteSetDirectory(directory.dir); throw error; });
      try {
        await new EffectApplication({ async resolve(ref) {
          return ref.id === HOST_SHELL_RUN_OPERATION.operation.id && ref.version === HOST_SHELL_RUN_OPERATION.operation.version ? HOST_SHELL_RUN_OPERATION : null;
        } }, { resolve: kind => kind === HOST_SHELL_TARGET_KIND ? target : null }, store, gate, sessions,
        new OperationPolicyAuthorization(context.policy), clock, { producer: PRINCIPAL_EFFECT_PRODUCER }).execute(command);
        // The streamed display must be delivered before the result joins it on the channel.
        await channel.drained();
        const ran = result as HostShellResult | null;
        if (!ran) return { status: 'error', text: '[deckent] run_shell: error=no-result' };
        await showCleanup(ran);
        const { text: trackedLine, counts } = await tracked(ran);
        // Astra 2124 durable marker: the same verified cleanup carried in the note also rides the outcome, for `tool.finished`.
        const note = projectReadOnly && ran.exitCode !== 0 && realm.containment !== 'host' ? `\n${HOST_SHELL_NOTES.projectReadOnly}` : '';
        // B3: the write floor was read-only in this sandbox; a failure on a path it protects is explained by name. The read-only error in the
        // output is the evidence, whatever the exit code (`rm src/x || echo failed` exits 0). Not in a full-access turn: its sandbox keeps
        // only the configuration file read-only, which is not the floor `writeFloor` names there.
        const floorNote = input.fullAccess !== true && writeFloorReadOnly && realm.containment !== 'host' && input.writeFloor
          ? protectedPathShellNote(planned.command, ran.output, onWriteFloor(scope.root, input.writeFloor), input.language) : null;
        // SHELL-OVERLAY: the command exited (whatever its code: a direct-write posture keeps its writes too), so its write set is decided
        // and applied now, entry by entry, like edits; the directory is removed afterwards.
        const settled = directory && writes ? describeSandboxWriteSetResult(await settleSandboxWriteSet({ directory, scope, decider: writes, authority: input.authority ?? (() => false), selfSource: input.selfSource === true, ...(input.sealed ? { sealed: input.sealed } : {}),
          context, ...(input.peer ? { peer: input.peer } : {}), ...(input.sessions ? { sessions: input.sessions } : {}), scopeId, shellCommandId: commandId, signal }), input.language) : '';
        return { status: ran.exitCode === 0 ? 'ok' : 'error', text: `${describeHostShellResult(planned.command, ran, realm, counts)}${note}${floorNote ? `\n${floorNote}` : ''}${unavailable}${settled ? `\n${settled}` : ''}${trackedLine}`,
          cleanup: ran.cleanup };
      } catch (error) {
        const code = error instanceof EffectError ? error.code : (error as { code?: unknown })?.code;
        await channel.drained();
        const ran = result as HostShellResult | null;
        if (ran) await showCleanup(ran);
        if (ran?.status === 'spawn-failed' && realm.containment !== 'host') {
          channel.emit({ kind: 'tool.output', callId, stream: 'stderr', text: `${sandboxNotStartedNote(ran.output, input.language)}\n` }); await channel.drained();
        }
        const { text: trackedLine, counts } = await tracked(ran);
        // A run that did not finish (stopped, timed out, not started) leaves nothing to apply: its write set is discarded.
        const discarded = directory && ran && ran.status !== 'spawn-failed' ? `\n${HOST_SHELL_NOTES.writeSetDiscarded}` : '';
        if (ran && ran.status !== 'exited') {
          // A realm that could not start the command (e.g. its sandbox could not be set up) says why; nothing ran, so nothing is unknown.
          return { status: 'error', text: `${describeHostShellResult(planned.command, ran, realm, counts)}${ran.status === 'spawn-failed' ? ''
            : discarded || `\n${HOST_SHELL_NOTES.stoppedUnknown}`}${trackedLine}`, cleanup: ran.cleanup };
        }
        return { status: 'error', text: `${describeShellEffectRefusal(code)}${trackedLine}` };
      } finally {
        store.close();
        if (directory) await removeSandboxWriteSetDirectory(directory.dir);
      }
    },
  };
}
