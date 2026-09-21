export { nativeSubscriptionSchema, NativeConnectionError, readLocalNativeCredential, projectNativeCredential } from './internal/credential.js';
export type { NativeSubscription } from './internal/credential.js';
export { openNativeConnection, isPublicNativeAddress } from './internal/gateway.js';
export { inspectNativeClientHello } from './internal/tls-hello.js';
