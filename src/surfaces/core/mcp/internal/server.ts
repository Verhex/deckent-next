import { Server, type Tool, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PACKAGE_NAME, PACKAGE_VERSION, DeckentError, t, type Locale } from '#platform/index.js';
import { runQuerySchema, dispatchInventoryInputSchema, getPolicyVocabulary, type RunQuery, type DispatchInventoryInput } from '#engine/index.js';
export interface McpQueries {
  inspectRun(query: RunQuery): Promise<unknown>;
  inspectInventory(query: DispatchInventoryInput): Promise<unknown>;
}
export interface McpLimits { maxConcurrentCalls: number; responseMaxBytes: number }
/** Local read-only protocol surface. Injected applications own identity, policy and data access. */
export function createReadOnlyMcpServer(queries: McpQueries, limits: McpLimits, locale: Locale) {
  z.object({ maxConcurrentCalls: z.number().int().positive().safe(), responseMaxBytes: z.number().int().positive().safe() }).strict().parse(limits);
  const definitions = [
    { name: 'inspect_run', description: t('mcp.tool.inspectRun', {}, locale), schema: runQuerySchema,
      invoke: (input: unknown) => queries.inspectRun(runQuerySchema.parse(input)) },
    { name: 'inspect_inventory', description: t('mcp.tool.inspectInventory', {}, locale), schema: dispatchInventoryInputSchema,
      invoke: (input: unknown) => queries.inspectInventory(dispatchInventoryInputSchema.parse(input)) },
    { name: 'policy_vocabulary', description: t('mcp.tool.policyVocabulary', {}, locale), schema: z.object({}).strict(),
      invoke: async (input: unknown) => { z.object({}).strict().parse(input); return getPolicyVocabulary(); } },
  ];
  const server = new Server({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, { capabilities: { tools: {} } }); let active = 0;
  const failure = (code: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, code }) }] });
  server.setRequestHandler('tools/list', async () => ({ tools: definitions.map(tool => ({ name: tool.name, description: tool.description,
    inputSchema: zodToJsonSchema(tool.schema, { $refStrategy: 'none' }) as Tool['inputSchema'],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  })) }));
  server.setRequestHandler('tools/call', async request => {
    const tool = definitions.find(value => value.name === request.params.name);
    if (!tool) return failure('MCP_TOOL_UNKNOWN');
    if (active >= limits.maxConcurrentCalls) return failure('MCP_BUSY');
    active++;
    try {
      const value = await tool.invoke(request.params.arguments ?? {}); const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded, 'utf8') > limits.responseMaxBytes) return failure('MCP_RESPONSE_LIMIT');
      return { content: [{ type: 'text', text: encoded }], structuredContent: JSON.parse(encoded) as Record<string, unknown> };
    } catch (error) { return failure(error instanceof DeckentError ? error.code : error instanceof z.ZodError ? 'MCP_INPUT_INVALID' : 'MCP_TOOL_FAILED'); }
    finally { active--; }
  });
  return server;
}
