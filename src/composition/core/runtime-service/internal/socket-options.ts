import type { LocalRuntimeSocketOptions } from '#adapters/index.js';

export function socketOptions(settings: Omit<LocalRuntimeSocketOptions, 'endpoint'>, endpoint: string): LocalRuntimeSocketOptions {
  return { endpoint, maxConnections: settings.maxConnections, inputMaxBytes: settings.inputMaxBytes,
    responseMaxBytes: settings.responseMaxBytes, headerTimeoutMs: settings.headerTimeoutMs };
}
