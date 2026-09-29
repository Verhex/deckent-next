import type { AgentToolSpec, EffectCommand, JsonObject } from '#domain/index.js';
import { bubblewrapShellSandbox } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { landlockShellSandbox, type ShellSandboxLayout } from '#adapters/core/host-shell/index.js';
import type { McpClientPool, McpLaunchContext, McpServerOpen } from './pool.js';
import type { McpClientSettings, McpToolCell } from './pin.js';
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
  readonly timeoutMs: number;
}
/**
 * The MCP tools one turn may offer (MCP-CLIENT): every configured server is opened (started, listed, verified) and only its `pinned` tools
 * become agent tools. A server that cannot be opened offers nothing this turn; `onOpened` sees every outcome (the turn's notice, `/mcp`).
 */
export async function openMcpAgentTools(pool: McpClientPool, settings: McpClientSettings, context: McpLaunchContext,
  onOpened?: (server: McpClientSettings['servers'][number], state: McpServerOpen) => void): Promise<ReadonlyMap<string, McpOfferedTool>> {
  const offered = new Map<string, McpOfferedTool>();
  const opened = await Promise.all(settings.servers.map(async server => ({ server, state: await pool.open(server, settings, context) })));
  for (const { server, state } of opened) {
    onOpened?.(server, state);
    if (!state.ok) continue;
    for (const verdict of state.tools) {
      if (verdict.status !== 'pinned' || !verdict.spec || !verdict.digest || !verdict.cell || offered.has(verdict.spec.name)) continue;
      offered.set(verdict.spec.name, Object.freeze({ spec: verdict.spec, server: server.id, tool: verdict.name, display: verdict.display, digest: verdict.digest,
        cell: verdict.cell, command: server.label ?? [server.command, ...server.args].join(' '), posture: state.posture, timeoutMs: server.timeoutMs ?? settings.callTimeoutMs }));
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
/** The shipped sandbox providers for a server started outside the service (`inspect`: trust, health, restart): the shell's, in its order,
 * without a scratch area, with the same write floor as a turn's launch (Astra 2170 R2: one contract for every server start). */
export const mcpInspectSandboxes = (project: ShellSandboxLayout['project'], writeFloor: NonNullable<ShellSandboxLayout['writeFloor']>) =>
  [bubblewrapShellSandbox({ project, scratchDir: null, writeFloor }), landlockShellSandbox({ project, scratchDir: null, writeFloor })];

