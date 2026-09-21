import { z } from 'zod';
import { executionProfileDefinitionSchema, type ExecutionProfileDefinition } from '#domain/index.js';
import { validateDockerTaskProfile } from '#adapters/core/docker-supervisor/index.js';
import commands from './commands.json' with { type: 'json' };

// This versioned adapter supports the owner-admitted isolated, unattended coding pilot only.
// Its CLI flags implement native protocols, not mutable permission/model selection policy.
const argument = z.string().min(1).refine(value => !value.includes('\0'));
export const nativeCodingInvocationSchema = z.object({
  schemaVersion: z.literal(1), provider: z.enum(['codex', 'claude', 'cursor']),
  permissionMode: z.literal('unattended'),
  model: argument.refine(value => value.length <= 256 && !value.startsWith('-') && value.trim() === value),
  prompt: argument.refine(value => Buffer.byteLength(value, 'utf8') <= 65_536),
}).strict().readonly();
export type NativeCodingInvocation = z.infer<typeof nativeCodingInvocationSchema>;

export class NativeCodingProfileError extends Error {
  constructor(readonly code: 'NATIVE_CODING_INVOCATION_INVALID' | 'NATIVE_CODING_TEMPLATE_INVALID') {
    super(code); this.name = 'NativeCodingProfileError';
  }
}

/** Pure pre-admission compilation. No execution, login, policy grant or model substitution.
 * Prompts are ordinary task data persisted in argv; never put credentials in this field.
 * Persona/skill instructions, if any, are supplied in the caller's task prompt.
 */
export function compileNativeCodingDockerProfile(template: ExecutionProfileDefinition, input: unknown): ExecutionProfileDefinition {
  const parsed = nativeCodingInvocationSchema.safeParse(input);
  if (!parsed.success) throw new NativeCodingProfileError('NATIVE_CODING_INVOCATION_INVALID');
  try { validateDockerTaskProfile(template); }
  catch { throw new NativeCodingProfileError('NATIVE_CODING_TEMPLATE_INVALID'); }
  const invocation = parsed.data;
  const command = commands[invocation.provider];
  // No shell interpolation. End-of-options keeps even a dash-prefixed prompt as task data.
  const argv = [command.executable, ...command.args, command.modelFlag, invocation.model, '--', invocation.prompt];
  const profile = executionProfileDefinitionSchema.parse({ ...template, parameters: { ...template.parameters, argv,
    nativeSubscription: { schemaVersion: 1, provider: invocation.provider } } });
  validateDockerTaskProfile(profile);
  return profile;
}
