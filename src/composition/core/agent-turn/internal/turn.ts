import { canonicalTurnRequest as canonical, withMcpNotices, chatTurnRoundFailureState } from '#engine/index.js';
export { withMcpNotices, chatTurnRoundFailureState } from '#engine/index.js';
import { createHash, randomUUID } from 'node:crypto';
import { chatTurnCancellationSchema, chatTurnCommandSchema, modelInvocationProfileSchema, type AgentToolApprovalSettlement, type AgentToolSpec, type AgentTurnMessage,
  type AgentTurnStreamEvent, type ChatTurnCancellationResult, type ChatTurnResult, type JsonObject, type ModelInvocationCommand } from '#domain/index.js';
import { SessionStanding, SessionApprovalAnswers, agentCallPermissionMode, agentToolApprovalSummary, agentCompactionInstruction, AGENT_TURN_ANSWER_MAX_BYTES, APPROVAL_PREVIEW_MAX_BYTES, AgentToolPolicyAuthorization, AgentTurnStoreError, admitFullAccessTurn,
  agentCompactionTranscript, agentToolApprovalFacts, agentTurnAdmission, awaitAgentToolApproval, boundApprovalPreview, createTurnDecisionCapabilities, parseAgentCompactionSummary,
  renderAgentTurnSystemPrompt, requestAgentToolApproval, runDurableAgentTurn, withAgentTurnSystemPrompt, type AgentRoundOutcome, type AgentTurnPorts, type TurnDecisionCapabilities,
  type ModelInvocationDelivery } from '#engine/index.js';
import { t, globalStateRoot, ErrorRegistry, loadConfig, prepareProductDirectory, resolveLocale, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { agentTurnWriteFloor, isSelfSourceProject, agentAuthorityPaths, agentProductStateDeny, agentShellHardFloor, agentWorkspaceDeny, createWorkspaceReadTools, WORKSPACE_EDIT_TOOL_SPECS, openLocalIntegrityAuthority, openSqliteApprovalStore, openSqliteAgentTurnStore, OPENAI_CHAT_COMPLETIONS_FAMILY, ANTHROPIC_MESSAGES_FAMILY,
  OPENAI_CHAT_ENABLE_THINKING_CAPABILITY, OPENAI_CHAT_TOOL_CALLS_CAPABILITY, openScratchSession, projectEditArea, readTerminalChatConfig, readTerminalScratchConfig,
  readTerminalFetchConfig, FETCH_URL_TOOL_SPEC, SYSTEM_FETCH_TRANSPORT, readTerminalShellConfig, shellSandboxCapabilities, RUN_SHELL_TOOL_SPEC, SCRATCH_TOOL_SPECS, scratchSessionKey, registerProviderConfig, createScratchActivity,
  isWriteApprovalFloored, isSelfSourceWriteFloored, shippedShellSandboxes, McpClientPool, type HttpFetchTransport, type LocalPeerIdentity,
  sandboxWriteSetRoot, dropFullPreview, keepFullPreview, type RuntimeServiceTurnChannel, type ScratchActivity, type ShellSandboxFactory, type WorkspaceEditArea } from '#adapters/index.js';
import { createAgentShell } from './shell.js';
import { createAgentFetch } from './fetch.js';
import { createAgentMcp } from './mcp.js';
import { createAgentCallApprovals, describeAgentCall } from './call-approvals.js';
import { invokePeerConfiguredModel, loadPeerInvocationContext, measurePeerConfiguredModel, type RuntimeModelInvocationHost } from '#composition/core/model-invocation/index.js';
import { inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { createAgentFileEdits } from './edits.js';
import { createAgentCallDecisions, withAgentAudit } from './mode.js';
import { extractOpenAiChatTextFromInvocation, openAiChatMessageFromInvocation, openAiChatNativeMessages, openAiChatPromptUpperBound,
  openAiChatUsageFromInvocation } from '#adapters/index.js';

/** Service-owned state of running turns: cancellation by the starting principal, service stop, the scratch custody (areas they hold are never
 * swept), and how `fetch_url` reaches the network (the system transport; only an in-process test passes another). */
export interface RuntimeChatTurnHost {
  readonly model: RuntimeModelInvocationHost;
  readonly signal: AbortSignal;
  readonly running: Map<string, { readonly principalKey: string; readonly controller: AbortController }>;
  readonly scratch: ScratchActivity;
  readonly fetchTransport: HttpFetchTransport;
  /** S9/S11: the sandbox providers a shell call may pick, in preference order (bubblewrap, then Landlock); only an in-process test passes another list. */
  readonly shellSandboxes: ShellSandboxFactory;
  /** MCP-CLIENT: the owner's local MCP servers, started by the turns that need them and closed with the service. */
  readonly mcp: McpClientPool;
  /** B1: one-time decision capabilities of the running turns' cards (service memory; every decision of this service reads them). */ readonly decisions: TurnDecisionCapabilities; readonly answers: SessionApprovalAnswers;
}
export function createRuntimeChatTurnHost(model: RuntimeModelInvocationHost, signal: AbortSignal, scratch = createScratchActivity(),
  fetchTransport: HttpFetchTransport = SYSTEM_FETCH_TRANSPORT, shellSandboxes: ShellSandboxFactory = shippedShellSandboxes): RuntimeChatTurnHost {
  void shellSandboxCapabilities(globalStateRoot()); // Start once with the service; turns await the same bounded observation (BWRAP-SELECT: launcher under the global state root).
  return Object.freeze({ model, signal, running: new Map(), scratch, fetchTransport, shellSandboxes, mcp: new McpClientPool(signal), decisions: createTurnDecisionCapabilities(), answers: new SessionApprovalAnswers(signal) });
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const principalKeyOf = (principal: { readonly issuer: string; readonly subject: string }) => sha256(`agent-turn-principal:1\0${principal.issuer}\0${principal.subject}`);
const runningKey = (scopeId: string, turnId: string) => `${scopeId}\0${turnId}`;
/** Compaction command id: the n-th compaction of a turn is one governed invocation, never billed twice on replay. */
export const chatTurnCompactionCommandId = (scopeId: string, turnId: string, sequence: number) => sha256(`turn-compact:1\0${scopeId}\0${turnId}\0${sequence}`);

/** MODES-3: a turn launched in full access is admitted only on the company grant, and recorded before anything runs (no record, no turn; a
 * refusal is recorded when it can be). */
async function admitFullAccess(context: Awaited<ReturnType<typeof loadPeerInvocationContext>>, command: { readonly scopeId: string; readonly turnId: string;
  readonly sessionId?: string | undefined }, clock: SystemTrustedClock): Promise<void> {
  const admission = admitFullAccessTurn(await context.policy.load(), { principal: context.principal, scopeId: command.scopeId, turnId: command.turnId,
    sessionId: command.sessionId ?? null, eventId: randomUUID(), atMs: clock.sample().wallMs });
  const recorded = await withAgentAudit(context, audit => audit.record(admission.event)).then(() => true, () => false);
  if (!admission.allowed) throw ErrorRegistry.createError('PERMISSION_MODE_DENIED', { params: { mode: 'full-access' } });
  if (!recorded) throw ErrorRegistry.createError('AUDIT_UNAVAILABLE');
}

/** What the owner sees before deciding a call: the tool and its arguments (slice 2 adds the edit diff). Bounded presentation. */
export function chatTurnApprovalPreview(tool: string, args: Record<string, unknown>): string { return boundApprovalPreview(`${tool} ${JSON.stringify(args, null, 2)}`); }
/** Round command id (Astra 2074 D3): the same turn and round is the same governed invocation, so a replay never bills twice. */
export const chatTurnRoundCommandId = (scopeId: string, turnId: string, round: number) => sha256(`turn-round:1\0${scopeId}\0${turnId}\0${round}`);

/** One governed terminal turn: authenticated peer, fresh policy and tools; the engine owns execution.
 * Required events drain before further work; disconnect, own-principal cancellation and stop abort the turn. */
export async function runPeerConfiguredChatTurn(projectRoot: string, input: unknown, peer: LocalPeerIdentity, options: ConfigLoadOptions,
  delivery: ModelInvocationDelivery, host: RuntimeChatTurnHost, channel: RuntimeServiceTurnChannel): Promise<ChatTurnResult> {
  const parsed = chatTurnCommandSchema.safeParse(input);
  if (!parsed.success) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
  const command = parsed.data;
  const clock = new SystemTrustedClock();
  registerProviderConfig();
  const context = await loadPeerInvocationContext(projectRoot, command.scopeId, options, peer, 'write');
  const fullAccess = command.fullAccess === true;
  if (fullAccess) await admitFullAccess(context, command, clock);
  const config = await loadConfig(projectRoot, { ...options, heal: false }) as Record<string, unknown>;
  const chat = readTerminalChatConfig(config);
  if (!chat) throw ErrorRegistry.createError('TERMINAL_CHAT_NOT_CONFIGURED');
  const binding = await inspectModelBinding(projectRoot, chat.reference, options);
  if (binding.status !== 'declared') throw ErrorRegistry.createError('TERMINAL_CHAT_MODEL_NOT_DECLARED');
  const declares = (id: string) => binding.definition.model.protocols.some(protocol => (protocol.family === OPENAI_CHAT_COMPLETIONS_FAMILY || protocol.family === ANTHROPIC_MESSAGES_FAMILY)
    && protocol.capabilities.some(capability => capability.id === id && capability.version === 1 && capability.state === 'supported'));
  const toolCapable = declares(OPENAI_CHAT_TOOL_CALLS_CAPABILITY);
  // Catalog evidence that the served template reads `enable_thinking` (TL-C D8): the compaction call then runs without thinking.
  const thinkingSwitch = declares(OPENAI_CHAT_ENABLE_THINKING_CAPABILITY);
  // v16 `reasoning: 'off'`: every round without thinking. A model that cannot switch is refused by name before anything is claimed
  // or sent (never ignored silently); `/reasoning on` turns the request back to the model's default.
  if (command.reasoning === 'off' && !thinkingSwitch) throw ErrorRegistry.createError('AGENT_TURN_REASONING_UNSUPPORTED');
  const roundThinking = command.reasoning === 'off' ? { chat_template_kwargs: { enable_thinking: false } } : {};
  // TL-B D3: `terminal.chat.readResultMaxBytes` reaches the adapter (field default 65_536 = adapter default).
  const workspace = toolCapable ? await createWorkspaceReadTools(projectRoot, { deny: agentWorkspaceDeny(projectRoot, context.layout, fullAccess), limits: { maxResultBytes: chat.readResultMaxBytes } }) : null;
  // A call the owner did not approve sees the write floor read-only in a sandbox; in full access only the configuration file stays so.
  const selfSource = await isSelfSourceProject(projectRoot), authority = agentAuthorityPaths(projectRoot, context.layout), writeFloor = agentTurnWriteFloor(authority, fullAccess, selfSource);
  // SCR-A: the conversation's scratch area (the caller's own subtree of the layout's `scratch` resource); `scratch_write` is its edit area.
  // The area is held from before it is opened until the turn ends (Astra 2149): every exit below releases it in `finally`.
  const scratch = workspace ? await openScratchSession(await prepareProductDirectory(context.layout, 'scratch'), scratchSessionKey({ scopeId: command.scopeId, principal: context.principal,
    turnId: command.turnId, ...(command.sessionId ? { sessionId: command.sessionId } : {}) }), readTerminalScratchConfig(config), host.scratch,
    { maxResultBytes: chat.readResultMaxBytes }) : null;
  const key = runningKey(command.scopeId, command.turnId);
  const cancel = new AbortController();
  const signal = AbortSignal.any([channel.signal, cancel.signal, host.signal]);
  // B1: each card of this turn (tool call, MCP trust) gets a one-time capability for this principal and peer process, sent only on this turn's stream; settled → revoked.
  const emitApproval = (event: Extract<AgentTurnStreamEvent, { kind: 'approval.requested' | 'approval.settled' }>) => channel.emit(event.kind === 'approval.settled' ? (host.decisions.revoke(command.scopeId,
    event.approvalId), event) : { ...event, decisionCapability: host.decisions.mint({ scopeId: command.scopeId, approvalId: event.approvalId, principal: context.principal, peerPid: peer.pid, expiresAt: event.expiresAt }, clock.sample().wallMs) });
  let store: Awaited<ReturnType<typeof openSqliteAgentTurnStore>> | null = null, registered = false;
  try {
    // FETCH: egress `none` (the default) builds no fetch at all — no tool, no transport use; the prompt then says fetch_url is not offered (and,
    // v6, no network at all unless the shell's posture reaches it).
    const fetchSettings = readTerminalFetchConfig(config), fetcher = scratch && fetchSettings.egress !== 'none' ? createAgentFetch({ settings: fetchSettings,
      transport: host.fetchTransport, scratch, peer, context, scopeId: command.scopeId, turnId: command.turnId }) : null;
    // MCP-CLIENT: the scoped registry files; a server nobody decided on asks now (first-use trust cards), trusted ones offer their pinned tools.
    // MCP-SANDBOX-PATHS: a server that could not be decided or started is named in the turn's note (protocol v17 unchanged: `note` exists).
    let mcpNotices: readonly string[] = [];
    const mcp = workspace ? await createAgentMcp({ onNotices: notices => { mcpNotices = notices; }, pool: host.mcp, projectRoot, options, resultMaxBytes: chat.readResultMaxBytes, peer, context, scopeId: command.scopeId,
      turnId: command.turnId, signal, emit: emitApproval, sandboxes: host.shellSandboxes({ project: workspace.scope, scratchDir: null, writeFloor: fullAccess ? isWriteApprovalFloored : writeFloor }), cwd: workspace.scope.root }) : null;
    const tools: readonly AgentToolSpec[] = workspace ? [...workspace.specs, ...WORKSPACE_EDIT_TOOL_SPECS, RUN_SHELL_TOOL_SPEC, ...SCRATCH_TOOL_SPECS,
      ...(fetcher ? [FETCH_URL_TOOL_SPEC] : []), ...(mcp?.specs ?? [])] : [];
    const editsIn = (area: WorkspaceEditArea | null | undefined, project = false) => area ? createAgentFileEdits({ area, context, peer, scopeId: command.scopeId, turnId: command.turnId,
      ...(project ? { authority, selfSource: selfSource && !fullAccess ? isSelfSourceWriteFloored : () => false } : {}) }) : null;
    const edits = editsIn(workspace && projectEditArea(workspace.scope), true), scratchEdits = editsIn(scratch?.writes), editsOf = (name: string) => name === 'scratch_write' ? scratchEdits : edits;
    const shell = workspace ? createAgentShell({ scope: workspace.scope, context, peer, scopeId: command.scopeId, turnId: command.turnId, channel,
      config: readTerminalShellConfig(config), scratch, productState: agentProductStateDeny(projectRoot, context.layout), fullAccess, authority, selfSource: selfSource && !fullAccess, writeFloor: fullAccess ? isWriteApprovalFloored : writeFloor, writeSetRoot: () => sandboxWriteSetRoot(projectRoot, context.layout, options.env ?? process.env),
      sandboxes: host.shellSandboxes({ project: workspace.scope, scratchDir: scratch?.dir ?? null, writeFloor, ...(fullAccess ? { repositoryWritable: true,
        hardFloor: agentShellHardFloor(projectRoot, context.layout, [options.env ?? process.env, process.env]) } : {}) }) }) : null;
    const principalKey = principalKeyOf(context.principal);
    const toolAuthority = new AgentToolPolicyAuthorization(context.policy);
    // The service's model-facing instructions (TL-C D4) join the client's system text in every sent round; the digest binds them, so a
    // turn id replayed after the prompt changed is a conflict, never an answer to another prompt.
    // LANG-CRASH (prompt v5): the reply language is the person's locale — the service's environment, then the configured language.
    const language = resolveLocale(undefined, options.env ?? process.env, context.config.language);
    const systemPrompt = renderAgentTurnSystemPrompt({ projectRoot, layout: context.layout, tools, scratch: scratch && { dir: scratch.dir, retentionDays: scratch.limits.retentionDays },
      model: { ...chat.reference, nativeId: binding.definition.model.nativeId }, language, outputLimitTokens: chat.maxCompletionTokens,
      network: fetcher && { allowedHosts: fetchSettings.allowedHosts, others: fetchSettings.egress === 'approval' ? 'ask' : 'refused' }, mcp: mcp?.prompt ?? null,
      // v6 PROMPT-POSTURE: the shell's posture from the realm its calls resolve (the shell owns it), apart from fetch_url.
      shell: shell ? await shell.posture() : null });
    const requestDigest = sha256(`chat-turn-request:1\0${canonical({ messages: command.messages, reference: chat.reference, catalogRevision: binding.catalogRevision,
      binding: binding.binding, maxCompletionTokens: chat.maxCompletionTokens, tools: tools.map(tool => `${tool.name}@${tool.version}`), systemPrompt: sha256(systemPrompt),
      ...(command.reasoning ? { reasoning: command.reasoning } : {}), ...(command.sessionId ? { sessionId: command.sessionId } : {}), ...(fullAccess ? { fullAccess } : {}) })}`);

    // The deployment's served window (profile data, T-L5); the provider's own report narrows it further.
    const profileWindow = ((config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles ?? [])
      .map(value => modelInvocationProfileSchema.safeParse(value)).flatMap(parsed => parsed.success ? [parsed.data] : [])
      .find(profile => profile.scopeId === command.scopeId && JSON.stringify(profile.reference) === JSON.stringify(chat.reference))?.contextWindowTokens ?? null;
    /** The one governed command of a round: measured and sent identically (the count is of exactly what is sent). */
    const roundCommand = (round: number, messages: readonly AgentTurnMessage[], declared: readonly AgentToolSpec[]): ModelInvocationCommand => ({
      schemaVersion: 1, commandId: chatTurnRoundCommandId(command.scopeId, command.turnId, round),
      scopeId: command.scopeId, reference: chat.reference, catalogRevision: binding.catalogRevision, expectedBinding: binding.binding,
      nativeRequest: { model: binding.definition.model.nativeId, messages: openAiChatNativeMessages(withAgentTurnSystemPrompt(messages, systemPrompt)), max_completion_tokens: chat.maxCompletionTokens,
        stream: true, stream_options: { include_usage: true }, ...roundThinking,
        ...(declared.length ? { tools: declared.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description,
          parameters: tool.inputSchema } })), tool_choice: 'auto' } : {}) } as unknown as JsonObject });

    const mcps = (tool: AgentToolSpec) => mcp !== null && tool.toolClass === 'mcp' && mcp.owns(tool.name);
    const describe = (tool: AgentToolSpec, args: Record<string, unknown>) => mcps(tool) ? mcp!.display(tool.name) : describeAgentCall(tool, args);
    const approvals = createAgentCallApprovals({ context, clock, scopeId: command.scopeId, turnId: command.turnId, describe });
    // One permission decision per call (T-L4 slice 4a): strict policy, floor raise and permission-mode lowering, again at the effect.
    const decisions = createAgentCallDecisions({ context, clock, scopeId: command.scopeId, turnId: command.turnId, edits: editsOf, shell, approvals, fetch: fetcher, mcp, fullAccess, standing: { memory: host.answers.memory, session: SessionStanding.sessionKey(command.scopeId, context.principal, command.sessionId ?? command.turnId) } });
    const fetches = (tool: AgentToolSpec) => fetcher !== null && tool.name === FETCH_URL_TOOL_SPEC.name;

    store = await openSqliteAgentTurnStore(await context.path(), context.config.storage.sqlite, 'forbid');
    registered = !host.running.has(key);
    if (registered) host.running.set(key, { principalKey, controller: cancel });
    const ports: AgentTurnPorts = {
      async invokeRound({ round, messages, tools: declared }, onDelta, roundSignal): Promise<AgentRoundOutcome> {
        await channel.drained();
        const invocation = roundCommand(round, messages, declared);
        let shownText = '', shownReasoning = '';
        let result: Awaited<ReturnType<typeof invokePeerConfiguredModel>>;
        try {
          // The round's result stays inside the service (bounded by the profile's response limit); no transport delivery applies.
          result = await invokePeerConfiguredModel(projectRoot, invocation, peer, options, undefined, host.model, delta => {
            if (delta.kind === 'text') shownText += delta.text; else shownReasoning += delta.text;
            onDelta(delta);
          }, roundSignal);
        } catch (error) {
          // The closure note names the typed failure (policy, activation, allocation, provider), never a raw cause.
          return { status: 'failed', state: roundSignal.aborted ? 'cancelled' : queryFailure(error).code };
        }
        const outcome = result.receipt.outcome;
        if (!outcome) return { status: 'failed', state: 'pending' };
        if (outcome.state !== 'responded') return { status: 'failed', state: chatTurnRoundFailureState(outcome) };
        const message = openAiChatMessageFromInvocation(result);
        if (!message) return { status: 'failed', state: 'unreadable' };
        // What was shown is always a prefix of the governed result; anything else ends the turn, never merged.
        if (!message.content.startsWith(shownText) || !message.reasoning.startsWith(shownReasoning)) return { status: 'failed', state: 'stream-mismatch' };
        if (message.reasoning.length > shownReasoning.length) onDelta({ kind: 'reasoning', text: message.reasoning.slice(shownReasoning.length) });
        if (message.content.length > shownText.length) onDelta({ kind: 'text', text: message.content.slice(shownText.length) });
        const usage = openAiChatUsageFromInvocation(result);
        return { status: 'responded', content: message.content, reasoning: message.reasoning, toolCalls: message.toolCalls,
          finish: typeof message.finish === 'string' ? message.finish : 'unknown',
          usage: usage ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens } : null };
      },
      // An edit is also the `workspace.file.write` operation, a shell command `host.shell.run`: the stricter of both decisions holds;
      // the write floor and the shell tiers raise allow in every mode; a permission mode lowers only a company-eligible cell (slice 4a).
      authorize: (tool, args) => decisions.authorize(tool, args),
      async prepare(tool, args) {
        if ((tool.toolClass === 'shell' && shell) || (tool.toolClass === 'edit' && editsOf(tool.name)) || fetches(tool) || mcps(tool)) return decisions.prepare(tool, args);
        return { ok: true };
      },
      async requestApproval({ round, index, call, tool, args, argsDigest, target }, approvalSignal) {
        // C12: one single-use approval bound to exactly this call; the preview is presentation, the digest is what is approved.
        const journal = openSqliteApprovalStore(await context.path(), context.config.storage.sqlite);
        // Once a card was requested it is always settled: `unsettled` when the wait failed (the request may stay pending, it permits nothing).
        let answer: { wait(): Promise<void>; close(): void } | null = null;
        let requested: { readonly approvalId: string } | null = null, settlement: AgentToolApprovalSettlement = 'unsettled', kept: string | null = null;
        try {
          // A producer of approvals, like Run reservation: the integrity key is created on first use (decisions only read it).
          const integrity = await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true);
          const policy = await context.policy.load() as { revision?: unknown };
          const callSubject = approvals.subject({ round, index }, tool, target, argsDigest), resource = callSubject.resource, started = clock.sample(), now = started.wallMs;
          const { id, issuer, subject } = context.principal, facts = agentToolApprovalFacts(policy, command.scopeId, decisions.cell(tool, args));
          const record = requestAgentToolApproval(journal.store, integrity, { scopeId: command.scopeId, requester: { id, issuer, subject }, subject: callSubject, facts,
            policyRevision: typeof policy.revision === 'string' ? policy.revision : 'unknown',
            summary: agentToolApprovalSummary({ tool: tool.name, resource, argsDigest, cell: decisions.cell(tool, args), selfSourceReason: decisions.cell(tool, args) === 'edit-self-source' ? t('terminal.approval.selfSource',
              { path: resource, mode: fullAccess ? 'full-access' : agentCallPermissionMode(policy, context.principal, command.scopeId) }, language) : '' }), createdAt: now, expiresAt: now + context.config.approvals.requestTtlMs });
          // A diff larger than the preview bound is shown cut, with the whole change kept owner-only while the approval is pending.
          const diff = editsOf(tool.name)?.preview(tool.name, args);
          if (diff !== undefined && Buffer.byteLength(diff, 'utf8') > APPROVAL_PREVIEW_MAX_BYTES) kept = await keepFullPreview(context.layout, record.request.approvalId, diff);
          const offer = await decisions.sessionOffer(tool, args);
          if (offer) answer = host.answers.register({ record, principal: context.principal, peerPid: peer.pid,
            session: SessionStanding.sessionKey(command.scopeId, context.principal, command.sessionId ?? command.turnId), key: offer.key, signal: approvalSignal, clock, started,
            remember: (valid, refused) => decisions.remember(tool, args, { round, index }, call.id, record.request.approvalId, { valid, refused }) });
          emitApproval({ kind: 'approval.requested', callId: call.id, approvalId: record.request.approvalId, revision: record.revision, risk: facts.risk?.source === 'cell' ? facts.risk.cell : null,
            requiredAssurance: facts.requiredAssurance, summary: record.request.summary, preview: diff !== undefined ? boundApprovalPreview(diff, kept)
              : (tool.toolClass === 'shell' ? shell?.preview(tool.name, args) : fetches(tool) ? fetcher?.preview(args) : mcps(tool) ? boundApprovalPreview(mcp!.preview(tool.name, args)!)
                : undefined) ?? chatTurnApprovalPreview(tool.name, args),
            expiresAt: record.request.expiresAt, ...(answer && offer ? { standing: { scopes: ['session'] as const, pattern: offer.pattern } } : {}) });
          requested = { approvalId: record.request.approvalId };
          let outcome = await awaitAgentToolApproval(journal.store, integrity, record, clock, approvalSignal, 250, started);
          if (outcome === 'allow') await answer?.wait();
          // Approved: re-evaluate policy now; a deny since the request wins (contract §2).
          if (outcome === 'allow' && await toolAuthority.decide(tool, command.scopeId, context.principal) === 'deny') outcome = 'deny';
          // Policy revalidation is asynchronous: it spends the same authorization budget as waiting.
          if (outcome === 'allow') {
            const consumed = clock.sample();
            if (approvalSignal.aborted) outcome = 'cancelled';
            else if (consumed.wallMs >= record.request.expiresAt || consumed.monotonicMs - started.monotonicMs >= record.request.expiresAt - started.wallMs) outcome = 'expired';
          }
          // The effect gate verifies this stored record (MAC, allow, digest of the executed call, expiry) before anything is written or run.
          if (outcome === 'allow') approvals.allowed({ round, index }, { approvalId: record.request.approvalId, actionDigest: record.request.actionDigest, started });
          settlement = outcome;
          return outcome;
        } finally {
          answer?.close(); journal.close();
          if (kept) await dropFullPreview(kept);
          if (requested) emitApproval({ kind: 'approval.settled', callId: call.id, approvalId: requested.approvalId, outcome: settlement });
        }
      },
      async summarize({ sequence, messages: older }, summarySignal) {
        // Summary input is bounded in bytes (a UTF-8 byte is never fewer than one token): 40% of the known window, else 32k.
        const transcript = agentCompactionTranscript(older, Math.floor(0.4 * (profileWindow ?? 32_768)));
        const invocation: ModelInvocationCommand = { schemaVersion: 1, commandId: chatTurnCompactionCommandId(command.scopeId, command.turnId, sequence),
          scopeId: command.scopeId, reference: chat.reference, catalogRevision: binding.catalogRevision, expectedBinding: binding.binding,
          nativeRequest: { model: binding.definition.model.nativeId, messages: [{ role: 'system', content: agentCompactionInstruction(language) },
            { role: 'user', content: transcript }], max_completion_tokens: chat.maxCompletionTokens, stream: false,
          ...(thinkingSwitch ? { chat_template_kwargs: { enable_thinking: false } } : {}) } as unknown as JsonObject };
        const result = await invokePeerConfiguredModel(projectRoot, invocation, peer, options, undefined, host.model, undefined, summarySignal).catch(() => null);
        if (result?.receipt.outcome?.state !== 'responded') return null;
        return parseAgentCompactionSummary(extractOpenAiChatTextFromInvocation(result)) ?? 'unreadable';
      },
      async measure({ round, messages, tools: declared }, measureSignal) {
        const invocation = roundCommand(round, messages, declared);
        const counted = await measurePeerConfiguredModel(projectRoot, invocation, peer, options, measureSignal).catch(() => null);
        const windows = [profileWindow, counted?.windowTokens ?? null].filter((value): value is number => value !== null);
        const windowTokens = windows.length ? Math.min(...windows) : null;
        if (counted) return { promptTokens: counted.promptTokens, windowTokens, quality: 'provider-count' as const };
        return { promptTokens: openAiChatPromptUpperBound(invocation.nativeRequest), windowTokens, quality: 'upper-bound' as const };
      },
      describe,
      async execute(tool, args, toolSignal, callId, execution) {
        await channel.drained();
        if (!workspace) return { status: 'error', text: `[deckent] ${tool.name}: error=unknown-tool` };
        if ((tool.toolClass === 'edit' && editsOf(tool.name)) || (tool.toolClass === 'shell' && shell)) {
          return decisions.execute(tool, args, execution, callId, (gate, authority, writes, track) => tool.toolClass === 'edit'
            ? editsOf(tool.name)!.apply(tool.name, args, execution, gate) : shell!.apply(tool.name, args, toolSignal, callId, execution, gate, authority, writes, track));
        }
        if (fetches(tool)) return decisions.execute(tool, args, execution, callId, gate => fetcher!.apply(args, toolSignal, execution, gate));
        if (mcps(tool)) return decisions.execute(tool, args, execution, callId, gate => mcp!.apply(tool.name, args, toolSignal, execution, gate));
        return scratch?.reads(tool.name) ? scratch.read(tool.name, args, toolSignal) : workspace.execute(tool.name, args, toolSignal);
      },
      now: () => clock.sample().wallMs,
    };
    const result = await runDurableAgentTurn({ claim: { scopeId: command.scopeId, turnId: command.turnId, principalKey, requestDigest, claimedAtMs: clock.sample().wallMs },
      messages: command.messages, tools, signal, emit: event => { if (event.kind !== 'done') channel.emit(event); },
      admission: agentTurnAdmission(chat.maxCompletionTokens, context.config.service.inputMaxBytes) }, store, ports);
    await channel.drained();
    const answer = result.answer;
    const answerBytes = answer === null ? 0 : Buffer.byteLength(answer, 'utf8');
    // The answer came as text events; the result repeats it only while it fits the replay bound and the caller's delivery.
    const kept = answer !== null && answerBytes <= Math.min(AGENT_TURN_ANSWER_MAX_BYTES, Math.max(0, delivery.maxResultBytes - 1024)) ? answer : null;
    return Object.freeze({ schemaVersion: 1, turnId: command.turnId, finish: result.finish, note: withMcpNotices(mcpNotices, result.note), rounds: result.rounds,
      toolCalls: result.toolCalls, answer: kept, answerBytes, replayed: result.replayed, recorded: result.recorded });
  } finally {
    if (registered) host.running.delete(key);
    scratch?.release();
    store?.close();
  }
}

/** Cancels a running turn of the same principal at once; another principal's turn or an unknown id is `not-running`. */
export async function cancelPeerConfiguredChatTurn(projectRoot: string, input: unknown, peer: LocalPeerIdentity, options: ConfigLoadOptions,
  host: RuntimeChatTurnHost): Promise<ChatTurnCancellationResult> {
  const parsed = chatTurnCancellationSchema.safeParse(input);
  if (!parsed.success) throw new AgentTurnStoreError('AGENT_TURN_INVALID');
  const context = await loadPeerInvocationContext(projectRoot, parsed.data.scopeId, options, peer, 'write');
  const running = host.running.get(runningKey(parsed.data.scopeId, parsed.data.turnId));
  if (!running || running.principalKey !== principalKeyOf(context.principal)) return Object.freeze({ schemaVersion: 1, turnId: parsed.data.turnId, state: 'not-running' });
  running.controller.abort();
  return Object.freeze({ schemaVersion: 1, turnId: parsed.data.turnId, state: 'cancelling' });
}
