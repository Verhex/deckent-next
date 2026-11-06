import { persistedString, persistedUrl, modelUsageEvidenceSchema, NativeCliRegistryError, REASONING_EFFORTS, workerEffortSchema, workspaceHiddenPathsSchema, type WorkerEffort } from '#domain/index.js';
import { z } from 'zod';
import { nativeCliAgentSchema, nativeAgentBridgeSchema } from './registry.js';
import { nativeCliHeadlessSchema } from './headless.js';
const argument = persistedString(z.string().min(1)).refine(value => !value.includes('\0'));
const flag = z.string().regex(/^--[a-z][a-z-]*$/);
const argumentsSchema = z.array(argument).readonly();
export const nativeCliCapabilitiesSchema = z.strictObject({
  reasoningEffort: z.strictObject({ mode: z.enum(['arguments', 'model-id']), levels: z.array(z.enum(REASONING_EFFORTS)).min(1).readonly(),
    args: argumentsSchema, requiredFlags: z.array(flag).readonly() }).refine(value => new Set(value.levels).size === value.levels.length
      && (value.mode === 'model-id' ? value.args.length === 0 : value.args.some(arg => arg.includes('{effort}')))).readonly().nullable(),
  maxTurns: z.strictObject({ flag, hiddenHelpProbe: z.strictObject({ args: argumentsSchema, refusal: argument }).readonly().nullable() }).readonly().nullable(),
  settings: z.strictObject({ flag }).readonly().nullable(),
  /** Disabled discovery is either measured argv/probes or checkout shaping; the registry validates the exclusive forms. */
  discovery: z.strictObject({ requiredFlags: z.array(flag).readonly(),
    hiddenProbes: z.array(z.strictObject({ args: argumentsSchema, refusal: argument }).readonly()).max(4).readonly(),
    checkout: z.strictObject({}).readonly().nullable() })
    .refine(value => value.checkout === null ? value.requiredFlags.length > 0 : value.requiredFlags.length === 0 && value.hiddenProbes.length === 0).readonly().nullable(),
  promptChannel: z.enum(['claude-system-prompt', 'codex-instructions-file', 'inline']),
  // A flag channel passes the report schema through a CLI flag; `final-text-json` has no flag: the schema rides in the prompt and the
  // report is the worker's final answer text (CLIs without a structured-output flag).
  structuredReport: z.union([z.strictObject({ flag, channel: z.enum(['inline-json', 'schema-file']) }).readonly(),
    z.strictObject({ flag: z.null(), channel: z.literal('final-text-json') }).readonly()]).nullable(),
  modelUsageEvidence: modelUsageEvidenceSchema,
  /** Native stdout event format the mounted worker normalizes; selects the normalizer by data, never by adapter id. */
  eventStream: z.enum(['claude-code-stream-json', 'codex-exec-json', 'cursor-agent-stream-json']),
}).readonly();
export type NativeCliCapabilities = z.infer<typeof nativeCliCapabilitiesSchema>;
const commandSchema = z.strictObject({ executable: argument, args: argumentsSchema, modelFlag: flag, helpArgs: argumentsSchema,
  disabledArgs: argumentsSchema.nullable(), coreArgs: argumentsSchema, modelAliases: argumentsSchema,
  capabilities: nativeCliCapabilitiesSchema, headless: nativeCliHeadlessSchema.optional(), agent: nativeCliAgentSchema.optional(),
  /** U9-6: the CLI's app-server subcommand that runs embedded in the isolated worker (one source for worker commands; transport data stays with the relay). */
  appServer: z.strictObject({ args: argumentsSchema.refine(value => value.length > 0), source: persistedUrl(), observedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    support: z.literal('experimental') }).readonly().optional() }).refine(value => (value.disabledArgs === null) === (value.capabilities.discovery === null)
    // A headless step is one bounded turn: by the CLI's turn flag, or (no such flag) by its line guard.
    && (!value.headless || value.headless.turnBound === 'stream' || value.capabilities.maxTurns !== null)
    && (!value.agent || value.headless !== undefined)
    && (value.capabilities.discovery === null || (value.disabledArgs!.length === 0) === (value.capabilities.discovery.checkout !== null))).readonly();
const registrySchema = z.strictObject({ schemaVersion: z.literal(3), adapters: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), commandSchema)
  .refine(value => Object.keys(value).length > 0).readonly(), instructionSurface: z.strictObject({ hiddenPaths: workspaceHiddenPathsSchema }).readonly(),
  agentBridge: nativeAgentBridgeSchema.optional(),
}).refine(value => Object.values(value.adapters).every(command => {
  if (!command.agent) return true;
  const { headless, agent } = command, bridge = value.agentBridge;
  if (!headless || !bridge || headless.env.deny.includes(bridge.tokenEnvName)) return false;
  const inheritedNames = [...Object.keys(headless.env.fixed), ...headless.env.runDir, headless.env.configDir, ...headless.isolation.proxy.env, ...headless.isolation.proxy.clear];
  if (inheritedNames.includes(bridge.tokenEnvName)) return false;
  // The sentinel must use the existing HTTP proxy, including when the host has a NO_PROXY wildcard.
  if (!headless.isolation.proxy.env.includes('HTTP_PROXY') || !['NO_PROXY', 'no_proxy'].every(name => headless.isolation.proxy.clear.includes(name))) return false;
  return agent.transport.kind !== 'claude-mcp' || Object.keys(agent.transport.mcpConfig.server.headers).length === 1
    && Object.hasOwn(agent.transport.mcpConfig.server.headers, bridge.tokenHeaderName);
})).readonly();
/** Strict versioned asset loading. Missing capabilities and old assets are errors, never inferred defaults. */
export function parseNativeCliRegistry(input: unknown) {
  const parsed = registrySchema.safeParse(input);
  if (!parsed.success) throw new NativeCliRegistryError();
  return parsed.data;
}
/** Generic registry interpolation only; the compiler and binding guard share the exact argv segment. */
export function nativeEffortArgs(capability: NativeCliCapabilities['reasoningEffort'], input: WorkerEffort): readonly string[] {
  const selection = workerEffortSchema.parse(input);
  if (selection.level === null) return [];
  if (!capability || !capability.levels.includes(selection.level)) throw new NativeCliRegistryError();
  return capability.args.map(arg => arg.replaceAll('{effort}', selection.level!));
}

