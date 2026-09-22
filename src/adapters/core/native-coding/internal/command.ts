import { z } from 'zod';
import { executionProfileDefinitionSchema, type ExecutionProfileDefinition } from '#domain/index.js';
import { validateDockerTaskProfile } from '#adapters/core/docker-supervisor/index.js';
import commands from './commands.json' with { type: 'json' };
import { nativePromptCompositionSchema, composeNativePrompt, promptHash } from './composition.js';

// This versioned adapter supports the owner-admitted isolated, unattended coding pilot only.
// Its CLI flags implement native protocols, not mutable permission/model selection policy.
const argument = z.string().min(1).refine(value => !value.includes('\0'));
export const nativeCodingInvocationSchema = z.object({
  schemaVersion: z.literal(2), provider: z.enum(['codex', 'claude', 'cursor']),
  cliVersion: z.string().trim().min(1).max(128).regex(/^[\w .()+-]+$/),
  discovery: z.object({ schemaVersion: z.literal(1), mode: z.enum(['disabled', 'repository']),
    settings: z.object({ disableAllHooks: z.boolean() }).strict().readonly().optional(),
  }).strict().readonly().default({ schemaVersion: 1, mode: 'disabled' }),
  permissionMode: z.literal('unattended'),
  model: argument.refine(value => value.length <= 256 && !value.startsWith('-') && value.trim() === value),
  prompt: argument.refine(value => Buffer.byteLength(value, 'utf8') <= 65_536).optional(),
  composition: nativePromptCompositionSchema.optional(),
}).strict().refine(value => (value.prompt !== undefined) !== (value.composition !== undefined)).readonly();
export type NativeCodingInvocation = z.infer<typeof nativeCodingInvocationSchema>;

export class NativeCodingProfileError extends Error {
  constructor(readonly code: 'NATIVE_CODING_INVOCATION_INVALID' | 'NATIVE_CODING_TEMPLATE_INVALID' | 'NATIVE_CODING_DISCOVERY_UNSUPPORTED') {
    super(code); this.name = 'NativeCodingProfileError';
  }
}

/** Pure pre-admission compilation. No execution, login, policy grant or model substitution.
 * Prompts are ordinary task data persisted in argv; never put credentials in this field.
 * Structured composition carries explicit selected content; it never discovers repository instructions.
 */
export function compileNativeCodingDockerProfile(template: ExecutionProfileDefinition, input: unknown): ExecutionProfileDefinition {
  const parsed = nativeCodingInvocationSchema.safeParse(input);
  if (!parsed.success) throw new NativeCodingProfileError('NATIVE_CODING_INVOCATION_INVALID');
  try { validateDockerTaskProfile(template); }
  catch { throw new NativeCodingProfileError('NATIVE_CODING_TEMPLATE_INVALID'); }
  const invocation = parsed.data;
  const command = commands[invocation.provider];
  const { mode, settings } = invocation.discovery;
  if ((mode === 'disabled' && !command.disabledArgs)
    || (settings && (invocation.provider !== 'claude' || mode !== 'repository'))) {
    throw new NativeCodingProfileError('NATIVE_CODING_DISCOVERY_UNSUPPORTED');
  }
  const discoveryArgs = mode === 'disabled' ? command.disabledArgs! : [];
  const settingsArgs = settings ? ['--settings', JSON.stringify(settings)] : [];
  const delivery = invocation.composition ? composeNativePrompt(invocation.composition, command.coreChannel) : undefined;
  const coreArgs = delivery ? command.coreArgs : [];
  // No shell interpolation. End-of-options keeps even a dash-prefixed prompt as task data.
  const argv = [command.executable, ...command.args, ...discoveryArgs, ...settingsArgs, ...coreArgs,
    command.modelFlag, invocation.model, '--', delivery ? '__DECKENT_TASK_PROMPT__' : invocation.prompt!];
  const profile = executionProfileDefinitionSchema.parse({ ...template, parameters: { ...template.parameters, argv,
    nativeSubscription: { schemaVersion: 1, provider: invocation.provider,
      ...(delivery ? { promptDelivery: { ...delivery, argvSha256: promptHash(JSON.stringify(argv)) } } : {}), preflight: {
      schemaVersion: 1, cliVersion: invocation.cliVersion, discovery: mode, helpArgs: command.helpArgs,
      requiredFlags: [...command.args.filter(arg => arg.startsWith('--')), ...discoveryArgs,
        ...(settings ? ['--settings'] : []), ...coreArgs.filter(arg => arg.startsWith('--')), command.modelFlag],
    } } } });
  validateDockerTaskProfile(profile);
  return profile;
}
