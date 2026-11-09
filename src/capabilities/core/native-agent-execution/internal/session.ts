import { z } from 'zod';
import { agentToolSpecSchema, agentToolOutcomeSchema, identitySchema, persistedString, type AgentToolCall } from '#domain/index.js';

import { positive } from './schema-parts.js';
const callId = persistedString(z.string().min(1).max(256)).refine(value => !value.includes('\0'));
/** One turn generation; no credentials. The approval TTL is supplied by effective policy, never a CLI default. */
export const toolSessionSchema = z.strictObject({ schemaVersion: z.literal(1), turnId: identitySchema, generation: positive,
  tools: z.array(agentToolSpecSchema).readonly().refine(tools => new Set(tools.map(tool => tool.name)).size === tools.length
    && !tools.some(tool => tool.name === 'decide_approval')),
  approvalTtlMs: positive,
}).readonly();
export type ToolSession = z.infer<typeof toolSessionSchema>;
/** Claude _meta["claudecode/toolUseId"] matches tool_use.id. Codex _meta ids do NOT match JSONL item.id (A0-4). */
export const nativeAgentCorrelationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('claude-tool-use'), toolUseId: callId, deckentCallId: callId }).readonly(),
  z.strictObject({ kind: z.literal('codex-mcp'), callId, itemId: callId, deckentCallId: callId }).readonly(),
]);
export type NativeAgentCorrelation = z.infer<typeof nativeAgentCorrelationSchema>;
/** One tool call's correlation as its kind's CLI sends it in the MCP request `_meta` (unvalidated: the bridge parses it with the schema). */
export const nativeAgentCorrelationMeta = (kind: NativeAgentCorrelation['kind'], meta: Readonly<Record<string, unknown>>, deckentCallId: string) => kind === 'claude-tool-use'
  ? { kind, toolUseId: meta['claudecode/toolUseId'], deckentCallId } : { kind, callId: meta['callId'], itemId: meta['itemId'], deckentCallId };
/** The facade stamps this envelope into EVERY tool result, including errors; Codex correlates by this id, never arrival order. */
export const nativeAgentToolResultSchema = z.strictObject({ schemaVersion: z.literal(1), turnId: identitySchema, generation: positive,
  deckentCallId: callId, outcome: agentToolOutcomeSchema,
}).readonly();
export type NativeAgentToolResult = z.infer<typeof nativeAgentToolResultSchema>;
/** Session closure fences new calls. Process termination and external effect settlement are separate facts. */
export type ToolSessionClosure = Readonly<{ turnId: string; generation: number; pendingCallIds: readonly string[];
  termination: 'confirmed' | 'unverified'; effects: 'settled' | 'unknown' }>;
export type ToolSessionCancellation = ToolSessionClosure & Readonly<{ kind: 'cancelled' }>;
export type ToolSessionRevocation = ToolSessionClosure & Readonly<{ kind: 'revoked' }>;
/** K1 owns call authorization/execution/settlement. K2/K3 and K4 only transport proposals and these results. */
export interface ToolSessionPort {
  readonly session: ToolSession;
  /** Producer-owned terminal cause, independent of the model's final answer. Not accepted from wire input. */
  terminalFailure?(): 'approval-expired' | null;
  propose(call: AgentToolCall, correlation: NativeAgentCorrelation, signal: AbortSignal): Promise<NativeAgentToolResult>;
  cancel(): Promise<ToolSessionCancellation>;
  revoke(): Promise<ToolSessionRevocation>;
}
