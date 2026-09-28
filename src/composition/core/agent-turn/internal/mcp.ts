import { EffectError, type AgentToolOutcome } from '#domain/index.js';
import { EffectApplication, OperationPolicyAuthorization, agentToolArgumentsDigest, type EffectApprovalGate } from '#engine/index.js';
import { loadConfig, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { createLocalPeerSession, createWorkspaceReadTools, describeMcpRefusal, describeMcpResult, MCP_TOOL_CALL_OPERATION, MCP_TOOL_TARGET_KIND, mcpInspectSandboxes,
  McpToolTarget, mcpTurnTools, openMcpAgentTools, openSqliteAttemptStore, readLocalOsIdentity, registerProviderConfig, runMcpCommand, type LocalPeerIdentity,
  type McpCallOutcome, type McpClientPool, type McpClientSettings, type McpCommandContext, type McpCommandRequest, type McpLaunchContext } from '#adapters/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import { agentWorkspaceDeny } from './turn.js';

/** The agent's MCP tools in one turn (MCP-CLIENT), wiring only: pinned, matching tools are offered; a call is a C11 effect of Core `mcp.tool.call`
 * on the `mcp-tool` target (session, operation policy again before the effect, intent before the call, the caller's gate), never sent twice. */
export async function createAgentMcp(input: { readonly pool: McpClientPool; readonly settings: McpClientSettings; readonly launch: McpLaunchContext;
  readonly peer: LocalPeerIdentity; readonly context: Awaited<ReturnType<typeof loadPeerInvocationContext>>; readonly scopeId: string; readonly turnId: string }) {
  const { pool, settings, context, scopeId, turnId } = input, offered = await openMcpAgentTools(pool, settings, input.launch);
  if (!offered.size) return null;
  const tools = mcpTurnTools(offered);
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

/** `deckent mcp …`: the scoped registry files, the trust record in the data root and, for `list`/`approve`, the server started in its realm. */
export async function runConfiguredMcpCommand(projectRoot: string, request: McpCommandRequest, options: ConfigLoadOptions, confirm: McpCommandContext['confirm']) {
  registerProviderConfig();
  const config = await loadConfig(projectRoot, { ...options, heal: false }), environment = options.env ?? process.env;
  const workspace = await createWorkspaceReadTools(projectRoot, { deny: agentWorkspaceDeny(projectRoot, config.productLayout) });
  return runMcpCommand(request, { projectRoot, layout: config.productLayout, environment, sandboxes: mcpInspectSandboxes(workspace.scope), principal: readLocalOsIdentity(),
    confirm, secret: async name => options.secretResolver ? options.secretResolver(name) : environment[name], limits: { inputMaxBytes: config.mcp.inputMaxBytes } });
}
