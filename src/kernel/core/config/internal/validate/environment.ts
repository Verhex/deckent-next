import { envValue, type Environment } from '#kernel/core/platform/index.js';
import type { DeckentConfig } from '../schema.js';
import { CONFIG_FIELDS } from '#kernel/core/config-fields/index.js';
import { ConfigValidationError } from './issues.js';

export function applyConfigEnvironment(config: DeckentConfig, env: Environment): DeckentConfig {
  const next = structuredClone(config);
  for (const [key, field] of Object.entries(CONFIG_FIELDS)) {
    for (const binding of field.environment) {
      const name = binding.names.find(candidate => envValue(env, candidate) !== undefined);
      if (!name) continue;
      const value = envValue(env, name)!;
      let parsed: string | boolean = value;
      if (binding.encoding === 'boolean') {
        if (!['0', '1', 'true', 'false'].includes(value)) throw new ConfigValidationError([{ path: name, reason: 'BOOLEAN_REQUIRED' }]);
        parsed = value === '1' || value === 'true';
      }
      const path = [key, ...(binding.path ?? [])];
      let target: Record<string, unknown> = next;
      for (const part of path.slice(0, -1)) target = target[part] as Record<string, unknown>;
      target[path.at(-1)!] = parsed;
    }
  }
  return next;
}
