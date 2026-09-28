export { dispatch, main } from '#surfaces/core/cli/index.js';
export type { ExitCode } from '#surfaces/core/cli/index.js';
export type { McpApplications, McpLimits } from '#surfaces/core/mcp/index.js';
// The MCP server surface loads the whole server SDK (~105 ms); processes that never serve MCP (CLI, runtime service, SDK) must not pay for it
// at import time, so the barrel offers a lazy loader instead of a static `createMcpServer` export (STARTUP-COST).
export function loadMcpSurface(): Promise<typeof import('#surfaces/core/mcp/index.js')> { return import('#surfaces/core/mcp/index.js'); }
export type { ToolResultSummary, TurnDelta, WorklineStreamTurn } from '#surfaces/core/terminal/index.js';
