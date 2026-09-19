import { z } from 'zod';
import type { Environment } from '#platform/core/host/index.js';
import { ErrorRegistry } from '#platform/core/errors/index.js';
import { CORE_SCHEMA } from '#platform/core/config-fields/index.js';
export { CORE_SCHEMA } from '#platform/core/config-fields/index.js';

export type CoreConfig = z.infer<typeof CORE_SCHEMA>;
export type DeckentConfig = CoreConfig & Record<string, unknown>;
export interface ConfigSectionOptions {
  /** Called on the authored global/project layers before they are merged. */
  readonly optional?: boolean;
  /** Opaque public data sections can forbid secret interpolation before any resolver reads. */
  readonly secretReferences?: 'allow' | 'forbid';
  /** Pure section semantics, also enforced by config writers before any publication. */
  readonly validateValue?: (value: unknown) => void;
  readonly metadata?: { readonly descriptionKey: string; readonly tier: string; readonly since: string };
  readonly validateEffective?: (config: DeckentConfig, env: Environment) => void;
  readonly validateLayers?: (global: unknown, project: unknown) => void;
}
type Section = { schema: z.AnyZodObject; options: ConfigSectionOptions };
const sections = new Map<string, Section>();
let generation = 0;
export function configRegistryGeneration(): number { return generation; }
export function registerConfigSection(name: string, schema: z.AnyZodObject, options: ConfigSectionOptions = {}): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name) || Object.hasOwn(CORE_SCHEMA.shape, name) || sections.has(name)
    || ['__proto__', 'constructor', 'prototype'].includes(name)) {
    throw ErrorRegistry.createError('CONFIG_SECTION_DUPLICATE', { params: { section: name } });
  }
  if (!(schema instanceof z.ZodObject) || schema._def.unknownKeys !== 'strict'
    || (options.secretReferences !== undefined && !['allow', 'forbid'].includes(options.secretReferences))
    || (options.validateValue !== undefined && typeof options.validateValue !== 'function')) {
    throw ErrorRegistry.createError('CONFIG_SECTION_INVALID', { params: { section: name } });
  }
  sections.set(name, { schema, options: Object.freeze({ ...options }) });
  generation++;
}
/** Snapshot avoids exposing mutation authority through registry iteration. */
export function configSections(): ReadonlyMap<string, Section> { return new Map(sections); }
