import type { AgentToolSpec, EffectCommand, JsonObject } from '#domain/index.js';
import { bubblewrapShellSandbox } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { landlockShellSandbox, type ShellSandboxLayout } from '#adapters/core/host-shell/index.js';
import { McpClientPool, type McpLaunchContext } from './pool.js';
import type { McpClientSettings, McpToolCell, McpToolVerdict } from './pin.js';
import { agentMcpEffectCommandId, describeMcpApproval, MCP_TOOL_CALL_OPERATION, MCP_TOOL_TARGET_KIND } from './target.js';

/** One offered MCP tool as a turn knows it: where it lives, its pinned definition and the permission cell it is decided in. */
export interface McpOfferedTool {
  readonly spec: AgentToolSpec;
  readonly server: string;
  readonly tool: string;
  readonly display: string;
  readonly digest: string;
  readonly cell: McpToolCell;
  readonly command: string;
  readonly posture: string;
}
/**
 * The MCP tools one turn may offer (MCP-CLIENT): every configured server is opened (started, listed, verified) and only its `pinned` tools
 * become agent tools. A server that cannot be opened offers nothing this turn (its reason is what `inspect` shows).
 */
export async function openMcpAgentTools(pool: McpClientPool, settings: McpClientSettings, context: McpLaunchContext): Promise<ReadonlyMap<string, McpOfferedTool>> {
  const offered = new Map<string, McpOfferedTool>();
  const opened = await Promise.all(settings.servers.map(async server => ({ server, state: await pool.open(server, settings, context) })));
  for (const { server, state } of opened) {
    if (!state.ok) continue;
    for (const verdict of state.tools) {
      if (verdict.status !== 'pinned' || !verdict.spec || !verdict.digest || !verdict.cell || offered.has(verdict.spec.name)) continue;
      offered.set(verdict.spec.name, Object.freeze({ spec: verdict.spec, server: server.id, tool: verdict.name, display: verdict.display, digest: verdict.digest,
        cell: verdict.cell, command: [server.command, ...server.args].join(' '), posture: state.posture }));
    }
  }
  return offered;
}

/**
 * One turn's view of its offered MCP tools: the declared specs, the system-prompt names, the permission cell, the plan check (a known tool,
 * arguments well inside the operation's input bound), the approval card and the C11 command of a call (server, tool, pinned digest, arguments).
 */
export function mcpTurnTools(offered: ReadonlyMap<string, McpOfferedTool>) {
  const of = (name: string) => offered.get(name);
  return {
    specs: [...offered.values()].map(entry => entry.spec),
    prompt: [...offered.values()].map(entry => ({ name: entry.spec.name, display: entry.display })),
    entry: of,
    owns: (name: string) => offered.has(name),
    display: (name: string) => of(name)?.display ?? null,
    cell: (name: string): McpToolCell | null => of(name)?.cell ?? null,
    plan: (name: string, args: Record<string, unknown>): string | null => !of(name) ? `[deckent] ${name}: error=unknown-tool`
      : Buffer.byteLength(JSON.stringify(args), 'utf8') > MCP_TOOL_CALL_OPERATION.inputMaxBytes / 2 ? `[deckent] ${name}: error=arguments-too-large` : null,
    preview: (name: string, args: Record<string, unknown>) => { const entry = of(name); return entry ? describeMcpApproval({ ...entry, args }) : undefined; },
    command(entry: McpOfferedTool, args: Record<string, unknown>, call: { readonly scopeId: string; readonly turnId: string; readonly round: number; readonly index: number;
      readonly argsDigest: string }): EffectCommand {
      const commandId = agentMcpEffectCommandId(call.scopeId, call.turnId, call, call.argsDigest);
      return { schemaVersion: 1, commandId, scopeId: call.scopeId, operation: MCP_TOOL_CALL_OPERATION.operation, idempotencyKey: commandId,
        target: { kind: MCP_TOOL_TARGET_KIND, id: `mcp-${commandId.slice(0, 32)}` }, input: { server: entry.server, tool: entry.tool, digest: entry.digest,
          arguments: args as JsonObject }, expectedVersion: null };
    },
  };
}
/** The shipped sandbox providers for a server started outside the service (`inspect`): the shell's, in its order, without a scratch area. */
export const mcpInspectSandboxes = (project: ShellSandboxLayout['project']) => [bubblewrapShellSandbox({ project, scratchDir: null }),
  landlockShellSandbox({ project, scratchDir: null })];

export interface McpServerListing { readonly schemaVersion: 1; readonly servers: readonly { readonly id: string; readonly command: string; readonly args: readonly string[];
  readonly realm: string; readonly environment: readonly string[]; readonly pinnedTools: number }[] }
/** `deckent mcp servers list`: configuration only; nothing is started. */
export function listMcpServers(settings: McpClientSettings | null): McpServerListing {
  return { schemaVersion: 1, servers: (settings?.servers ?? []).map(server => ({ id: server.id, command: server.command, args: server.args, realm: server.realm,
    environment: server.environment, pinnedTools: server.tools.length })) };
}
export interface McpServerInspection {
  readonly schemaVersion: 1;
  readonly server: Record<string, unknown>;
  readonly tools: readonly (Omit<McpToolVerdict, 'spec'>)[];
}
/** `deckent mcp servers inspect <id>`: starts the server under its realm with its own pool, reads the era and the tool list, verifies the pins
 * and closes it again. It never calls a tool. */
export async function inspectMcpServer(settings: McpClientSettings, id: string, context: McpLaunchContext): Promise<McpServerInspection | null> {
  const server = settings.servers.find(entry => entry.id === id);
  if (!server) return null;
  const controller = new AbortController(), pool = new McpClientPool(controller.signal);
  try {
    const state = await pool.open(server, settings, context);
    const tools = state.ok ? state.tools.map(verdict => Object.fromEntries(Object.entries(verdict).filter(([key]) => key !== 'spec')) as Omit<McpToolVerdict, 'spec'>) : [];
    const rest = Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'tools'));
    return { schemaVersion: 1, server: { id: server.id, command: server.command, args: server.args, realm: server.realm, ...rest, stderr: pool.stderr(server.id) }, tools };
  } finally { controller.abort(); await pool.close(); }
}
