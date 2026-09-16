import { z } from 'zod';
import type { Environment } from '../../platform/index.js';
import { OUTPUT_MODES } from '../../common/index.js';
import { ErrorRegistry } from '../../errors/index.js';
import { SUPPORTED_LANGUAGES } from '../../i18n/index.js';

const providerId = z.string().trim().min(1).nullable();
/** Kernel owns scalar selection, identity and presentation, never package policy schemas. */
export const CORE_SCHEMA = z.object({
  schema_version: z.literal(2),
  language: z.enum(SUPPORTED_LANGUAGES as ['en', 'tr']),
  mode: z.enum(['performance', 'balanced', 'economic', 'api']),
  output_mode: z.enum(OUTPUT_MODES),
  projectName: z.string().min(1),
  max_workers: z.union([z.number().int().min(1).max(100), z.literal('auto')]),
  enforce_principal_assurance: z.boolean(),
  strict_tenant_isolation: z.boolean(),
  tenant_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  deckent_style: z.enum(['sprint', 'task', 'process']),
  auth_mode: z.enum(['subscription', 'api', 'hybrid', 'local']),
  routing_engine: z.literal('v3'),
  spawn_backend: z.enum(['auto', 'docker', 'subprocess', 'tmux']),
  live_trace: z.object({ enabled: z.boolean() }).strict(),
  providers: z.object({ brain: providerId, worker: providerId, fallback: providerId,
    overrides: z.record(z.string()).default({}) }).strict(),
}).strict();
export type CoreConfig = z.infer<typeof CORE_SCHEMA>;
export type DeckentConfig = CoreConfig & Record<string, unknown>;
export interface ConfigSectionOptions {
  /** Called on the authored global/project layers before they are merged. */
  readonly optional?: boolean;
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
