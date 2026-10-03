import { z } from 'zod';
import asset from '../../../../../assets/native-coding/commands.json' with { type: 'json' };
import { nativeCliIds, nativeCliIdSchema, modelUsageEvidenceSchema, NativeCliRegistryError } from '#domain/index.js';

const argument = z.string().min(1).refine(value => !value.includes('\0'));
const flag = z.string().regex(/^--[a-z][a-z-]*$/);
const argumentsSchema = z.array(argument).readonly();
export const nativeCliCapabilitiesSchema = z.object({
  maxTurns: z.object({ flag, hiddenHelpProbe: z.object({ args: argumentsSchema, refusal: argument }).strict().readonly().nullable() }).strict().readonly().nullable(),
  settings: z.object({ flag }).strict().readonly().nullable(),
  promptChannel: z.enum(['claude-system-prompt', 'codex-instructions-file', 'inline']),
  structuredReport: z.object({ flag, channel: z.enum(['inline-json', 'schema-file']) }).strict().readonly().nullable(),
  modelUsageEvidence: modelUsageEvidenceSchema,
}).strict().readonly();
export type NativeCliCapabilities = z.infer<typeof nativeCliCapabilitiesSchema>;
const commandSchema = z.object({ executable: argument, args: argumentsSchema, modelFlag: flag, helpArgs: argumentsSchema,
  disabledArgs: argumentsSchema.nullable(), coreArgs: argumentsSchema, modelAliases: argumentsSchema,
  capabilities: nativeCliCapabilitiesSchema }).strict().readonly();
const registrySchema = z.object({ schemaVersion: z.literal(2), adapters: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), commandSchema)
  .refine(value => Object.keys(value).length > 0).readonly() }).strict().readonly();
export { NativeCliRegistryError };
/** Strict versioned asset loading. Missing capabilities and old assets are errors, never inferred defaults. */
export function parseNativeCliRegistry(input: unknown) {
  const parsed = registrySchema.safeParse(input);
  if (!parsed.success) throw new NativeCliRegistryError();
  return parsed.data;
}
const registry = parseNativeCliRegistry(asset);
export { nativeCliIds, nativeCliIdSchema };
export function nativeCliCommand(provider: z.infer<typeof nativeCliIdSchema>) {
  const parsed = nativeCliIdSchema.safeParse(provider);
  if (!parsed.success || !Object.hasOwn(registry.adapters, parsed.data)) throw new NativeCliRegistryError();
  return registry.adapters[parsed.data]!;
}
