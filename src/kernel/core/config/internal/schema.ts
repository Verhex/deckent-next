import { z } from 'zod';
import type { Environment } from '../../platform/index.js';
import { ErrorRegistry } from '../../errors/index.js';
import { CORE_SCHEMA } from '../../config-fields/index.js';
export { CORE_SCHEMA } from '../../config-fields/index.js';

export type CoreConfig = z.infer<typeof CORE_SCHEMA>;
export type DeckentConfig = CoreConfig & Record<string, unknown>;
export interface ConfigSectionOptions {
  /** Called on the authored global/project layers before they are merged. */
  readonly optional?: boolean;
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
  if (!(schema instanceof z.ZodObject) || schema._def.unknownKeys !== 'strict') {
    throw ErrorRegistry.createError('CONFIG_SECTION_INVALID', { params: { section: name } });
  }
  sections.set(name, { schema, options: Object.freeze({ ...options }) });
  generation++;
}
/** Snapshot avoids exposing mutation authority through registry iteration. */
export function configSections(): ReadonlyMap<string, Section> { return new Map(sections); }
