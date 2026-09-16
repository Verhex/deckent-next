import { ConfigValidationError, envValue, type DeckentConfig, type Environment } from '../../../../kernel/index.js';
/** Shipped API-mode policy; provider credentials never participate in kernel cache identity. */
export function validateApiMode(config: DeckentConfig, env: Environment): void {
  if (config.mode === 'api' && !envValue(env, 'ANTHROPIC_API_KEY')) throw new ConfigValidationError([{ path: 'ANTHROPIC_API_KEY', reason: 'REQUIRED' }]);
}
