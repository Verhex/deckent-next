import { z } from 'zod';
import { agentToolCallSchema } from '#domain/core/agent-tool/index.js';
import { identitySchema } from '#domain/core/primitives/index.js';

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
  /** Each assistant or tool message the turn appends, in order: the client's history continues from exactly these. */
  | { readonly kind: 'message'; readonly message: AgentTurnMessage }
  /** The prompt of a round as measured before it was sent (T-L5): the provider's count, or a tagged upper bound. */
  | { readonly kind: 'context'; readonly round: number; readonly promptTokens: number; readonly windowTokens: number | null; readonly quality: AgentContextQuality }
  /** The history was compacted (T-L5b): `messages` replaces every non-system message the client holds; its system prompt stays. */
  | { readonly kind: 'compacted'; readonly messages: readonly AgentTurnMessage[]; readonly replacedMessages: number }
  /** A call waits for the owner's decision (T-L4, C12): the preview is presentation; the approval binds the exact call. */
  | { readonly kind: 'approval.requested'; readonly callId: string; readonly approvalId: string; readonly revision: number; readonly summary: string;
    readonly preview: string; readonly expiresAt: number }
  | { readonly kind: 'approval.settled'; readonly callId: string; readonly approvalId: string; readonly outcome: AgentToolApprovalSettlement }
  /** Streamed output of a running call (T-L4 shell): presentation; the call's result stays the only history. */
  | { readonly kind: 'tool.output'; readonly callId: string; readonly stream: 'stdout' | 'stderr'; readonly text: string }
  | { readonly kind: 'done'; readonly finish: AgentTurnFinish; readonly note: string | null };

/**
 * How the turn left a call's approval: decided (`allow`/`deny`), durably closed (`expired`, `cancelled`), or `unsettled` — the
 * durable close failed and the request stays pending until its expiry or the service-start sweep; it never permits the call.
 */
export type AgentToolApprovalSettlement = 'allow' | 'deny' | 'expired' | 'cancelled' | 'unsettled';
export type AgentToolCallStatus = 'ok' | 'error' | 'denied' | 'approval-required' | 'approval-expired' | 'invalid-arguments' | 'duplicate' | 'cancelled';
export type AgentTurnFinish = 'stop' | 'length' | 'cancelled' | 'error';
/** `provider-count`: the provider's own tokenizer on exactly the round's request; `upper-bound`: a conservative byte-based bound. */
export type AgentContextQuality = 'provider-count' | 'upper-bound';

const count = z.number().int().nonnegative().safe();
const finishSchema = z.enum(['stop', 'length', 'cancelled', 'error']);
const callStatusSchema = z.enum(['ok', 'error', 'denied', 'approval-required', 'approval-expired', 'invalid-arguments', 'duplicate', 'cancelled']);
/**
 * Turn events on the wire (runtime `chatTurn`): every event but `done`, whose content is the operation's result. `message` events
 * are required data (the client's history), not presentation; the transport never drops them silently.
 */
export const agentTurnStreamEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('reasoning'), text: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('tool.started'), callId: z.string().min(1).max(256), name: z.string().min(1).max(64), target: z.string().max(4096).nullable() }).strict(),
  z.object({ kind: z.literal('tool.finished'), callId: z.string().min(1).max(256), name: z.string().min(1).max(64), status: callStatusSchema, ms: count, bytes: count }).strict(),
  z.object({ kind: z.literal('usage'), round: z.number().int().positive().safe(), promptTokens: count, completionTokens: count }).strict(),
  z.object({ kind: z.literal('message'), message: agentTurnMessageSchema }).strict(),
  z.object({ kind: z.literal('context'), round: z.number().int().positive().safe(), promptTokens: count, windowTokens: z.number().int().positive().safe().nullable(),
    quality: z.enum(['provider-count', 'upper-bound']) }).strict(),
  z.object({ kind: z.literal('compacted'), messages: z.array(agentTurnMessageSchema).min(1).readonly(), replacedMessages: count }).strict(),
  z.object({ kind: z.literal('approval.requested'), callId: z.string().min(1).max(256), approvalId: z.string().min(1).max(256), revision: count,
    summary: z.string().min(1).max(2048), preview: z.string().max(65_536), expiresAt: count }).strict(),
  z.object({ kind: z.literal('approval.settled'), callId: z.string().min(1).max(256), approvalId: z.string().min(1).max(256),
    outcome: z.enum(['allow', 'deny', 'expired', 'cancelled', 'unsettled']) }).strict(),
  z.object({ kind: z.literal('tool.output'), callId: z.string().min(1).max(256), stream: z.enum(['stdout', 'stderr']), text: z.string().min(1) }).strict(),
]);
export type AgentTurnStreamEvent = z.infer<typeof agentTurnStreamEventSchema>;

/**
 * One terminal agent turn (runtime `chatTurn`). The principal comes from the connection, never from input; the model, tools and
 * limits come from the service's configuration. `messages` is the client's history ending with the new user message: untrusted
 * context, bound to the turn id by its digest (the same id with a different history is a conflict, never an old answer).
 */
export const chatTurnCommandSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, turnId: identitySchema,
  messages: z.array(agentTurnMessageSchema).min(1) }).strict().refine(command => command.messages.at(-1)?.role === 'user',
  { path: ['messages'], message: 'CHAT_TURN_LAST_MESSAGE_NOT_USER' }).readonly();
export type ChatTurnCommand = z.infer<typeof chatTurnCommandSchema>;
export const parseChatTurnCommand = (value: unknown): ChatTurnCommand => chatTurnCommandSchema.parse(value);

/** The bounded result of a turn: the final answer when it fits the replay bound, never the tool results (they came as events). */
export const chatTurnResultSchema = z.object({ schemaVersion: z.literal(1), turnId: identitySchema, finish: finishSchema,
  note: z.string().max(4096).nullable(), rounds: count, toolCalls: count, answer: z.string().nullable(), answerBytes: count,
  replayed: z.boolean(), recorded: z.boolean() }).strict().readonly();
export type ChatTurnResult = z.infer<typeof chatTurnResultSchema>;

/** Cancels the caller's own running turn at once (the same principal that started it); a disconnect cancels at the next write. */
export const chatTurnCancellationSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, turnId: identitySchema }).strict().readonly();
export type ChatTurnCancellation = z.infer<typeof chatTurnCancellationSchema>;
export const parseChatTurnCancellation = (value: unknown): ChatTurnCancellation => chatTurnCancellationSchema.parse(value);
export const chatTurnCancellationResultSchema = z.object({ schemaVersion: z.literal(1), turnId: identitySchema,
  state: z.enum(['cancelling', 'not-running']) }).strict().readonly();
export type ChatTurnCancellationResult = z.infer<typeof chatTurnCancellationResultSchema>;
