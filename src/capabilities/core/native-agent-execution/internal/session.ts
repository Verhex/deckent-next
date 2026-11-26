import { z } from 'zod';
import { type ToolErrorClass } from '#capabilities/core/agent-tool-result/index.js';
import { agentToolSpecSchema, agentToolOutcomeSchema, identitySchema, persistedString, type AgentToolCall } from '#domain/index.js';
import { CODEX_TOOL_ITEM_RESERVATION } from './readiness.js';

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
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). Session closure fences new calls. Process termination and external effect settlement are separate facts. */
export type ToolSessionClosure = Readonly<{ turnId: string; generation: number; pendingCallIds: readonly string[];
  termination: 'confirmed' | 'unverified'; effects: 'settled' | 'unknown' }>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type ToolSessionCancellation = ToolSessionClosure & Readonly<{ kind: 'cancelled' }>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type ToolSessionRevocation = ToolSessionClosure & Readonly<{ kind: 'revoked' }>;
/** K1 owns call authorization/execution/settlement. K2/K3 and K4 only transport proposals and these results. */
export interface ToolSessionPort {
  readonly session: ToolSession;
  /** Consult the session's current planning fence immediately before releasing a tool result. */
  checkResultDelivery?(call: AgentToolCall): boolean;
  /** Producer-owned terminal cause, independent of the model's final answer. Not accepted from wire input. */
  terminalFailure?(): 'approval-expired' | null;
  /** Generation-local proof from the call recorder. Never inferred from a returned envelope. */
  recordedError?(call: AgentToolCall, result: NativeAgentToolResult): ToolErrorClass | undefined;
  /** The bridge selected this host result after the final response-size and abort checks. */
  selected?(host: NativeAgentToolResult, text: string, live: () => boolean): void;
  propose(call: AgentToolCall, correlation: NativeAgentCorrelation, signal: AbortSignal): Promise<NativeAgentToolResult>;
  cancel(): Promise<ToolSessionCancellation>;
  revoke(): Promise<ToolSessionRevocation>;
  /** Host-only, best effort: a boundary refusal for the turn's or Attempt's refusal audit. Never from wire input; never changes the refusal. */
  observeRefusal?(observation: NativeRefusalObservation): void;
}
// The audit write gate holds the same exact pairs; composition's sink type checks each basis against the domain vocabulary.
type Pair = { source: 'deckent-decision'; basis: 'tool-offer' | 'native-request-replay' | 'native-item-reservation' } | { source: 'cli-reported'; basis: 'cli-permission-denial' };
/** Card R4-C: each Native boundary refusal has fixed tokens (no wire text). `permission-denial` is a CLI report, never a deckent decision. */
const NATIVE_REFUSALS = {
  'tool-unoffered': { source: 'deckent-decision', basis: 'tool-offer', reason: 'NATIVE_BRIDGE_TOOL_UNKNOWN', role: 'tool-surface' },
  'request-replay': { source: 'deckent-decision', basis: 'native-request-replay', reason: 'NATIVE_BRIDGE_REPLAY_CONFLICT', role: 'replay-slot' },
  'item-reservation': { source: 'deckent-decision', basis: 'native-item-reservation', reason: CODEX_TOOL_ITEM_RESERVATION, role: 'item-reservation' },
  'permission-denial': { source: 'cli-reported', basis: 'cli-permission-denial', reason: 'permission-denials', role: 'provider-tool-permission' },
} as const satisfies Record<string, Pair & { reason: string; role: string }>;
export type NativeRefusalObservation = (typeof NATIVE_REFUSALS)[keyof typeof NATIVE_REFUSALS] & Readonly<{ identity: object; tool?: Readonly<{ name: string; version: number }> }>;
/** `identity`: the host-held refused request object (deduplication only, never stored). `name`: the host-offered tool's name; the stored
 * tool is that host spec, omitted for an MCP tool or a name the session did not offer. Never throws into the refusal it observes. */
export function observeNativeRefusal(port: Pick<ToolSessionPort, 'session' | 'observeRefusal'> | undefined, kind: keyof typeof NATIVE_REFUSALS, identity: object, name?: string): void {
  try {
    const tool = port?.session.tools.find(spec => spec.name === name && spec.toolClass !== 'mcp');
    port?.observeRefusal?.({ ...NATIVE_REFUSALS[kind], identity, ...(tool ? { tool: { name: tool.name, version: tool.version } } : {}) });
  } catch { /* best effort: the refusal, its reply and its stop stay as they are */ }
}
