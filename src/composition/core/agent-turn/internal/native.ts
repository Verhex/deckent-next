import { isDeepStrictEqual } from 'node:util';
import { ModelInvocationError, NATIVE_CLI_HEADLESS_ADAPTER_ID, type ModelInvocationProfile, type VerifiedPrincipal } from '#domain/index.js';
import { modelInvocationProfileDigest, configuredInvocationProfiles, type ModelInvocationNativePort } from '#engine/index.js';
import { nativeCliAgent, nativeAgentCorrelationKind, createNativeToolBridge, withMcpPrincipal, type NativeToolBridgeLimits } from '#adapters/index.js';
import { type SubscriptionReadinessReader } from '#composition/core/subscription-readiness/index.js';
import type { ClaudeRateLimit, NativeAgentExecution, NativeAgentReadinessReason, ToolSessionPort } from '#capabilities/index.js';
import { type KnownSecretSnapshot, type DeckentConfig } from '#platform/index.js';
/** R8b/R3a: the scope's connected subscription CLIs that can run a worker (registry capability): profile id and its CLI id. */
export const connectedWorkerClis = (config: DeckentConfig, scopeId: string | null | undefined) => configuredInvocationProfiles(config).filter(row => row.scopeId === scopeId && row.adapter.id === NATIVE_CLI_HEADLESS_ADAPTER_ID)
  .flatMap(row => { const agent = nativeCliAgent(row.protocol.family); return agent ? [{ id: row.id, provider: agent.id }] : []; });

type Bridge = Awaited<ReturnType<typeof createNativeToolBridge>>;
/** Code-only fan-in ports. Observations never spawn or confer consent. K5b owns the opaque admission pin. */
export interface NativeChatRuntime {
  readonly readiness: SubscriptionReadinessReader;
  readonly limits: NativeToolBridgeLimits;
  /** No model call; establishes prerequisites only. Never overrides a known surface refusal. */
  preflight?(profile: ModelInvocationProfile, signal: AbortSignal): Promise<void>;
  resolveModelUse(profile: ModelInvocationProfile, actor: VerifiedPrincipal,
    check: { readonly action: 'pin' } | { readonly action: 'recheck'; readonly pin: object }): Promise<object | void | null>;
  /** K2 wraps proposals to correlate Claude tool_use; K3 retains the exact recorded call/result lookup. */
  driver(input: { readonly profile: ModelInvocationProfile; readonly execution: NativeAgentExecution; readonly session: ToolSessionPort; readonly onPaidUsage?: (limit: ClaudeRateLimit, signal?: AbortSignal) => Promise<void>; readonly paidExtraUsage?: 'continue' | 'stop-at-limit' }): Promise<{
    readonly port: ToolSessionPort;
    admit(signal?: AbortSignal): Promise<void>;
    native(bridge: Bridge, secrets: { readonly configured: KnownSecretSnapshot; readonly turn: KnownSecretSnapshot }): ModelInvocationNativePort;
    // R5b: the refused stream check; owner 2026-11-05: unrecognised CLI events the turn went on through (identifier-only facts)
    refusal(): NativeAgentReadinessReason | null; refusalCheck?(): string | null; notices?(): readonly string[];
    close(): Promise<void>;
  }>;
}
/** Bridge lifetime is inside the governed invocation; K1 alone authorizes, executes and settles proposals. */
export async function withNativeChatInvocation<T>(input: { readonly runtime: NativeChatRuntime; readonly profile: ModelInvocationProfile;
  readonly execution: NativeAgentExecution; readonly session: ToolSessionPort; readonly signal: AbortSignal;
  readonly knownSecrets: KnownSecretSnapshot; readonly onPaidUsage?: (limit: ClaudeRateLimit, signal?: AbortSignal) => Promise<void>; readonly paidExtraUsage?: 'continue' | 'stop-at-limit'; recheck(): Promise<void> },
  invoke: (binding: { readonly profileDigest: string; readonly port: ModelInvocationNativePort; admit(signal?: AbortSignal): Promise<void>;
    recheck(): Promise<void>; refusal(): NativeAgentReadinessReason | null; refusalCheck(): string | null; notices(): readonly string[] }) => Promise<T>): Promise<T> {
  const entry = nativeCliAgent(input.profile.protocol.family);
  if (!entry) throw new ModelInvocationError('MODEL_INVOCATION_PROFILE_CONFLICT');
  const recheck = async () => { try { await input.recheck(); } catch (error) { await input.session.revoke(); throw error; } };
  await recheck();
  const session: ToolSessionPort = { ...input.session, propose: (call, correlation, signal) => withMcpPrincipal(async () => {
    await recheck(); return input.session.propose(call, correlation, signal);
  }) };
  const driver = await input.runtime.driver({ profile: input.profile, execution: input.execution, session, ...(input.onPaidUsage ? { onPaidUsage: input.onPaidUsage } : {}), ...(input.paidExtraUsage ? { paidExtraUsage: input.paidExtraUsage } : {}) });
  let bridge: Bridge | undefined;
  try {
    if (!isDeepStrictEqual(driver.port.session, input.session.session)) throw new ModelInvocationError('MODEL_INVOCATION_PROFILE_CONFLICT');
    bridge = await createNativeToolBridge({ port: driver.port, bridge: entry.bridge, limits: input.runtime.limits,
      correlationKind: nativeAgentCorrelationKind(entry), signal: input.signal, knownSecrets: input.knownSecrets });
    const port = driver.native(bridge, { configured: input.knownSecrets, turn: bridge.known });
    return await invoke({ profileDigest: modelInvocationProfileDigest(input.profile), port,
      recheck, refusal: () => driver.refusal(), refusalCheck: () => driver.refusalCheck?.() ?? null, notices: () => driver.notices?.() ?? [], admit: signal => driver.admit(signal) });
  } finally { try { await bridge?.close(); } finally { await driver.close(); } }
}

/** The readiness and current driver's refusal use the same catalog renderer; a stream refusal stops only its own turn (owner 2026-11-05). */
export { nativeAgentReasonText as nativeChatReasonText } from '#capabilities/index.js';
/** Probe errors expose a typed prerequisite reason, never CLI output or credential-bearing error text. */
export { nativeAgentPreflightReason as nativeChatPreflightReason } from '#capabilities/index.js';
