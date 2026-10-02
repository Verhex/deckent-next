import { EffectError, type AgentToolOutcome } from '#domain/index.js';
import { EffectApplication, OperationPolicyAuthorization, agentToolApprovalFacts, agentToolArgumentsDigest, type EffectApprovalGate } from '#engine/index.js';
import { configuredSecretResolver, loadConfig, ManagedFileError, resolveLocale, SystemTrustedClock, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { agentWorkspaceDeny, createLocalPeerSession, createWorkspaceReadTools, describeMcpRefusal, describeMcpResult, isWriteApprovalFloored, MCP_TOOL_CALL_OPERATION, MCP_TOOL_TARGET_KIND, mcpInspectSandboxes,
  McpToolTarget, mcpSendAuthority, mcpTrustAuditWriter, mcpTurnTools, openSqliteAttemptStore, openTurnMcp, readLocalOsIdentity, registerProviderConfig, runMcpCommand, type LocalPeerIdentity,
  type McpCallOutcome, type McpClientPool, type McpCommandContext, type McpCommandRequest, type McpLaunchContext, type McpStartNotice } from '#adapters/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
/**
 * The owner-facing text of one MCP start notice (MCP-SANDBOX-PATHS follow-up): the single renderer of the adapter's structured notice, from
 * the catalog (`mcp.start.*`), for the turn's note (the service's locale) and `lastStart.text` of `mcp list|get` and `/mcp` (the caller's).
 */
export function renderMcpStartNotice(notice: McpStartNotice, locale: Locale): string {
  const { name } = notice;
  if (notice.kind === 'not-recorded') return t('mcp.start.notRecorded', { name }, locale);
  if (notice.kind === 'not-decided') return t('mcp.start.notDecided', { name, code: notice.code }, locale);
  const { failure } = notice, diagnosis = failure.diagnosis;
  const why = diagnosis?.kind === 'path-hidden'
    ? t('mcp.start.failed.pathHidden', { name, path: diagnosis.path, targetSuffix: diagnosis.target ? ` -> ${diagnosis.target}` : '',
      role: diagnosis.role === 'command' ? t('error.MCP_SANDBOX_COMMAND_UNREACHABLE.role.command', {}, locale) : t('error.MCP_SANDBOX_COMMAND_UNREACHABLE.role.argument', {}, locale) }, locale)
    : diagnosis?.kind === 'package-runner' ? t('mcp.start.failed.packageRunner', { name, runner: diagnosis.runner }, locale)
    : diagnosis ? t('mcp.start.failed.containerDaemon', { name, runner: diagnosis.runner }, locale)
    : t('mcp.start.failed.other', { name, code: failure.code, detailSuffix: failure.detail ? `: ${failure.detail}` : '' }, locale);
  const next = failure.phase === 'launch' ? t('mcp.start.next.launch', { name }, locale) : t('mcp.start.next.trusted', { name }, locale);
  return `${why} ${next}`;
}
/** One turn's MCP tools (wiring): first-use trust cards, pinned tools; a call is a C11 effect of Core `mcp.tool.call` (policy again, intent first), never sent twice. */
export async function createAgentMcp(input: { readonly pool: McpClientPool; readonly projectRoot: string; readonly options: ConfigLoadOptions; readonly resultMaxBytes: number;
  readonly peer: LocalPeerIdentity; readonly context: Awaited<ReturnType<typeof loadPeerInvocationContext>>; readonly scopeId: string; readonly turnId: string;
  readonly signal: AbortSignal; readonly emit: Parameters<typeof openTurnMcp>[0]['emit']; readonly sandboxes: McpLaunchContext['sandboxes']; readonly cwd: string;
  /** MCP-SANDBOX-PATHS: what could not be decided or started this turn (display-safe), for the turn's result note — never silent. */
  readonly onNotices?: (notices: readonly string[]) => void }) {
  const { pool, context, scopeId, turnId } = input, environment = input.options.env ?? process.env, config = context.config;
  // The note is a string on the wire: rendered here, in the service's locale (its environment, then the configured language).
  const locale = resolveLocale(undefined, environment, config.language);
  // SECRET-K1: personal-file `$DECK:NAME` goes through the installation's one configured resolver, never straight to the environment.
  const resolveSecret = configuredSecretResolver(config, input.options);
  const registry = { projectRoot: input.projectRoot, layout: context.layout, environment, secret: (name: string) => resolveSecret(name) };
  const opened = await openTurnMcp({ registry, pool, cwd: input.cwd, sandboxes: input.sandboxes, principal: context.principal, sqlite: config.storage.sqlite,
  keyFile: config.approvals.keyFile, requestTtlMs: config.approvals.requestTtlMs, inputMaxBytes: config.mcp.inputMaxBytes, resultMaxBytes: input.resultMaxBytes, scopeId, turnId,
  signal: input.signal, emit: input.emit, describeNotice: notice => renderMcpStartNotice(notice, locale), ledgerPath: () => context.path(), requestPolicy: async () => { const policy = await context.policy.load().catch(() => null); return { revision: String((policy as { revision?: unknown } | null)?.revision ?? 'unknown'), trustFacts: agentToolApprovalFacts(policy, scopeId, null) }; } }); // one snapshot (Sol 2237 R2b)
  if (opened.notices.length) input.onNotices?.(opened.notices);
  if (!opened.settings) return null;
  // MCP-REVOKE: every call re-reads the current registry and trust at its send (the same registry context the turn opened with).
  const { offered } = opened, settings = opened.settings, tools = mcpTurnTools(offered), authority = mcpSendAuthority(registry);
  return { ...tools, async apply(name: string, args: Record<string, unknown>, signal: AbortSignal, execution: { readonly round: number; readonly index: number },
    gate: EffectApprovalGate): Promise<AgentToolOutcome> {
    const entry = tools.entry(name);
    if (!entry) return { status: 'error', text: `[deckent] ${name}: error=unknown-tool` };
    const command = tools.command(entry, args, { scopeId, turnId, ...execution, argsDigest: agentToolArgumentsDigest(name, args) }), clock = new SystemTrustedClock();
    let ran: McpCallOutcome | null = null;
    const target = new McpToolTarget({ pool, timeoutMs: entry.timeoutMs, signal, onResult: value => { ran = value; },
      admit: call => authority({ ...call, binding: call.server === entry.server ? entry.binding : null }) });
    const sessions = await createLocalPeerSession(input.peer, context.principal.scopeIds, context.config.approvals.sessionTtlMs, clock);
    const store = await openSqliteAttemptStore(await context.path(), context.config.storage.sqlite, 'forbid');
    try {
      await new EffectApplication({ async resolve(ref) { return ref.id === MCP_TOOL_CALL_OPERATION.operation.id && ref.version === 1 ? MCP_TOOL_CALL_OPERATION : null; } },
        { resolve: kind => kind === MCP_TOOL_TARGET_KIND ? target : null }, store, gate, sessions, new OperationPolicyAuthorization(context.policy), clock).execute(command);
      return ran ? describeMcpResult(ran, entry.display, settings.resultMaxBytes, entry) : describeMcpRefusal(entry.display, 'no-result');
    } catch (error) {
      return ran ? describeMcpResult(ran, entry.display, settings.resultMaxBytes, entry)
        : describeMcpRefusal(entry.display, error instanceof EffectError ? error.code : (error as { code?: unknown })?.code);
    } finally { store.close(); }
  } };
}
/** `deckent mcp …` and `/mcp`: the scoped registry files, the trust records (audited, over this project's ledger) and, for `list`/trust decisions, the
 * server started in its realm. `ask` shows a trust card and answers the owner's decision; `locale` is the calling surface's (default: this
 * process's environment, then the configured language). */
export async function runConfiguredMcpCommand(projectRoot: string, request: McpCommandRequest, options: ConfigLoadOptions, ask: McpCommandContext['ask'], locale?: Locale) {
  registerProviderConfig();
  const config = await loadConfig(projectRoot, { ...options, heal: false }), environment = options.env ?? process.env, principal = readLocalOsIdentity();
  const workspace = await createWorkspaceReadTools(projectRoot, { deny: agentWorkspaceDeny(projectRoot, config.productLayout) }),
    scopeId = (config as unknown as { terminal?: { scopeId?: string } }).terminal?.scopeId ?? 'installation';
  const shown = locale ?? resolveLocale(undefined, environment, config.language);
  // LANG-CRASH: a managed-file refusal on the way (trust audit over the ledger, the trust directory, e.g. a companion another uid owns inside a
  // sandbox) is the owner's typed, localized error with its diagnosis — never an uncaught exception and crash report. Anything else is unchanged.
  return runMcpCommand(request, { projectRoot, layout: config.productLayout, environment, sandboxes: mcpInspectSandboxes(workspace.scope, isWriteApprovalFloored), principal, ask,
    describeNotice: notice => renderMcpStartNotice(notice, shown),
    secret: configuredSecretResolver(config, options), limits: { inputMaxBytes: config.mcp.inputMaxBytes },
    audit: mcpTrustAuditWriter({ layout: config.productLayout, sqlite: config.storage.sqlite, keyFile: config.approvals.keyFile, scopeId, principal, policyRevision: 'owner-cli' }) })
    .catch((error: unknown) => { throw error instanceof ManagedFileError ? queryFailure(error) : error; });
}
