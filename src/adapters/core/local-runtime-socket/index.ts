export { ServiceFrameDecoder, ServiceFrameError, encodeServiceFrame } from './internal/framing.js';
export type { ServiceFrameErrorCode } from './internal/framing.js';
export { LocalRuntimeSocketError } from './internal/endpoint.js';
export type { LocalRuntimeSocketErrorCode, LocalRuntimeSocketOptions } from './internal/endpoint.js';
export { startLocalRuntimeSocketServer } from './internal/server.js';
export type { LocalRuntimeSocketServer, RuntimeServiceHandler } from './internal/server.js';
export { requestLocalRuntime } from './internal/client.js';
