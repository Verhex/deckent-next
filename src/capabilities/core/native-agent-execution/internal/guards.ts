import { z } from 'zod';
import type { NativeAgentReadinessReason } from './contract.js';
import type { ToolSession } from './session.js';
import type { NativeCliAgent, NativeAgentBridge } from './registry.js';

const initSchema = z.looseObject({ type: z.literal('system'), subtype: z.literal('init'), tools: z.array(z.string()),
  plugins: z.array(z.looseObject({ name: z.string(), path: z.string(), source: z.string() })),
  mcp_servers: z.array(z.looseObject({ name: z.string(), status: z.string() })),
  skills: z.array(z.unknown()), slash_commands: z.array(z.unknown()), permissionMode: z.string(), apiKeySource: z.string(),
});
/** Pure seal prerequisite, not a driver or a capability issuer. Missing/malformed fields refuse, including plugin provenance. */
export function nativeAgentInitReason(agent: NativeCliAgent, bridge: NativeAgentBridge, session: ToolSession, value: unknown): NativeAgentReadinessReason | null {
  if (agent.transport.kind !== 'claude-mcp') return 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED';
  const parsed = initSchema.safeParse(value);
  if (!parsed.success) return 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED';
  const init = parsed.data, { guards } = agent.transport;
  if (init.plugins.some(plugin => !guards.plugins.some(allowed => plugin.name === allowed.name && plugin.path === allowed.path && plugin.source === allowed.source))
    || new Set(init.plugins.map(plugin => plugin.name)).size !== init.plugins.length) return 'NATIVE_AGENT_PLUGIN_UNEXPECTED';
  const expected = new Set(session.tools.map(tool => bridge.toolPrefix + tool.name));
  if (new Set(init.tools).size !== init.tools.length || init.tools.length !== expected.size || init.tools.some(tool => !expected.has(tool))
    || init.skills.length || init.slash_commands.length || init.permissionMode !== guards.permissionMode || !guards.apiKeySources.includes(init.apiKeySource)
    || init.mcp_servers.length !== 1 || init.mcp_servers[0]!.name !== bridge.serverName || init.mcp_servers[0]!.status !== 'connected') return 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED';
  return null;
}
/** K3 still owns stream ordering/counts and full call/result correlation. Unknown/native item types never reach it as accepted tools. */
export function nativeAgentItemReason(agent: NativeCliAgent, value: unknown): NativeAgentReadinessReason | null {
  if (agent.transport.kind !== 'codex-mcp' || !value || typeof value !== 'object' || Array.isArray(value)) return 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED';
  const item = value as Record<string, unknown>, { guards } = agent.transport;
  return typeof item['type'] === 'string' && (guards.allowedItems.some(type => type === item['type'])
    || item['type'] === 'error' && item['message'] === guards.codeModeError) ? null : 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED';
}
