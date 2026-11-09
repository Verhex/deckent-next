export { NATIVE_CLI_HEADLESS_ADAPTER, nativeCliHeadlessDefinitionSchema, headlessRejectionBodySchema, isNativeCliHeadlessAdapter } from './internal/contract.js';
export type { NativeCliHeadlessDefinition, HeadlessRejectionBody } from './internal/contract.js';
export { buildHeadlessEnv } from './internal/env.js';
export { createNativeCliHeadlessPort } from './internal/port.js';
export type { NativeCliHeadlessPort } from './internal/port.js';
export { prepareHeadlessConnection, headlessConsent, headlessConnectionAdapter, readHeadlessLogins, readHeadlessSealedVersion } from './internal/connect.js';
/** The CLI headless step a protocol family has (registry data), for callers that shape a request for it. */
export { nativeCliHeadless, nativeCliAgentBridge } from '#adapters/core/native-cli-registry/index.js';
export { headlessOwnedLoginDir, runHeadlessLogin } from './internal/login.js';
export type { HeadlessLoginResult, HeadlessLoginExit } from './internal/login.js';
export { nativeAgentExecutionSchema, nativeAgentReadinessReasonSchema, nativeAgentReadinessSchema } from './internal/contract.js';
export type { NativeAgentExecution, NativeAgentReadinessReason, NativeAgentReadiness } from './internal/contract.js';
export { toolSessionSchema, nativeAgentCorrelationSchema, nativeAgentToolResultSchema } from './internal/agent-port.js';
export type { ToolSession, ToolSessionPort, NativeAgentCorrelation, NativeAgentToolResult, ToolSessionClosure, ToolSessionCancellation, ToolSessionRevocation } from './internal/agent-port.js';
export { nativeAgentInitReason, nativeAgentItemReason } from '#capabilities/index.js';
export { headlessFlagSetDigest, nativeAgentFlagSetDigest } from './internal/env.js'; export { codexAgentArgv, codexAgentTurn, type CodexAgentResultLookup } from './internal/codex-agent.js';

export { withLoginLock as withHeadlessLoginLock, loginLockPath as headlessLoginLockPath } from './internal/login-lock.js';
export { prepareClaudeAgentRun, createClaudeAgentDriver, ClaudeAgentError } from './internal/claude-agent.js';
export type { ClaudeAgentResult, ClaudeAgentDriver } from './internal/claude-agent.js';
export { headlessPreflight } from './internal/preflight.js';
export type { HeadlessPreflight } from './internal/preflight.js';
export { runHeadlessIsolated, headlessIsolationSeal } from './internal/realm.js';
export type { HeadlessSpawn, HeadlessIsolation } from './internal/realm.js';
export { preflightNativeAgent, readNativeAgentObservation } from './internal/agent-observation.js';
export { createNativeAgentDriver } from './internal/agent-driver.js';
