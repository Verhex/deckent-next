/** Public native CLI seam; the shared pure capability contract owns the session types. */
export { toolSessionSchema, nativeAgentCorrelationSchema, nativeAgentToolResultSchema } from '#capabilities/index.js';
export type { ToolSession, ToolSessionPort, NativeAgentCorrelation, NativeAgentToolResult, ToolSessionClosure, ToolSessionCancellation, ToolSessionRevocation } from '#capabilities/index.js';
