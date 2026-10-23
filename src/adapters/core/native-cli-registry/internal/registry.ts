import { z } from 'zod';
import asset from '../../../../../assets/native-coding/commands.json' with { type: 'json' };
import { nativeCliIds, nativeCliIdSchema, modelUsageEvidenceSchema, NativeCliRegistryError, REASONING_EFFORTS, workerEffortSchema, workspaceHiddenPathsSchema, type WorkerEffort } from '#domain/index.js';

const argument = z.string().min(1).refine(value => !value.includes('\0'));
const flag = z.string().regex(/^--[a-z][a-z-]*$/);
const argumentsSchema = z.array(argument).readonly();
export const nativeCliCapabilitiesSchema = z.object({
  reasoningEffort: z.object({ mode: z.enum(['arguments', 'model-id']), levels: z.array(z.enum(REASONING_EFFORTS)).min(1).readonly(),
    args: argumentsSchema, requiredFlags: z.array(flag).readonly() }).strict().refine(value => new Set(value.levels).size === value.levels.length
      && (value.mode === 'model-id' ? value.args.length === 0 : value.args.some(arg => arg.includes('{effort}')))).readonly().nullable(),
  maxTurns: z.object({ flag, hiddenHelpProbe: z.object({ args: argumentsSchema, refusal: argument }).strict().readonly().nullable() }).strict().readonly().nullable(),
  settings: z.object({ flag }).strict().readonly().nullable(),
  /** How `disabled` discovery is realised. Argv: non-empty `disabledArgs`, the help flags they need and hidden probes whose invalid value must
   * draw the exact parser refusal (a CLI that silently ignores an unknown key would otherwise leave repository instructions on). Checkout
   * (C2, owner Q4 2026-10-23): a CLI without a suppression flag gets a worker checkout without the registry's `instructionSurface` (G1: one
   * list for checkout shaping and the delivery floor; empty `disabledArgs`, no flags, no probes). Null = no `disabled` mode. */
  discovery: z.object({ requiredFlags: z.array(flag).readonly(),
    hiddenProbes: z.array(z.object({ args: argumentsSchema, refusal: argument }).strict().readonly()).max(4).readonly(),
    checkout: z.object({}).strict().readonly().nullable() }).strict()
    .refine(value => value.checkout === null ? value.requiredFlags.length > 0 : value.requiredFlags.length === 0 && value.hiddenProbes.length === 0).readonly().nullable(),
  promptChannel: z.enum(['claude-system-prompt', 'codex-instructions-file', 'inline']),
  // A flag channel passes the report schema through a CLI flag; `final-text-json` has no flag: the schema rides in the prompt and the
  // report is the worker's final answer text (CLIs without a structured-output flag).
  structuredReport: z.union([z.object({ flag, channel: z.enum(['inline-json', 'schema-file']) }).strict().readonly(),
    z.object({ flag: z.null(), channel: z.literal('final-text-json') }).strict().readonly()]).nullable(),
  modelUsageEvidence: modelUsageEvidenceSchema,
  /** Native stdout event format the mounted worker normalizes; selects the normalizer by data, never by adapter id. */
  eventStream: z.enum(['claude-code-stream-json', 'codex-exec-json', 'cursor-agent-stream-json']),
}).strict().readonly();
export type NativeCliCapabilities = z.infer<typeof nativeCliCapabilitiesSchema>;
const positive = z.number().int().positive().safe(), names = z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).readonly(), words = z.array(argument).readonly();
/** S3 headless model step (HEADLESS-0, 2026-10-23): one tool-less, MCP-less turn of the unmodified CLI. Argv, environment, guard expectations and
 * bounds are data; a forbidden flag (fallback model, bare mode, permission bypass, extra config) can never be part of the argv. */
export const nativeCliHeadlessSchema = z.object({ schemaVersion: z.literal(1), revision: argument, source: argument,
  args: z.array(z.string().refine(value => !value.includes('\0'))).readonly(), maxTurns: positive,
  /** S3-3 connect defaults: the login directory under the person's home (owner Q-H1) and the bounded PATH search for the executable. */
  connect: z.object({ configDirDefault: z.string().regex(/^[A-Za-z0-9._-]+$/), configDirSource: argument, pathSearchDirectories: positive, pathSearchTimeoutMs: positive }).strict().readonly(), systemPromptFlag: flag, systemPromptFile: z.string().regex(/^[a-z][a-z0-9.-]*$/),
  forbiddenFlags: z.array(flag).min(1).readonly(),
  /** `hiddenFlags`: options the CLI accepts but its help does not list, each proven by the parser refusing a bad value (every fragment must appear);
   * `max-turns-capability` = the capability's own hidden-help probe (one source). Every other required flag must be listed by help. */
  preflight: z.object({ versionArgs: argumentsSchema, versionPattern: argument, helpArgs: argumentsSchema, authStatusArgs: argumentsSchema, hiddenFlagsSource: argument,
    hiddenFlags: z.array(z.object({ flag, probe: z.union([z.literal('max-turns-capability'), z.object({ args: argumentsSchema, refusal: z.array(argument).min(1).readonly() }).strict().readonly()]) })
      .strict().readonly()).max(8).readonly() }).strict().readonly(),
  auth: z.object({ authMethods: words, apiProviders: words, configDirectoryMatch: z.boolean() }).strict().readonly(),
  env: z.object({ fixed: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().refine(value => !value.includes('\0'))).readonly(), runDir: names,
    configDir: z.string().regex(/^[A-Z][A-Z0-9_]*$/), deny: names.refine(value => value.length > 0) }).strict().readonly(),
  guards: z.object({ apiKeySources: words, permissionMode: argument, plugins: z.array(z.object({ name: argument, path: argument }).strict().readonly()).readonly(),
    lengthStopReasons: words, loginErrors: words, creditsErrors: words, loginStatuses: z.array(positive).readonly(), quotaStatuses: z.array(positive).readonly() }).strict().readonly(),
  limits: z.object({ stdinMaxBytes: positive, maxLineBytes: positive, stderrMaxBytes: positive, preflightTimeoutMs: positive, preflightOutputBytes: positive,
    killGraceMs: positive, responseFramingBytes: positive }).strict().readonly(),
}).strict().refine(value => {
  const built = [...Object.keys(value.env.fixed), ...value.env.runDir, value.env.configDir];
  return new Set(built).size === built.length && !built.some(name => value.env.deny.includes(name))
    && !value.args.some(arg => value.forbiddenFlags.some(forbidden => arg === forbidden || arg.startsWith(forbidden + '=')));
}).readonly();
export type NativeCliHeadless = z.infer<typeof nativeCliHeadlessSchema>;
const commandSchema = z.object({ executable: argument, args: argumentsSchema, modelFlag: flag, helpArgs: argumentsSchema,
  disabledArgs: argumentsSchema.nullable(), coreArgs: argumentsSchema, modelAliases: argumentsSchema,
  capabilities: nativeCliCapabilitiesSchema, headless: nativeCliHeadlessSchema.optional() }).strict().refine(value => (value.disabledArgs === null) === (value.capabilities.discovery === null)
    && (value.capabilities.discovery === null || (value.disabledArgs!.length === 0) === (value.capabilities.discovery.checkout !== null))).readonly();
const registrySchema = z.object({ schemaVersion: z.literal(3), adapters: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), commandSchema)
  .refine(value => Object.keys(value).length > 0).readonly(), instructionSurface: z.object({ hiddenPaths: workspaceHiddenPathsSchema }).strict().readonly() }).strict().readonly();
export { NativeCliRegistryError, REASONING_EFFORTS, workerEffortSchema, type WorkerEffort };
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

/** The CLI whose event stream is `protocolFamily` and that declares a headless model step; selected by data, never by a CLI name. */
export function nativeCliHeadless(protocolFamily: string) {
  const found = Object.values(registry.adapters).filter(command => command.headless && command.capabilities.eventStream === protocolFamily);
  return found.length === 1 ? { command: found[0]!, headless: found[0]!.headless! } : null;
}
/** Generic registry interpolation only; the compiler and binding guard share the exact argv segment. */
export function nativeEffortArgs(capability: NativeCliCapabilities['reasoningEffort'], input: WorkerEffort): readonly string[] {
  const selection = workerEffortSchema.parse(input);
  if (selection.level === null) return [];
  if (!capability || !capability.levels.includes(selection.level)) throw new NativeCliRegistryError();
  return capability.args.map(arg => arg.replaceAll('{effort}', selection.level!));
}
