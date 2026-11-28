import { ErrorRegistry } from '#platform/core/errors/index.js';
import { isRecord } from '#platform/core/utils/index.js';
import { isAgentEnvironmentIndex } from './layers.js';
/** A value of the resolved config by key path. K3: an index of `cli.agentEnvironment` is refused, since the effective list is a floor union whose
 * positions are no layer's own index (the one `config set|unset` edits); the whole key returns the effective list. */
export function getConfigValue(config: unknown, key: string): unknown {
  if (isAgentEnvironmentIndex(key)) throw ErrorRegistry.createError('CONFIG_ARRAY_INDEX_INVALID', { params: { key } });
  let current = config;
  for (const segment of key.split('.')) {
    if (['__proto__', 'prototype', 'constructor'].includes(segment) ||
      Array.isArray(current) && (!/^(0|[1-9]\d*)$/.test(segment) || !Number.isSafeInteger(Number(segment))) ||
      (!isRecord(current) && !Array.isArray(current)) || !Object.hasOwn(current, segment)) throw ErrorRegistry.createError('CONFIG_KEY_UNKNOWN', { params: { key } });
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
