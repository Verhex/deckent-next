import type { z } from 'zod';
import { CONFIG_CONTRACT_SINCE } from '#platform/core/common/index.js';

export type ConfigBinding = { readonly state: 'bound'; readonly consumers: readonly string[] } | { readonly state: 'declared-only'; readonly reason: string };
export type ConfigApplyMode = 'live' | 'restart';
export interface ConfigFieldMetadata {
  readonly descriptionKey: string; readonly tier: string; readonly since: string;
  readonly binding: ConfigBinding; readonly apply: ConfigApplyMode;
}
type EnvironmentBinding = { readonly names: readonly string[]; readonly path?: readonly string[]; readonly encoding?: 'boolean' };
/** One config field declaration; used by fields.ts and the registered field fragments only (lint: config-binding-fragment). */
export function field<T extends z.ZodTypeAny>(descriptionKey: string, binding: ConfigBinding, apply: ConfigApplyMode, schema: T, environment: readonly EnvironmentBinding[] = [], since = CONFIG_CONTRACT_SINCE) {
  return Object.freeze({ schema, environment, metadata: Object.freeze({ descriptionKey, tier: 'core' as const, since, binding: binding.state === 'bound' ? Object.freeze({ ...binding, consumers: Object.freeze([...binding.consumers]) }) : Object.freeze({ ...binding }), apply }) });
}
/** Merges the core fields with the per-writer fragments in order; a field name declared twice fails at load, never last-wins. */
export function mergeConfigFields<A extends object, B extends object, C extends object>(core: A, setup: B, models: C): A & B & C {
  const merged = { ...core } as Record<string, unknown>;
  for (const fragment of [setup, models]) for (const [key, value] of Object.entries(fragment)) {
    if (Object.hasOwn(merged, key)) throw new Error(['CONFIG_FIELD_DUPLICATE', key].join(':'));
    merged[key] = value;
  }
  return merged as A & B & C;
}
