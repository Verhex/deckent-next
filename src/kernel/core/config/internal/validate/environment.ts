import { envValue, type Environment } from '../../../platform/index.js';
import type { DeckentConfig } from '../schema.js';
import { resolveMode } from './aliases.js';
import { ConfigValidationError } from './issues.js';
export function applyConfigEnvironment(config: DeckentConfig, env: Environment): DeckentConfig {
  const next = structuredClone(config);
  const brain = envValue(env, 'DECKENT_BRAIN_PROVIDER'), worker = envValue(env, 'DECKENT_WORKER_PROVIDER');
  if (brain) next.providers.brain = brain;
  if (worker) next.providers.worker = worker;
  const mode = envValue(env, 'DECKENT_MODE');
  if (mode) next.mode = resolveMode(mode) as DeckentConfig['mode'];
  const language = envValue(env, 'DECKENT_LANGUAGE') ?? envValue(env, 'DECKENT_LANG');
  if (language) next.language = language as DeckentConfig['language'];
  const style = envValue(env, 'DECKENT_STYLE');
  if (style) next.deckent_style = style as DeckentConfig['deckent_style'];
  const trace = envValue(env, 'DECKENT_LIVE_TRACE');
  if (trace) {
    if (!['0', '1', 'true', 'false'].includes(trace)) throw new ConfigValidationError([{ path: 'DECKENT_LIVE_TRACE', reason: 'BOOLEAN_REQUIRED' }]);
    next.live_trace.enabled = trace === '1' || trace === 'true';
  }
  return next;
}
