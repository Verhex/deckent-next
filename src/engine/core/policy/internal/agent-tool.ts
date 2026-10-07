import { evaluatePolicy, policyResources, type AgentToolSpec, type VerifiedPrincipal } from '#domain/index.js';
import type { PolicySource } from './authorize.js';

/**
 * The policy resource of an agent tool call: `agent-tool` + tool name, or for an MCP tool `mcp-server` + its server's registry name (owner
 * 2026-10-07, Jev 04f75210: one authority kind per server, covering its pinned tools). The action is always `invoke`.
 */
export function agentToolPolicyResource(tool: { readonly name: string }, mcpServer?: string): { readonly kind: string; readonly id: string } {
  return mcpServer === undefined ? { kind: policyResources.agentTool.kind, id: tool.name } : { kind: policyResources.mcpServer.kind, id: mcpServer };
}
/**
 * Per-call authority of an agent tool (T-L3): resource `agent-tool`, id = tool name, action `invoke` (an MCP tool: `mcp-server` + its server, and
 * an explicit `agent-tool` deny of its wire name still denies). The three decisions are the loop's typed results; an unreadable policy fails
 * closed as `deny`. Persona, history and tool results never grant authority.
 */
export class AgentToolPolicyAuthorization {
  constructor(private readonly source: PolicySource) {}
  async decide(tool: AgentToolSpec, scopeId: string, principal: VerifiedPrincipal, mcpServer?: string): Promise<'allow' | 'deny' | 'require-approval'> {
    try {
      const policy = await this.source.load(), ask = (resource: { readonly kind: string; readonly id: string }) => evaluatePolicy(policy, { principal, scopeId, action: 'invoke', resource });
      if (mcpServer !== undefined && ask({ kind: policyResources.agentTool.kind, id: tool.name }).reason === 'DENIED') return 'deny';
      return ask(agentToolPolicyResource(tool, mcpServer)).decision;
    } catch { return 'deny'; }
  }
}
