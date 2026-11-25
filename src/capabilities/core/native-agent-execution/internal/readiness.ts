import { headlessDiagnostic, messageText, type DeckentError, type Locale, type MessageKey } from '#platform/index.js';
import type { NativeAgentReadinessReason } from './contract.js';

const REASON_KEYS: Readonly<Record<NativeAgentReadinessReason, { readonly known: MessageKey; readonly unknown: MessageKey }>> = {
  NATIVE_AGENT_CLI_UNAVAILABLE: { known: 'headless.agent.reason.NATIVE_AGENT_CLI_UNAVAILABLE', unknown: 'headless.agent.unknown.cli' },
  NATIVE_AGENT_LOGIN_REQUIRED: { known: 'headless.agent.reason.NATIVE_AGENT_LOGIN_REQUIRED', unknown: 'headless.agent.unknown.login' },
  // Owner B2-5 (2026-11-09): only unknown promises first-message verification; unavailable keeps its refusal.
  NATIVE_AGENT_CAPABILITY_UNSEALED: { known: 'headless.agent.reason.NATIVE_AGENT_CAPABILITY_UNSEALED', unknown: 'headless.agent.unknown.sealed' },
  NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED: { known: 'headless.agent.reason.NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', unknown: 'headless.agent.unknown.tools' },
  NATIVE_AGENT_PLUGIN_UNEXPECTED: { known: 'headless.agent.reason.NATIVE_AGENT_PLUGIN_UNEXPECTED', unknown: 'headless.agent.unknown.plugins' },
  NATIVE_AGENT_BRIDGE_UNAVAILABLE: { known: 'headless.agent.reason.NATIVE_AGENT_BRIDGE_UNAVAILABLE', unknown: 'headless.agent.unknown.bridge' },
  NATIVE_AGENT_ENVIRONMENT_REFUSED: { known: 'headless.agent.reason.NATIVE_AGENT_ENVIRONMENT_REFUSED', unknown: 'headless.agent.unknown.environment' },
};

/** A stream refusal stops only its own turn (owner 2026-11-05); it does not replace a retained readiness observation. */
export function nativeAgentReasonText(reason: NativeAgentReadinessReason, locale: Locale, unknown = false, stopped = false, check?: string | null): string {
  const key = stopped && reason === 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED' ? 'headless.agent.surfaceStopped'
    : REASON_KEYS[reason][unknown ? 'unknown' : 'known'];
  const sentence = messageText(key, locale) ?? key;
  return stopped && check ? `${sentence} (${check})` : sentence;
}

export function nativeAgentPreflightReason(error: unknown): NativeAgentReadinessReason {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'HEADLESS_LOGIN_REQUIRED' ? 'NATIVE_AGENT_LOGIN_REQUIRED'
    : code === 'HEADLESS_CLI_UNAVAILABLE' ? 'NATIVE_AGENT_CLI_UNAVAILABLE'
    : 'NATIVE_AGENT_ENVIRONMENT_REFUSED';
}

export type NativeAgentDiagnostic = DeckentError;

export function nativeAgentContainmentDiagnostic(resolved: boolean): NativeAgentDiagnostic {
  return headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: resolved ? 'agent-resolved-path-outside-roots' : 'agent-path-outside-roots' });
}
