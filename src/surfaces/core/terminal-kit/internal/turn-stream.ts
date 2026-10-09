import type { PanelTurnBinding } from './panel-contract.js';
import type { AgentContextQuality, AgentShellPosture, AgentToolApprovalSettlement, AgentToolCardCall, AgentToolUndo, ApprovalPreviewCutFacts, AgentToolCallStatus, AgentTurnMessage, AgentTurnStreamEvent } from '#domain/index.js';

/** `tool.finished`'s optional `cleanup` (Astra 2124), derived from the agent-turn event rather than importing the agent-tool
 * module directly (`terminal-kit`'s declared dependency is `agent-turn`; `AgentToolCleanup` itself is declared in `agent-tool`). */
type FinishedToolCleanup = Extract<AgentTurnStreamEvent, { readonly kind: 'tool.finished' }>['cleanup'];

/** One chat message as sent to the model for a plain (tool-less) turn. */
export type ChatTurnMessage = Readonly<{ role: 'system' | 'user' | 'assistant'; content: string }>;
/** One message of an agent turn's history: assistant tool calls and tool results included (T-L3). */
export type AgentChatMessage = AgentTurnMessage;

/** A finished read-class tool call's short result summary (TL-B D2), derived by the terminal renderer from the call's own
 * result text in the turn's `message` delta (never a protocol addition — `AgentTurnStreamEvent` carries no such field). */
export type ToolResultSummary =
  | { readonly kind: 'lines'; readonly shown: number; readonly total: number; readonly more: boolean }
  | { readonly kind: 'headings'; readonly shown: number; readonly total: number; readonly more: boolean }
  | { readonly kind: 'matches'; readonly count: number; readonly more: boolean }
  | { readonly kind: 'entries'; readonly count: number }
  | { readonly kind: 'sandbox-none' } | { readonly kind: 'sandbox-degraded' };
/** FA-TRACKED-WARN: git-tracked files a full-access shell call deleted or overwrote, read by the renderer from the trusted leading
 * metadata of the call's own result (`trackedChangesOfToolResult`); protocol v18 carries no field for it (a typed one waits for v19). */
export type ToolTrackedChanges = { readonly deleted: number; readonly overwritten: number };

/**
 * Surface-facing streaming turn contract (S-STREAM, Jev 1370d942). The producer (composition over the runtime protocol)
 * yields deltas in order and ends with exactly one `done`. `reasoning` carries model thinking text for a collapsed,
 * narrated display; it is never treated as the answer. `usage` may arrive once, before `done`. Cancellation is the
 * caller's AbortSignal; a cancelled or failed stream ends with `done` (`cancelled` / `error`) or throws a typed error.
 * Deltas are presentation data: settlement, spend and invocation truth stay with the governed invocation record.
 */
export type TurnDelta =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'usage'; readonly promptTokens: number; readonly completionTokens: number; readonly reasoningTokens: number | null; readonly cache?: { readonly readTokens: number; readonly writeTokens: number; readonly promptTokens: number;
    /** CACHE-SLICE1: the TTL split of the writes and the same-request net cache benefit (USD x 1e10, an estimate; null: unknown). */
    readonly write5mTokens?: number; readonly write1hTokens?: number; readonly netBenefitUsdE10?: number | null } }
  /** An agent tool call: `started` with the engine's target, then `finished` with its typed status and duration (T-L3). `cleanup`
   * (Astra 2124) only ever arrives on a finished host shell call; every other call leaves it undefined. The tool line's pattern-first
   * target and result summary (TL-B D2) are derived by the renderer from the `message` deltas, not carried here. */
  | { readonly kind: 'tool'; readonly phase: 'started' | 'finished'; readonly callId: string; readonly name: string; readonly target: string | null;
    readonly status: AgentToolCallStatus | null; readonly ms: number | null; readonly cleanup?: FinishedToolCleanup }
  /** A message the turn appended: the caller's history continues from exactly these (not rendered). */
  | { readonly kind: 'message'; readonly message: AgentChatMessage }
  /** The round's measured prompt against the window (T-L5); `upper-bound` is shown as approximate. `compacting` (TL-A, derived on the
   * client from this measurement and the engine's own rule, not a wire field): the service summarizes older messages before the round. */
  | { readonly kind: 'context'; readonly promptTokens: number; readonly windowTokens: number | null; readonly quality: AgentContextQuality;
    readonly compacting?: boolean; readonly compactionThresholdTokens?: number }
  /** The history was compacted (T-L5b): `messages` replaces every non-system message of the caller's history. */
  | { readonly kind: 'compacted'; readonly messages: readonly AgentChatMessage[]; readonly replacedMessages: number }
  /** A tool call waits for the owner's decision (T-L4): the surface shows a decision card; the approval binds the exact call. */
  | { readonly kind: 'approval'; readonly phase: 'requested'; readonly callId: string; readonly approvalId: string; readonly revision: number;
    readonly summary: string; readonly preview: string; readonly expiresAt: number;
    /** The standing scopes the service offers on this card (v17; absent on every v16 service) and exactly what they cover. */
    readonly standing?: { readonly scopes: readonly ('session' | 'always')[]; readonly pattern: string };
    /** v19 (B1): the turn's one-time capability (forwarded by the card's y, never shown), the card's risk (null: not declared) and required assurance. */
    readonly decisionCapability?: string; readonly risk?: string | null; readonly requiredAssurance?: string;
    /** v21 (T2-FOLLOWUP): what the card may say about undoing the call, and a shell call's structured posture. */
    readonly undo?: AgentToolUndo; readonly posture?: AgentShellPosture;
    /** v21 (Astra 2431): the card's fields as data and the preview cut's facts (the window never parses the preview). */
    readonly call?: AgentToolCardCall; readonly previewCut?: ApprovalPreviewCutFacts;
    /** T-APPROVAL-WINDOW: the call's tool name and engine target, taken by the client from the same call's `tool.started` (never a wire field). */
    readonly tool?: string; readonly target?: string | null }
  | { readonly kind: 'approval'; readonly phase: 'settled'; readonly callId: string; readonly approvalId: string;
    readonly outcome: AgentToolApprovalSettlement }
  /** Streamed output of a running call (shell): presentation only. */
  | { readonly kind: 'output'; readonly callId: string; readonly stream: 'stdout' | 'stderr'; readonly text: string }
  /** `note` is the engine's deterministic closure text when the turn ended without a model answer. */
  | { readonly kind: 'done'; readonly finish: 'stop' | 'length' | 'cancelled' | 'error'; readonly note?: string | null };

/** `reasoning: 'off'` (`/reasoning off`, protocol v16): the turn asks the model to run without thinking; absent otherwise. */
/** `turn.sessionId` (v16, SCR-A) names the conversation: the service keeps its scratch area across the conversation's turns. */
/** `turn.fullAccess` (v17, MODES-3): the session was launched in full access; absent otherwise. */
/** `turn.reference` (v23, T4 MODEL-SWITCH): the model this session pinned with `/model`; the service uses exactly it or refuses. */
export type WorklineModelReference = Readonly<{ providerId: string; providerVersion: number; modelId: string; modelVersion: number }>;
export type WorklineStreamTurn = (messages: readonly AgentChatMessage[], signal: AbortSignal, turn?: Readonly<{ reasoning?: 'off'; sessionId?: string; fullAccess?: true;
  reference?: WorklineModelReference; onTurnBound?: (binding: PanelTurnBinding) => void }>) => AsyncIterable<TurnDelta>;

/** Collects a stream into the final answer text (for line mode and tests); reasoning is excluded. */
export async function collectTurnText(stream: AsyncIterable<TurnDelta>): Promise<{ readonly text: string; readonly finish: Extract<TurnDelta, { kind: 'done' }>['finish'] | null }> {
  let text = '', finish: Extract<TurnDelta, { kind: 'done' }>['finish'] | null = null;
  for await (const delta of stream) {
    if (delta.kind === 'text') text += delta.text;
    else if (delta.kind === 'done') finish = delta.finish;
  }
  return { text, finish };
}
