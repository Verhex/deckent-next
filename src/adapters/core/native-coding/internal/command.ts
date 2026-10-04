import { z } from 'zod';
import { executionProfileDefinitionSchema, REASONING_EFFORTS, workerEffortSchema, type WorkerEffort, type ExecutionProfileDefinition } from '#domain/index.js';
import { validateDockerTaskProfile } from '#adapters/core/docker-supervisor/index.js';
import { nativeEffortArgs, nativeCliCommand, nativeCliIdSchema } from '#adapters/core/native-cli-registry/index.js';
import { nativePromptCompositionSchema, composeNativePrompt, promptHash } from './composition.js';
import { assertNativeWorkerBinding } from './binding.js';

// This versioned adapter supports the owner-admitted isolated, unattended coding pilot only.
// Its CLI flags implement native protocols, not mutable permission/model selection policy.
const argument = z.string().min(1).refine(value => !value.includes('\0'));
const modelArgument = argument.refine(value => value.length <= 256 && !value.startsWith('-') && value.trim() === value);
/** v4 (WORKER-CURRENCY-1): the model is a catalog reference — channel id and exact API model id — plus the exact ids of helper models
 * the CLI may use on its own (declared, never passed as flags). Admission checks all of them against the ledger catalog. */
const pinnedModelSchema = z.object({ channelId: z.string().min(1).max(256).refine(value => value.trim() === value), modelId: modelArgument,
  auxiliaryModelIds: z.array(modelArgument).max(8).readonly() }).strict().readonly();
/** Field shape shared with the K3 template (`template.ts`), which omits the per-task fields. */
export const nativeCodingInvocationFields = z.object({
  effort: z.enum(REASONING_EFFORTS).optional(),
  schemaVersion: z.union([z.literal(2), z.literal(3), z.literal(4)]), maxTurns: z.number().int().positive().safe().optional(), provider: nativeCliIdSchema,
  cliVersion: z.string().trim().min(1).max(128).regex(/^[\w .()+-]+$/),
  discovery: z.object({ schemaVersion: z.literal(1), mode: z.enum(['disabled', 'repository']),
    settings: z.object({ disableAllHooks: z.boolean() }).strict().readonly().optional(),
  }).strict().readonly().default({ schemaVersion: 1, mode: 'disabled' }),
  permissionMode: z.literal('unattended'),
  model: z.union([modelArgument, pinnedModelSchema]),
  prompt: argument.refine(value => Buffer.byteLength(value, 'utf8') <= 65_536).optional(),
  composition: nativePromptCompositionSchema.optional(),
}).strict();
export const nativeCodingInvocationSchema = nativeCodingInvocationFields.refine(value => value.schemaVersion >= 3 || value.maxTurns === undefined).refine(value => (value.prompt !== undefined) !== (value.composition !== undefined))
  .refine(value => (value.schemaVersion === 4) === (typeof value.model === 'object')).readonly();
export type NativeCodingInvocation = z.infer<typeof nativeCodingInvocationSchema>;

export class NativeCodingProfileError extends Error {
  constructor(readonly code: 'NATIVE_CODING_INVOCATION_INVALID' | 'NATIVE_CODING_TEMPLATE_INVALID' | 'NATIVE_CODING_DISCOVERY_UNSUPPORTED' | 'NATIVE_CODING_TURN_LIMIT_UNSUPPORTED' | 'NATIVE_CODING_TURN_LIMIT_EXCEEDS_TEMPLATE'
    | 'WORKER_EFFORT_UNSUPPORTED' | 'WORKER_MODEL_ALIAS_REFUSED') {
    super(code); this.name = 'NativeCodingProfileError';
  }
}

/** Pure pre-admission compilation. No execution, login, policy grant or model substitution.
 * Prompts are ordinary task data persisted in argv; never put credentials in this field.
 * Structured composition carries explicit selected content; it never discovers repository instructions.
 */
export function compileNativeCodingDockerProfile(template: ExecutionProfileDefinition, input: unknown, selectedEffort?: WorkerEffort): ExecutionProfileDefinition {
  const parsed = nativeCodingInvocationSchema.safeParse(input);
  if (!parsed.success) throw new NativeCodingProfileError('NATIVE_CODING_INVOCATION_INVALID');
  try { validateDockerTaskProfile(template); }
  catch { throw new NativeCodingProfileError('NATIVE_CODING_TEMPLATE_INVALID'); }
  const invocation = parsed.data;
  const command = nativeCliCommand(invocation.provider);
  if (invocation.maxTurns !== undefined && !command.capabilities.maxTurns) throw new NativeCodingProfileError('NATIVE_CODING_TURN_LIMIT_UNSUPPORTED');
  if (invocation.schemaVersion >= 3 && Number(template.parameters.outputBytes) < 65536) throw new NativeCodingProfileError('NATIVE_CODING_TEMPLATE_INVALID');
  // Owner 2026-09-30: models are pinned by exact id; a CLI alias (data, per CLI) or a moving `-latest` name is refused, never resolved.
  const pinned = typeof invocation.model === 'object' ? invocation.model : null;
  const modelId = pinned ? pinned.modelId : invocation.model as string;
  if ([modelId, ...(pinned?.auxiliaryModelIds ?? [])].some(id => (command.modelAliases as readonly string[]).includes(id) || id.endsWith('-latest'))) {
    throw new NativeCodingProfileError('WORKER_MODEL_ALIAS_REFUSED');
  }
  const reasoningEffort = workerEffortSchema.parse(selectedEffort ?? { schemaVersion: 1, level: invocation.effort ?? null,
    source: invocation.effort === undefined ? 'cli-default' : 'explicit', status: invocation.effort === undefined ? 'cli-default' : 'selected' });
  if (invocation.effort !== undefined && (reasoningEffort.source !== 'explicit' || reasoningEffort.level !== invocation.effort)) throw new NativeCodingProfileError('WORKER_EFFORT_UNSUPPORTED');
  if (reasoningEffort.level !== null && !command.capabilities.reasoningEffort?.levels.includes(reasoningEffort.level)) throw new NativeCodingProfileError('WORKER_EFFORT_UNSUPPORTED');
  const effortArgs = nativeEffortArgs(command.capabilities.reasoningEffort, reasoningEffort);
  const turnArgs = invocation.maxTurns === undefined ? [] : [command.capabilities.maxTurns!.flag, String(invocation.maxTurns)];
  const { mode, settings } = invocation.discovery;
  if ((mode === 'disabled' && !command.disabledArgs)
    || (settings && (!command.capabilities.settings || mode !== 'repository'))) {
    throw new NativeCodingProfileError('NATIVE_CODING_DISCOVERY_UNSUPPORTED');
  }
  const discoveryArgs = mode === 'disabled' ? command.disabledArgs! : [];
  const settingsArgs = settings ? [command.capabilities.settings!.flag, JSON.stringify(settings)] : [];
  const delivery = invocation.composition ? composeNativePrompt(invocation.composition, command.capabilities.promptChannel) : undefined;
  const coreArgs = delivery ? command.coreArgs : [];
  // No shell interpolation. End-of-options keeps even a dash-prefixed prompt as task data.
  const argv = [command.executable, ...command.args, ...turnArgs, ...effortArgs, ...discoveryArgs, ...settingsArgs, ...coreArgs,
    command.modelFlag, modelId, '--', delivery ? '__DECKENT_TASK_PROMPT__' : invocation.prompt!];
  const profile = executionProfileDefinitionSchema.parse({ ...template, parameters: { ...template.parameters, argv,
    nativeSubscription: { schemaVersion: pinned ? 2 : 1, provider: invocation.provider, modelUsageEvidence: command.capabilities.modelUsageEvidence, reasoningEffort, effortMode: command.capabilities.reasoningEffort?.mode ?? null,
      ...(pinned ? { model: { channelId: pinned.channelId, modelId: pinned.modelId, auxiliaryModelIds: [...pinned.auxiliaryModelIds] } } : {}),
      ...(invocation.schemaVersion >= 3 ? { finalReport: { schemaVersion: 1 } } : {}),
      ...(delivery ? { promptDelivery: { ...delivery, argvSha256: promptHash(JSON.stringify(argv)) } } : {}), preflight: {
      schemaVersion: 1, cliVersion: invocation.cliVersion, discovery: mode, helpArgs: command.helpArgs,
      requiredFlags: [...command.args.filter(arg => arg.startsWith('--')), ...turnArgs.filter(arg => arg.startsWith('--')), ...(reasoningEffort.level === null ? [] : command.capabilities.reasoningEffort!.requiredFlags), ...discoveryArgs,
        ...(settings ? [command.capabilities.settings!.flag] : []), ...coreArgs.filter(arg => arg.startsWith('--')), command.modelFlag],
    } } } });
  validateDockerTaskProfile(profile);
  assertNativeWorkerBinding(profile); // the compiler's own output always satisfies the admission binding check
  return profile;
}
