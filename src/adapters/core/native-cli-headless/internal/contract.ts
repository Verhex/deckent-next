import { NATIVE_CLI_HEADLESS_ADAPTER_ID } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
export { nativeCliHeadlessDefinitionSchema, nativeAgentExecutionSchema, nativeAgentReadinessReasonSchema, nativeAgentReadinessSchema } from '#capabilities/index.js';
export type { NativeCliHeadlessDefinition, NativeAgentExecution, NativeAgentReadinessReason, NativeAgentReadiness } from '#capabilities/index.js';

/** S3 headless model step: the unmodified CLI as one tool-less, MCP-less turn behind the model-invocation port (design S3 rev 2). */
export const NATIVE_CLI_HEADLESS_ADAPTER = Object.freeze({ id: NATIVE_CLI_HEADLESS_ADAPTER_ID, version: 1 });
export const isNativeCliHeadlessAdapter = (adapter: Readonly<{ id: string; version: number }>) =>
  adapter.id === NATIVE_CLI_HEADLESS_ADAPTER.id && adapter.version === NATIVE_CLI_HEADLESS_ADAPTER.version;
/** Typed refusals before any claim (EN/TR family `headless`). Params carry check names only: never a path, account field or output. */
type HeadlessRefusalCode = 'HEADLESS_CLI_UNAVAILABLE' | 'HEADLESS_OWNER_MISMATCH' | 'HEADLESS_PREFLIGHT_FAILED' | 'HEADLESS_LOGIN_REQUIRED' | 'HEADLESS_REQUEST_INVALID'
  | 'HEADLESS_ISOLATION_UNAVAILABLE' | 'HEADLESS_LIMIT_REACHED' | 'HEADLESS_LOGIN_BUSY';
export function refuse(code: HeadlessRefusalCode, params?: Record<string, string>): never { throw ErrorRegistry.createError(code, params ? { params } : undefined); }
export { headlessRejectionBodySchema, type HeadlessRejectionBody } from '#domain/index.js';
