import { isDeepStrictEqual } from 'node:util';
import { ModelInvocationError, type ModelInvocationProfile, type VerifiedPrincipal } from '#domain/index.js';
import type { ModelInvocationNativePort } from '#engine/index.js';
import { modelInvocationProfileDigest } from '#engine/index.js';
import { nativeCliAgent } from '#adapters/index.js';
import { createNativeToolBridge, type NativeToolBridgeLimits } from '#adapters/index.js';
import { withMcpPrincipal } from '#adapters/index.js';
import { type SubscriptionReadinessReader } from '#composition/core/subscription-readiness/index.js';
import type { NativeAgentExecution, NativeAgentReadinessReason, ToolSessionPort } from '#capabilities/index.js';
import { snapshotKnownSecrets, t, type Locale, type KnownSecretSnapshot } from '#platform/index.js';

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
  driver(input: { readonly profile: ModelInvocationProfile; readonly execution: NativeAgentExecution; readonly session: ToolSessionPort }): Promise<{
    readonly port: ToolSessionPort;
    admit(signal?: AbortSignal): Promise<void>;
    native(bridge: Bridge, secrets: { readonly configured: KnownSecretSnapshot; readonly turn: KnownSecretSnapshot }): ModelInvocationNativePort;
    refusal(): NativeAgentReadinessReason | null;
    close(): Promise<void>;
  }>;
}
/** Bridge lifetime is inside the governed invocation; K1 alone authorizes, executes and settles proposals. */
export async function withNativeChatInvocation<T>(input: { readonly runtime: NativeChatRuntime; readonly profile: ModelInvocationProfile;
  readonly execution: NativeAgentExecution; readonly session: ToolSessionPort; readonly signal: AbortSignal;
  readonly knownSecrets: KnownSecretSnapshot; recheck(): Promise<void> },
  invoke: (binding: { readonly profileDigest: string; readonly port: ModelInvocationNativePort; admit(signal?: AbortSignal): Promise<void>;
    recheck(): Promise<void>; refusal(): NativeAgentReadinessReason | null }) => Promise<T>): Promise<T> {
  const entry = nativeCliAgent(input.profile.protocol.family);
  if (!entry) throw new ModelInvocationError('MODEL_INVOCATION_PROFILE_CONFLICT');
  const recheck = async () => { try { await input.recheck(); } catch (error) { await input.session.revoke(); throw error; } };
  await recheck();
  const session: ToolSessionPort = { ...input.session, propose: (call, correlation, signal) => withMcpPrincipal(async () => {
    await recheck(); return input.session.propose(call, correlation, signal);
  }) };
  const driver = await input.runtime.driver({ profile: input.profile, execution: input.execution, session });
  let bridge: Bridge | undefined;
  try {
    if (!isDeepStrictEqual(driver.port.session, input.session.session)) throw new ModelInvocationError('MODEL_INVOCATION_PROFILE_CONFLICT');
    bridge = await createNativeToolBridge({ port: driver.port, bridge: entry.bridge, limits: input.runtime.limits,
      correlationKind: entry.agent.transport.kind === 'claude-mcp' ? 'claude-tool-use' : 'codex-mcp', signal: input.signal, knownSecrets: input.knownSecrets });
    const turn = snapshotKnownSecrets([{ name: bridge.tokenEnvName, value: bridge.turnToken }]);
    const port = driver.native(bridge, { configured: input.knownSecrets, turn });
    return await invoke({ profileDigest: modelInvocationProfileDigest(input.profile), port,
      recheck, refusal: () => driver.refusal(), admit: signal => driver.admit(signal) });
  } finally { try { await bridge?.close(); } finally { await driver.close(); } }
}

/** The readiness and current driver's sticky refusal use the same catalog renderer. */
export const nativeChatReasonText = (reason: NativeAgentReadinessReason, language: Locale, unknown = false): string => unknown ? ({
  NATIVE_AGENT_CLI_UNAVAILABLE: t('headless.agent.k13.unknown.cli', {}, language),
  NATIVE_AGENT_LOGIN_REQUIRED: t('headless.agent.k13.unknown.login', {}, language),
  NATIVE_AGENT_CAPABILITY_UNSEALED: t('headless.agent.reason.NATIVE_AGENT_CAPABILITY_UNSEALED', {}, language),
  NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED: t('headless.agent.k13.unknown.tools', {}, language),
  NATIVE_AGENT_PLUGIN_UNEXPECTED: t('headless.agent.k13.unknown.plugins', {}, language),
  NATIVE_AGENT_BRIDGE_UNAVAILABLE: t('headless.agent.k13.unknown.bridge', {}, language),
  NATIVE_AGENT_ENVIRONMENT_REFUSED: t('headless.agent.k13.unknown.environment', {}, language),
})[reason] : ({
  NATIVE_AGENT_CLI_UNAVAILABLE: t('headless.agent.reason.NATIVE_AGENT_CLI_UNAVAILABLE', {}, language),
  NATIVE_AGENT_LOGIN_REQUIRED: t('headless.agent.reason.NATIVE_AGENT_LOGIN_REQUIRED', {}, language),
  NATIVE_AGENT_CAPABILITY_UNSEALED: t('headless.agent.reason.NATIVE_AGENT_CAPABILITY_UNSEALED', {}, language),
  NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED: t('headless.agent.reason.NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', {}, language),
  NATIVE_AGENT_PLUGIN_UNEXPECTED: t('headless.agent.reason.NATIVE_AGENT_PLUGIN_UNEXPECTED', {}, language),
  NATIVE_AGENT_BRIDGE_UNAVAILABLE: t('headless.agent.reason.NATIVE_AGENT_BRIDGE_UNAVAILABLE', {}, language),
  NATIVE_AGENT_ENVIRONMENT_REFUSED: t('headless.agent.reason.NATIVE_AGENT_ENVIRONMENT_REFUSED', {}, language),
})[reason];

/** Probe errors expose a typed prerequisite reason, never CLI output or credential-bearing error text. */
export function nativeChatPreflightReason(error: unknown): NativeAgentReadinessReason {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'HEADLESS_LOGIN_REQUIRED' ? 'NATIVE_AGENT_LOGIN_REQUIRED'
    : code === 'HEADLESS_CLI_UNAVAILABLE' ? 'NATIVE_AGENT_CLI_UNAVAILABLE'
    : 'NATIVE_AGENT_ENVIRONMENT_REFUSED';
}
