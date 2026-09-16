import { ErrorRegistry } from '../../errors/index.js';
import type { DeckentConfig } from './schema.js';
let factory: (() => DeckentConfig) | undefined;
export function registerConfigDefaults(next: () => DeckentConfig): void {
  if (factory && factory !== next) throw ErrorRegistry.createError('CONFIG_SECTION_DUPLICATE', { params: { section: 'defaults' } });
  factory = next;
}
export function resolveConfigDefaults(): DeckentConfig {
  if (!factory) throw ErrorRegistry.createError('CONFIG_SECTION_INVALID', { params: { section: 'defaults' } });
  return structuredClone(factory());
}
