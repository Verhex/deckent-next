export { NATIVE_CLI_HEADLESS_ADAPTER, nativeCliHeadlessDefinitionSchema, headlessRejectionBodySchema, isNativeCliHeadlessAdapter } from './internal/contract.js';
export type { NativeCliHeadlessDefinition, HeadlessRejectionBody } from './internal/contract.js';
export { buildHeadlessEnv } from './internal/env.js';
export { createNativeCliHeadlessPort } from './internal/port.js';
export type { NativeCliHeadlessPort } from './internal/port.js';
export { prepareHeadlessConnection, headlessConsent, headlessConnectionAdapter, readHeadlessLogins } from './internal/connect.js';
/** The CLI headless step a protocol family has (registry data), for callers that shape a request for it. */
export { nativeCliHeadless } from '#adapters/core/native-cli-registry/index.js';
