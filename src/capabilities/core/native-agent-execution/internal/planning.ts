import type { NativeAgentToolResult, ToolSessionPort } from './session.js';
import type { KnownSecretSnapshot } from '#platform/index.js';
import policy from './planning-policy.json' with { type: 'json' };

/** Security parameters are package data; the v1 line grammar is a code invariant, shared by both transports. */
export const SAME_TURN_PLANNING_POLICY = Object.freeze(policy);
export const SAME_TURN_CHALLENGE_PREFIX = 'DECKENT-PLAN-CHALLENGE/1 ';
declare const pinIdentity: unique symbol;
/** Object identity from an admitted claim, never serialized or reconstructed from a receipt/token. */
export type SameTurnPlanningPin = Readonly<{ [pinIdentity]: true }>;
export type SameTurnPlanningRefusal = 'stale-terminal' | 'preparation-unsettled' | 'output-truncated' | 'cancelled'
  | 'native-failed' | 'completion-unknown' | 'settings-mismatch';
export interface SameTurnPlanningCall {
  readonly turnId: string; readonly generation: number; readonly callId: string; readonly argsDigest: string;
}
export interface SameTurnPlanningCustody extends SameTurnPlanningCall {
  readonly content: string; readonly bytes: number; readonly resultDigest: string;
}
export interface SameTurnPlanningEnvelope extends SameTurnPlanningCall {
  readonly sessionId: string; readonly messageId: string; readonly parentId: string | null;
  /** K2 splits at the first LF, keeping the LF out of line and EVERY following byte in draft. */
  readonly line: string; readonly draft: string;
}
export interface SameTurnPlanningFinish {
  readonly state: 'normal' | 'length' | 'cancelled' | 'failed' | 'unknown';
  readonly closed: boolean; readonly drained: boolean;
}
/** K1 owns these checks. K2 supplies only observations of the exact native call; never a token-derived pin.
 * Completion includes the CLI's normal-close and process evidence, NOT a provider stop guarantee.
 * Terminal bytes are private until the whole invocation is retained and the engine finalizer completes. */
export interface SameTurnPlanningPort {
  readonly pin: SameTurnPlanningPin | null;
  readonly active: boolean;
  /** K2 supplies its EXISTING configured+bridge credential projector before preparing P. No credential values are exported. */
  bindDeliveryProjection(pin: SameTurnPlanningPin, project: (result: NativeAgentToolResult) => NativeAgentToolResult, known: KnownSecretSnapshot): void;
  bindNativeSession(pin: SameTurnPlanningPin, sessionId: string): void;
  beforeTool(callId: string, argsDigest: string): void;
  /** K2 also gets the host-derived arguments digest here, after matching the observed private result; never re-hash/model-echo it. */
  privateResult(callId: string, content: string): Readonly<{ content: string; publicText: string; call: SameTurnPlanningCall }> | null;
  preparationSettled(pin: SameTurnPlanningPin, custody: SameTurnPlanningCustody): void;
  preparationDelivered(pin: SameTurnPlanningPin, observedEnvelope: NativeAgentToolResult): void;
  terminalEnvelope(pin: SameTurnPlanningPin, envelope: SameTurnPlanningEnvelope): string;
  nativeClosed(pin: SameTurnPlanningPin, finish: SameTurnPlanningFinish): void;
  /** K2 calls AFTER normal close and its existing response redaction, BEFORE constructing/retaining a response. */
  responseBody(pin: SameTurnPlanningPin, projectedBody: string): string;
  abandon(pin: SameTurnPlanningPin, reason: SameTurnPlanningRefusal): void;
}
/** Code-only carrier. Existing session wrappers spread the object and preserve this optional port; wire ToolSession is unchanged. */
export interface SameTurnToolSessionPort extends ToolSessionPort { readonly planning?: SameTurnPlanningPort }
