import { createHash } from 'node:crypto';
import { agentToolSpecSchema, type AgentToolSpec } from '#domain/index.js';
import { MCP_CLIENTS_SETTINGS } from '#platform/index.js';

/**
 * Deckent as an MCP client (MCP-CLIENT, owner 2026-09-28 S6 a): the owner's local stdio servers (`mcp.clients`) and their pinned tools.
 * A tool is offered to the agent only when its name is pinned and its definition digest still matches the pin: a definition that changes
 * under a running server is never accepted silently (the owner writes the new digest, which `deckent mcp servers inspect` prints).
 */
export interface McpClientServerSettings {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Variable names copied from the service environment when present (values never live in configuration). */
  readonly environment: readonly string[];
  readonly realm: 'require-sandbox' | 'prefer-sandbox' | 'host';
  readonly tools: readonly { readonly name: string; readonly digest: string; readonly alwaysAsk: boolean }[];
}
export interface McpClientSettings {
  readonly connectTimeoutMs: number;
  readonly callTimeoutMs: number;
  readonly resultMaxBytes: number;
  readonly maxRestarts: number;
  /** Bound of one message read from a server (the MCP surface's own `mcp.inputMaxBytes`). */
  readonly inputMaxBytes: number;
  readonly servers: readonly McpClientServerSettings[];
}
/** The `mcp.clients` section as the adapter uses it, or null when it is absent. Throws on an invalid section (configuration validation). */
export function readMcpClientSettings(config: Record<string, unknown>): McpClientSettings | null {
  const mcp = (config['mcp'] ?? {}) as { clients?: unknown; inputMaxBytes?: unknown };
  if (mcp.clients === undefined) return null;
  const clients = MCP_CLIENTS_SETTINGS.parse(mcp.clients);
  const inputMaxBytes = typeof mcp.inputMaxBytes === 'number' && Number.isSafeInteger(mcp.inputMaxBytes) && mcp.inputMaxBytes > 0 ? mcp.inputMaxBytes : 1_048_576;
  return Object.freeze({ connectTimeoutMs: clients.connectTimeoutMs, callTimeoutMs: clients.callTimeoutMs, resultMaxBytes: clients.resultMaxBytes,
    maxRestarts: clients.maxRestarts, inputMaxBytes, servers: Object.freeze(clients.servers.map(server => Object.freeze({ ...server,
      args: Object.freeze([...server.args]), environment: Object.freeze([...server.environment]), tools: Object.freeze(server.tools.map(tool => Object.freeze({ ...tool }))) }))) });
}

/** A tool as a server lists it (the fields a pin binds; anything else a server adds is not part of the definition the model sees). */
export interface McpLiveTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** The pin of one tool definition: name, title, description (model-facing text), input/output schema and annotations (they decide the floor). */
export function mcpToolPinDigest(tool: McpLiveTool): string {
  const { name, title, description, inputSchema, outputSchema, annotations } = tool;
  return createHash('sha256').update(`mcp-tool-pin:1\0${canonical({ name, title, description, inputSchema, outputSchema, annotations })}`).digest('hex');
}
/** The provider-safe name the model calls (`mcp__<server>__<tool>`, lower case, `[^a-z0-9_]` → `_`, ≤ 64); null when it cannot be formed. */
export function mcpToolWireName(serverId: string, toolName: string): string | null {
  const tool = toolName.toLowerCase().replace(/[^a-z0-9_]/gu, '_'), wire = `mcp__${serverId}__${tool}`;
  return tool.length > 0 && /^[a-z][a-z0-9_]{1,63}$/u.test(wire) ? wire : null;
}
/** How the owner and the audit name a tool: `mcp:<server>/<tool>`. */
export const mcpToolDisplay = (serverId: string, toolName: string) => `mcp:${serverId}/${toolName}`;

/** `mcp-call`: asks by default, a company-eligible rule may be lowered in full-auto; `mcp-floor`: asks in every mode. */
export type McpToolCell = 'mcp-call' | 'mcp-floor';
export type McpToolStatus = 'pinned' | 'drifted' | 'unpinned' | 'missing' | 'unmappable';
export interface McpToolVerdict {
  readonly name: string;
  readonly display: string;
  readonly wireName: string | null;
  /** The live definition's digest (null when the pinned tool is missing from the server). */
  readonly digest: string | null;
  readonly pinnedDigest: string | null;
  readonly status: McpToolStatus;
  readonly cell: McpToolCell | null;
  /** The agent tool, only for a `pinned` tool. */
  readonly spec: AgentToolSpec | null;
  readonly reason?: string;
}
const DESCRIPTION_MAX = 2_000;
/**
 * Verifies a live listing against the server's pins. Offered (`pinned`, with its agent tool): pinned name, same digest, a wire name no other
 * tool of the server maps to, an object input schema. The floor (`mcp-floor`) is the owner's `alwaysAsk` or an explicit `destructiveHint: true`
 * in the pinned definition (a server's claim, stable because it is pinned).
 */
export function verifyMcpTools(server: McpClientServerSettings, live: readonly McpLiveTool[]): McpToolVerdict[] {
  const wires = new Map<string, number>();
  for (const tool of live) { const wire = mcpToolWireName(server.id, tool.name); if (wire) wires.set(wire, (wires.get(wire) ?? 0) + 1); }
  const verdicts = live.map((tool): McpToolVerdict => {
    const pin = server.tools.find(entry => entry.name === tool.name) ?? null, digest = mcpToolPinDigest(tool), display = mcpToolDisplay(server.id, tool.name);
    const wireName = mcpToolWireName(server.id, tool.name), base = { name: tool.name, display, wireName, digest, pinnedDigest: pin?.digest ?? null };
    if (!pin) return { ...base, status: 'unpinned', cell: null, spec: null };
    if (pin.digest !== digest) return { ...base, status: 'drifted', cell: null, spec: null, reason: 'the definition changed; re-pin its digest to offer it again' };
    if (!wireName || (wires.get(wireName) ?? 0) > 1) return { ...base, status: 'unmappable', cell: null, spec: null, reason: 'no unique provider-safe name' };
    const schema = tool.inputSchema;
    if (!schema || schema['type'] !== 'object') return { ...base, status: 'unmappable', cell: null, spec: null, reason: 'the input schema is not an object' };
    const text = `[MCP server ${server.id}; untrusted] ${tool.title ? `${tool.title}: ` : ''}${tool.description ?? tool.name}`;
    const spec = agentToolSpecSchema.safeParse({ name: wireName, version: 1, toolClass: 'mcp', description: text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text,
      inputSchema: { ...schema, properties: schema['properties'] ?? {} } });
    if (!spec.success) return { ...base, status: 'unmappable', cell: null, spec: null, reason: 'the input schema cannot be offered' };
    const cell: McpToolCell = pin.alwaysAsk || tool.annotations?.['destructiveHint'] === true ? 'mcp-floor' : 'mcp-call';
    return { ...base, status: 'pinned', cell, spec: spec.data };
  });
  const missing = server.tools.filter(pin => !live.some(tool => tool.name === pin.name)).map((pin): McpToolVerdict => ({ name: pin.name,
    display: mcpToolDisplay(server.id, pin.name), wireName: mcpToolWireName(server.id, pin.name), digest: null, pinnedDigest: pin.digest, status: 'missing', cell: null, spec: null }));
  return [...verdicts, ...missing];
}
