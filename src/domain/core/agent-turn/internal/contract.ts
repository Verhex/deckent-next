import { z } from 'zod';
import { agentToolCallSchema } from '#domain/core/agent-tool/index.js';

/**
 * Provider-neutral conversation of one agent turn (T-L3). Messages that come from the client — history, earlier tool results,
 * project documents — are untrusted context: they never grant authority. Native provider details stay in adapters.
 */
export const agentTurnMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string().min(1) }).strict(),
  z.object({ role: z.literal('user'), content: z.string().min(1) }).strict(),
  z.object({ role: z.literal('assistant'), content: z.string(), toolCalls: z.array(agentToolCallSchema).readonly() }).strict(),
  z.object({ role: z.literal('tool'), toolCallId: z.string().min(1).max(256), name: z.string().min(1).max(64), content: z.string() }).strict(),
]);
export type AgentTurnMessage = z.infer<typeof agentTurnMessageSchema>;

/**
 * What a surface shows while a turn runs. Tool rounds are never silent: every call has a started and a finished event with its
 * target and duration, and the turn always ends with exactly one `done`. A closure note is engine-written, deterministic text
 * for turns that end without a model answer (legacy owner cases: long runs with no visible answer).
 */
export type AgentTurnEvent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'tool.started'; readonly callId: string; readonly name: string; readonly target: string | null }
  | { readonly kind: 'tool.finished'; readonly callId: string; readonly name: string; readonly status: AgentToolCallStatus; readonly ms: number; readonly bytes: number }
  | { readonly kind: 'usage'; readonly round: number; readonly promptTokens: number; readonly completionTokens: number }
  | { readonly kind: 'done'; readonly finish: AgentTurnFinish; readonly note: string | null };

export type AgentToolCallStatus = 'ok' | 'error' | 'denied' | 'approval-required' | 'invalid-arguments' | 'duplicate' | 'cancelled';
export type AgentTurnFinish = 'stop' | 'length' | 'cancelled' | 'error';
