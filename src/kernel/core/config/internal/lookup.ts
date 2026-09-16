import { ErrorRegistry } from '../../errors/index.js';
import { isRecord } from '../../utils/index.js';
export function getConfigValue(config: unknown, key: string): unknown {
  let current = config;
  for (const segment of key.split('.')) {
    if (['__proto__', 'prototype', 'constructor'].includes(segment) || !isRecord(current) || !Object.hasOwn(current, segment)) throw ErrorRegistry.createError('CONFIG_KEY_UNKNOWN', { params: { key } });
    current = current[segment];
  }
  return current;
}
