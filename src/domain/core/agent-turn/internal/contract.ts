import { z } from 'zod';
import { agentMessageContinuationSchema } from './continuation.js';
import { agentToolCallSchema, agentToolCleanupSchema, type AgentToolCleanup } from '#domain/core/agent-tool/index.js';
import { identitySchema } from '#domain/core/primitives/index.js';
import { modelReferenceSchema } from '#domain/core/provider-catalog/index.js';
import { agentShellPostureSchema, agentToolCardCallSchema, agentToolUndoSchema, approvalPreviewCutSchema, type AgentShellPosture, type AgentToolCardCall, type AgentToolUndo,
  type ApprovalPreviewCutFacts } from './card-facts.js';

/** v30 steer line id: identifier-shaped and short (a UUID fits), so every accepted id fits the turn's bounded result whole (Astra 2882). */
export const chatTurnSteerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * Provider-neutral conversation of one agent turn (T-L3). Messages that come from the client — history, earlier tool results,
 * project documents — are untrusted context: they never grant authority. Native provider details stay in adapters.
 */
export const agentTurnMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string().min(1) }).strict(),
  z.object({ role: z.literal('user'), content: z.string().min(1) }).strict(),
  z.object({ role: z.literal('assistant'), content: z.string(), toolCalls: z.array(agentToolCallSchema).readonly(), continuation: agentMessageContinuationSchema.optional() }).strict(),
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
  /** `cleanup` (Astra 2124, protocol v15 addition, no version bump): only the host shell tool's finish ever carries it. */
  | { readonly kind: 'tool.finished'; readonly callId: string; readonly name: string; readonly status: AgentToolCallStatus; readonly ms: number; readonly bytes: number;
    readonly cleanup?: AgentToolCleanup }
  | { readonly kind: 'usage'; readonly round: number; readonly promptTokens: number; readonly completionTokens: number }
  /** Each message the turn appends (assistant, tool, or the engine's `[deckent]` user note), in order, in order: the client's history continues from exactly these.
   * v30: `steerId` marks the person's steered line (`steerChatTurn`) at the one moment it joined the turn. */
  | { readonly kind: 'message'; readonly message: AgentTurnMessage; readonly steerId?: string }
  /** The prompt of a round as measured before it was sent (T-L5): the provider's count, or a tagged upper bound. */
  | { readonly kind: 'context'; readonly round: number; readonly promptTokens: number; readonly windowTokens: number | null; readonly quality: AgentContextQuality }
  /** The history was compacted (T-L5b): `messages` replaces every non-system message the client holds; its system prompt stays. */
  | { readonly kind: 'compacted'; readonly messages: readonly AgentTurnMessage[]; readonly replacedMessages: number }
  /** A call waits for the owner's decision (T-L4, C12): the preview is presentation; the approval binds the exact call. v19 (B1): the turn's
   * one-time `decisionCapability` (sent only on this stream), the card's `risk` (its permission cell; null = not declared) and `requiredAssurance`. */
  | { readonly kind: 'approval.requested'; readonly callId: string; readonly approvalId: string; readonly revision: number; readonly summary: string;
    readonly standing?: { readonly scopes: readonly ['session']; readonly pattern: string };
    readonly preview: string; readonly expiresAt: number; readonly decisionCapability?: string; readonly risk?: string | null; readonly requiredAssurance?: string;
    /** v21 (T2-FOLLOWUP): what the card may say about undoing the call, and a shell call's structured posture (absent: not known here). */
    readonly undo?: AgentToolUndo; readonly posture?: AgentShellPosture;
    /** v21 (Astra 2431): the card's fields as data (whole command, target and counts, URL, MCP tool) and the preview cut's facts. */
    readonly call?: AgentToolCardCall; readonly previewCut?: ApprovalPreviewCutFacts }
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
  z.object({ kind: z.literal('tool.finished'), callId: z.string().min(1).max(256), name: z.string().min(1).max(64), status: callStatusSchema, ms: count, bytes: count,
    cleanup: agentToolCleanupSchema.optional() }).strict(),
  z.object({ kind: z.literal('usage'), round: z.number().int().positive().safe(), promptTokens: count, completionTokens: count }).strict(),
  z.object({ kind: z.literal('message'), message: agentTurnMessageSchema, steerId: chatTurnSteerIdSchema.optional() }).strict(),
  z.object({ kind: z.literal('context'), round: z.number().int().positive().safe(), promptTokens: count, windowTokens: z.number().int().positive().safe().nullable(),
    quality: z.enum(['provider-count', 'upper-bound']) }).strict(),
  z.object({ kind: z.literal('compacted'), messages: z.array(agentTurnMessageSchema).min(1).readonly(), replacedMessages: count }).strict(),
  z.object({ kind: z.literal('approval.requested'), callId: z.string().min(1).max(256), approvalId: z.string().min(1).max(256), revision: count,
    summary: z.string().min(1).max(2048), preview: z.string().max(65_536), expiresAt: count, decisionCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
    standing: z.object({ scopes: z.tuple([z.literal('session')]).readonly(), pattern: z.string().min(1).max(2048) }).strict().optional(),
    risk: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/).nullable().optional(), requiredAssurance: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/).optional(),
    undo: agentToolUndoSchema.optional(), posture: agentShellPostureSchema.optional(), call: agentToolCardCallSchema.optional(),
    previewCut: approvalPreviewCutSchema.optional() }).strict(),
  z.object({ kind: z.literal('approval.settled'), callId: z.string().min(1).max(256), approvalId: z.string().min(1).max(256),
    outcome: z.enum(['allow', 'deny', 'expired', 'cancelled', 'unsettled']) }).strict(),
  z.object({ kind: z.literal('tool.output'), callId: z.string().min(1).max(256), stream: z.enum(['stdout', 'stderr']), text: z.string().min(1) }).strict(),
]);
export type AgentTurnStreamEvent = z.infer<typeof agentTurnStreamEventSchema>;

/**
 * One terminal agent turn (runtime `chatTurn`). The principal comes from the connection, never from input; the model, tools and
 * limits come from the service's configuration. `messages` is the client's history ending with the new user message: untrusted
 * context, bound to the turn id by its digest (the same id with a different history is a conflict, never an old answer).
 * `reasoning: 'off'` (protocol v16) asks every round to run without model thinking; absent or `'on'` is the model's default.
 * `sessionId` (protocol v16, SCR-A) names the client's conversation: its scratch area lives across turns; absent, the area is the turn's.
 */
/** Protocol vocabulary of `chatTurn.reasoning` (v16), not a configuration value. */
export const CHAT_TURN_REASONING = Object.freeze(['on', 'off'] as const);
export const chatTurnCommandSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, turnId: identitySchema,
  messages: z.array(agentTurnMessageSchema).min(1), reasoning: z.enum(CHAT_TURN_REASONING).optional(), sessionId: identitySchema.optional(),
  /** v17 (MODES-3): the turn runs in full access — only when the person launched the terminal so and a company grant allows it; never implied. */
  fullAccess: z.literal(true).optional(),
  /** v23 (T4 MODEL-SWITCH, S19): the model this session pinned with `/model`; the service uses exactly it or refuses typed (never the configured
   * model in its place). Absent: the configured `terminal.chat.reference`. */
  reference: modelReferenceSchema.optional() }).strict().refine(command => command.messages.at(-1)?.role === 'user',
  { path: ['messages'], message: 'CHAT_TURN_LAST_MESSAGE_NOT_USER' }).readonly();
export type ChatTurnCommand = z.infer<typeof chatTurnCommandSchema>;
export const parseChatTurnCommand = (value: unknown): ChatTurnCommand => chatTurnCommandSchema.parse(value);

/** v30 wire bounds (protocol invariants, versioned with the protocol like the frame bounds): MCP start notices one result carries, and the
 * steered lines one turn accepts. */
export const CHAT_TURN_RESULT_NOTICES = 32;
export const CHAT_TURN_STEER_LINES = 16;
const noticeText = (max: number) => z.string().min(1).max(max);
/**
 * v30 (tema L6): an MCP server this turn could not decide or start, as data (the adapter's `McpStartNotice`, never prose); the surface
 * renders it from its own catalog. `note` no longer carries MCP text.
 */
export const mcpStartNoticeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start-failed'), name: noticeText(64), failure: z.object({ code: noticeText(64), phase: z.enum(['launch', 'trusted', 'tools']),
    detail: z.string().max(200).optional(), diagnosis: z.union([
      z.object({ kind: z.literal('path-hidden'), role: z.enum(['command', 'argument']), index: z.number().int().min(-1).max(1_024), path: z.string().max(4_096),
        target: z.string().max(4_096).optional() }).strict(),
      z.object({ kind: z.enum(['package-runner', 'container-daemon']), runner: z.string().max(64) }).strict()]).optional() }).strict() }).strict(),
  z.object({ kind: z.literal('tools-changed'), name: noticeText(64), count }).strict(),
  z.object({ kind: z.literal('not-recorded'), name: noticeText(64) }).strict(),
  z.object({ kind: z.literal('not-decided'), name: noticeText(64), code: noticeText(64) }).strict(),
  z.object({ kind: z.literal('grant-refused'), name: noticeText(64), reason: noticeText(64) }).strict(),
  z.object({ kind: z.literal('secret-refused'), name: noticeText(64), key: noticeText(256), scope: noticeText(256), code: noticeText(64) }).strict(),
]);
export type ChatTurnNotice = z.infer<typeof mcpStartNoticeSchema>;
/** The steered lines of one turn: those that joined and those returned unsent; kept with the durable turn so a replay answers the same. */
export const chatTurnSteerOutcomeSchema = z.object({ joined: z.array(chatTurnSteerIdSchema).max(CHAT_TURN_STEER_LINES).readonly(),
  returned: z.array(chatTurnSteerIdSchema).max(CHAT_TURN_STEER_LINES).readonly() }).strict();
export type ChatTurnSteerOutcome = z.infer<typeof chatTurnSteerOutcomeSchema>;
/** The bounded result of a turn: the final answer when it fits the replay bound, never the tool results (they came as events). v30: `notices`
 * (typed, see above) and `steer` — the steered lines that joined the turn and those it returns unsent (the person's to send again). */
export const chatTurnResultSchema = z.object({ schemaVersion: z.literal(1), turnId: identitySchema, finish: finishSchema,
  note: z.string().max(4096).nullable(), rounds: count, toolCalls: count, answer: z.string().nullable(), answerBytes: count,
  replayed: z.boolean(), recorded: z.boolean(), notices: z.array(mcpStartNoticeSchema).max(CHAT_TURN_RESULT_NOTICES).readonly(),
  steer: chatTurnSteerOutcomeSchema }).strict().readonly();
export type ChatTurnResult = z.infer<typeof chatTurnResultSchema>;

/**
 * v30 steer (owner S5): one person line for the caller's own running turn. It joins the turn only at the next model-call boundary, after
 * every tool result of the round; never into an approval or witness wait, never as an answer to a card, never after a cancel. `queued`
 * lines either join (a `message` event with this `steerId`) or come back in the result's `steer.returned`; `not-running` and `full` mean
 * the service kept nothing. A repeated `steerId` is the same line (never added twice). `full` also when one more id could not be returned
 * whole within the turn's result bound.
 */
export const chatTurnSteerSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, turnId: identitySchema, steerId: chatTurnSteerIdSchema,
  content: z.string().min(1) }).strict().readonly();
export type ChatTurnSteer = z.infer<typeof chatTurnSteerSchema>;
export const parseChatTurnSteer = (value: unknown): ChatTurnSteer => chatTurnSteerSchema.parse(value);
export const chatTurnSteerResultSchema = z.object({ schemaVersion: z.literal(1), turnId: identitySchema, steerId: chatTurnSteerIdSchema,
  state: z.enum(['queued', 'not-running', 'full']) }).strict().readonly();
export type ChatTurnSteerResult = z.infer<typeof chatTurnSteerResultSchema>;

/** Cancels the caller's own running turn at once (the same principal that started it); a disconnect cancels at the next write. */
export const chatTurnCancellationSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, turnId: identitySchema }).strict().readonly();
export type ChatTurnCancellation = z.infer<typeof chatTurnCancellationSchema>;
export const parseChatTurnCancellation = (value: unknown): ChatTurnCancellation => chatTurnCancellationSchema.parse(value);
export const chatTurnCancellationResultSchema = z.object({ schemaVersion: z.literal(1), turnId: identitySchema,
  state: z.enum(['cancelling', 'not-running']) }).strict().readonly();
export type ChatTurnCancellationResult = z.infer<typeof chatTurnCancellationResultSchema>;
