export { nativeSubscriptionSchema, NativeConnectionError, readLocalNativeCredential, projectNativeCredential, nativeProviderSpec } from './internal/credential.js';
export type { NativeSubscription } from './internal/credential.js';
export { openNativeConnection, isPublicNativeAddress, nativeWorkerEventRetentionBytes, nativeQuotaPolicy } from './internal/gateway.js';
export { inspectNativeClientHello } from './internal/tls-hello.js';
export { openNativeEgressGateway, nativeEgressLimits, privateSocketDirectory } from './internal/egress.js';
export { validateFinalReport, finalReportJsonSchema, readFinalReportText } from './internal/report.js';
export { parseClaudeStreamLine, parseCodexExecLine, normalizeClaudeLine, normalizeCodexLine, normalizeCursorLine, createCodexState, createCursorState, createClientModelReport, readCodexRolloutModel, createNativeLineObserver, createNormalizerState, flushUnmapped, redactText, secretValues } from './internal/worker.js';
export type { ClaudeStreamLine, CodexExecLine, QuotaPolicy, NormalizerState, CursorNormalizerState, ClientModelReportLimits, ClientModelRead } from './internal/worker.js';
export { nativePromptArguments, nativePreflightCapabilities, nativeReportArguments, nativeReportInstruction } from './internal/worker.js';
export type { NativeWorkerCapabilities } from './internal/worker.js';
// B7 generated mirror entries, exposed for parity/custody checks; product callers use the platform producer.
export { redactForRecord as workerRedactForRecord, redactForDecision as workerRedactForDecision, snapshotKnownSecrets as workerSnapshotKnownSecrets } from './internal/worker.js';
export { tunnelNativeConnect } from './internal/egress.js';
