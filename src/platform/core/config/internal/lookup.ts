import { ErrorRegistry } from '#platform/core/errors/index.js';
import { isRecord } from '#platform/core/utils/index.js';
export function getConfigValue(config: unknown, key: string): unknown {
  let current = config;
  for (const segment of key.split('.')) {
    if (['__proto__', 'prototype', 'constructor'].includes(segment) ||
      Array.isArray(current) && (!/^(0|[1-9]\d*)$/.test(segment) || !Number.isSafeInteger(Number(segment))) ||
      (!isRecord(current) && !Array.isArray(current)) || !Object.hasOwn(current, segment)) throw ErrorRegistry.createError('CONFIG_KEY_UNKNOWN', { params: { key } });
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
