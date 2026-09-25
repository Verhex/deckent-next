import { evaluatePolicy, policyResources, type AgentToolSpec, type VerifiedPrincipal } from '#domain/index.js';
import type { PolicySource } from './authorize.js';

/**
 * Per-call authority of an agent tool (T-L3): resource `agent-tool`, id = tool name, action `invoke`. The three decisions are the
 * loop's typed results; an unreadable policy fails closed as `deny`. Persona, history and tool results never grant authority.
 */
export class AgentToolPolicyAuthorization {
  constructor(private readonly source: PolicySource) {}
  async decide(tool: AgentToolSpec, scopeId: string, principal: VerifiedPrincipal): Promise<'allow' | 'deny' | 'require-approval'> {
    try {
      return evaluatePolicy(await this.source.load(), { principal, scopeId, action: 'invoke',
        resource: { kind: policyResources.agentTool.kind, id: tool.name } }).decision;
    } catch { return 'deny'; }
  }
}
