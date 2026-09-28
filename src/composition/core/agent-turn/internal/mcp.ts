import { EffectError, type AgentToolOutcome } from '#domain/index.js';
import { EffectApplication, OperationPolicyAuthorization, agentToolArgumentsDigest, type EffectApprovalGate } from '#engine/index.js';
import { loadConfig, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { createLocalPeerSession, createWorkspaceReadTools, describeMcpRefusal, describeMcpResult, isWriteApprovalFloored, MCP_TOOL_CALL_OPERATION, MCP_TOOL_TARGET_KIND, mcpInspectSandboxes,
  McpToolTarget, mcpTrustAuditWriter, mcpTurnTools, openSqliteAttemptStore, openTurnMcp, readLocalOsIdentity, registerProviderConfig, runMcpCommand, type LocalPeerIdentity,
  type McpCallOutcome, type McpClientPool, type McpCommandContext, type McpCommandRequest, type McpLaunchContext } from '#adapters/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import { agentWorkspaceDeny } from './turn.js';

/** One turn's MCP tools (wiring): first-use trust cards, pinned tools; a call is a C11 effect of Core `mcp.tool.call` (policy again, intent first), never sent twice. */
export async function createAgentMcp(input: { readonly pool: McpClientPool; readonly projectRoot: string; readonly options: ConfigLoadOptions; readonly resultMaxBytes: number;
  readonly peer: LocalPeerIdentity; readonly context: Awaited<ReturnType<typeof loadPeerInvocationContext>>; readonly scopeId: string; readonly turnId: string;
  readonly signal: AbortSignal; readonly emit: Parameters<typeof openTurnMcp>[0]['emit']; readonly sandboxes: McpLaunchContext['sandboxes']; readonly cwd: string }) {
  const { pool, context, scopeId, turnId } = input, environment = input.options.env ?? process.env, config = context.config;
  const opened = await openTurnMcp({ registry: { projectRoot: input.projectRoot, layout: context.layout, environment, secret: async name => input.options.secretResolver
    ? input.options.secretResolver(name) : environment[name] }, pool, cwd: input.cwd, sandboxes: input.sandboxes, principal: context.principal, sqlite: config.storage.sqlite,
  keyFile: config.approvals.keyFile, requestTtlMs: config.approvals.requestTtlMs, inputMaxBytes: config.mcp.inputMaxBytes, resultMaxBytes: input.resultMaxBytes, scopeId, turnId,
  signal: input.signal, emit: input.emit, ledgerPath: () => context.path(), policyRevision: async () => String((await context.policy.load().catch(() => null) as { revision?: unknown } | null)?.revision ?? 'unknown') });
  if (!opened) return null;
  const { settings, offered } = opened, tools = mcpTurnTools(offered);
  return { ...tools, async apply(name: string, args: Record<string, unknown>, signal: AbortSignal, execution: { readonly round: number; readonly index: number },
    gate: EffectApprovalGate): Promise<AgentToolOutcome> {
    const entry = tools.entry(name);
    if (!entry) return { status: 'error', text: `[deckent] ${name}: error=unknown-tool` };
    const command = tools.command(entry, args, { scopeId, turnId, ...execution, argsDigest: agentToolArgumentsDigest(name, args) }), clock = new SystemTrustedClock();
    let ran: McpCallOutcome | null = null;
    const target = new McpToolTarget({ pool, timeoutMs: entry.timeoutMs, signal, onResult: value => { ran = value; } });
    const sessions = await createLocalPeerSession(input.peer, context.principal.scopeIds, context.config.approvals.sessionTtlMs, clock);
    const store = await openSqliteAttemptStore(await context.path(), context.config.storage.sqlite, 'forbid');
    try {
      await new EffectApplication({ async resolve(ref) { return ref.id === MCP_TOOL_CALL_OPERATION.operation.id && ref.version === 1 ? MCP_TOOL_CALL_OPERATION : null; } },
        { resolve: kind => kind === MCP_TOOL_TARGET_KIND ? target : null }, store, gate, sessions, new OperationPolicyAuthorization(context.policy), clock).execute(command);
      return ran ? describeMcpResult(ran, entry.display, settings.resultMaxBytes) : describeMcpRefusal(entry.display, 'no-result');
    } catch (error) {
      return ran ? describeMcpResult(ran, entry.display, settings.resultMaxBytes)
        : describeMcpRefusal(entry.display, error instanceof EffectError ? error.code : (error as { code?: unknown })?.code);
    } finally { store.close(); }
  } };
}

/** `deckent mcp …` and `/mcp`: the scoped registry files, the trust records (audited, over this project's ledger) and, for `list`/trust decisions, the
 * server started in its realm. `ask` shows a trust card and answers the owner's decision. */
export async function runConfiguredMcpCommand(projectRoot: string, request: McpCommandRequest, options: ConfigLoadOptions, ask: McpCommandContext['ask']) {
  registerProviderConfig();
  const config = await loadConfig(projectRoot, { ...options, heal: false }), environment = options.env ?? process.env, principal = readLocalOsIdentity();
  const workspace = await createWorkspaceReadTools(projectRoot, { deny: agentWorkspaceDeny(projectRoot, config.productLayout) }),
    scopeId = (config as unknown as { terminal?: { scopeId?: string } }).terminal?.scopeId ?? 'installation';
  return runMcpCommand(request, { projectRoot, layout: config.productLayout, environment, sandboxes: mcpInspectSandboxes(workspace.scope, isWriteApprovalFloored), principal, ask,
    secret: async name => options.secretResolver ? options.secretResolver(name) : environment[name], limits: { inputMaxBytes: config.mcp.inputMaxBytes },
    audit: mcpTrustAuditWriter({ layout: config.productLayout, sqlite: config.storage.sqlite, keyFile: config.approvals.keyFile, scopeId, principal, policyRevision: 'owner-cli' }) });
}
