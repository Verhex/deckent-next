import { z } from 'zod';
import { createHash } from 'node:crypto';
import { executionProfileDefinitionSchema, immutableJsonObjectSchema, workInputSchema, type WorkerEffort, type ExecutionProfileDefinition } from '#domain/index.js';
import { validateDockerTaskProfile } from '#adapters/core/docker-supervisor/index.js';
import { compileNativeCodingDockerProfile, nativeCodingInvocationFields, NativeCodingProfileError } from './command.js';
import { nativeCliCommand } from '#adapters/core/native-cli-registry/index.js';
import { promptPartSchema } from './composition.js';

/**
 * K3 = A (owner 2026-09-30): a reusable native coding TEMPLATE is an ordinary registry profile of this adapter identity. It holds
 * everything of a prepared profile except the per-task input: the Docker task parameters (no argv, no binding) and the invocation
 * without model, prompt or task text. The Docker resolver refuses this adapter identity, so a template can never run by itself;
 * Run admission compiles it with a task's typed work input through the same pure compiler `coding prepare` uses.
 */
export const NATIVE_CODING_TEMPLATE_ADAPTER = Object.freeze({ id: 'native-coding-template', version: 1 });
const TEMPLATE_ARGV = '__DECKENT_TEMPLATE__';
const templateParametersSchema = z.object({ schemaVersion: z.literal(1), docker: immutableJsonObjectSchema,
  invocation: nativeCodingInvocationFields.omit({ schemaVersion: true, model: true, prompt: true, composition: true, effort: true }).extend({
    composition: z.object({ core: promptPartSchema.optional(), persona: promptPartSchema.optional(),
      skills: z.array(promptPartSchema).max(16).optional(), context: z.array(promptPartSchema).max(8).optional() }).strict().optional(),
  }).strict(),
}).strict();

export const isNativeCodingTemplate = (profile: ExecutionProfileDefinition) => profile.adapter.id === NATIVE_CODING_TEMPLATE_ADAPTER.id;

function parseTemplate(profile: ExecutionProfileDefinition) {
  const parameters = templateParametersSchema.safeParse(profile.parameters);
  if (profile.adapter.version !== NATIVE_CODING_TEMPLATE_ADAPTER.version || !parameters.success
    || 'argv' in parameters.data.docker || 'nativeSubscription' in parameters.data.docker) throw new NativeCodingProfileError('NATIVE_CODING_TEMPLATE_INVALID');
  const { provider, discovery, maxTurns } = parameters.data.invocation, command = nativeCliCommand(provider);
  if ((discovery.mode === 'disabled' && !command.disabledArgs)
    || (discovery.settings && (!command.capabilities.settings || discovery.mode !== 'repository'))) throw new NativeCodingProfileError('NATIVE_CODING_DISCOVERY_UNSUPPORTED');
  if (maxTurns !== undefined && !command.capabilities.maxTurns) throw new NativeCodingProfileError('NATIVE_CODING_TURN_LIMIT_UNSUPPORTED');
  if (Number(parameters.data.docker['outputBytes']) < 65536) throw new NativeCodingProfileError('NATIVE_CODING_TEMPLATE_INVALID');
  // The compiler replaces argv; the placeholder only lets the Docker validator check every other parameter now.
  const docker = executionProfileDefinitionSchema.parse({ id: profile.id, version: profile.version, adapter: { id: 'docker', version: 2 },
    parameters: { argv: [TEMPLATE_ARGV], ...parameters.data.docker } });
  try { validateDockerTaskProfile(docker); } catch { throw new NativeCodingProfileError('NATIVE_CODING_TEMPLATE_INVALID'); }
  return { docker, invocation: parameters.data.invocation };
}
/** Only invocation identity for planning; never task prompts, composition or Docker parameters. */
export function nativeCodingTemplateWorker(profile: ExecutionProfileDefinition) {
  const { provider, cliVersion } = parseTemplate(profile).invocation;
  return { provider, cliVersion };
}
/** Whether a template's worker CLI can honour a per-task `workInput.maxTurns` (registry capability; no provider-specific application logic). */
export function nativeCodingTemplateTurnLimit(profile: ExecutionProfileDefinition): 'supported' | 'unsupported' {
  return nativeCliCommand(parseTemplate(profile).invocation.provider).capabilities.maxTurns ? 'supported' : 'unsupported';
}

/** The Docker task profile a template compiles onto (installation preview reads its image through this). Throws on an invalid template. */
export function nativeCodingTemplateBase(profile: ExecutionProfileDefinition): ExecutionProfileDefinition { return parseTemplate(profile).docker; }

/** Adapter-owned template wire shape and content identity; host configuration supplies every resource and CLI selection. */
export function createNativeCodingTemplate(resourceLimits: unknown, invocation: unknown): ExecutionProfileDefinition {
  const parsed = templateParametersSchema.safeParse({ schemaVersion: 1, docker: resourceLimits, invocation });
  if (!parsed.success) throw new NativeCodingProfileError('NATIVE_CODING_TEMPLATE_INVALID');
  const parameters = immutableJsonObjectSchema.parse(parsed.data);
  const profile = executionProfileDefinitionSchema.parse({ id: `native-coding-template-${createHash('sha256').update(JSON.stringify(parameters)).digest('hex')}`,
    version: 1, adapter: NATIVE_CODING_TEMPLATE_ADAPTER, parameters });
  nativeCodingTemplateBase(profile);
  return profile;
}

/** Deterministic scope text: one repository path per line, in the author's order. A hand-prepared profile with this text is identical. */
export const renderWorkScope = (paths: readonly string[]) => paths.join('\n');

/** Pure admission compilation of template + typed work input: invocation v4 with the exact pinned model, the work input's turn limit
 * (else the template's) and the template's prompt parts plus task/scope/acceptance. Keeps the template id/version as provenance. */
export function compileNativeCodingWorkInput(template: ExecutionProfileDefinition, input: unknown, effort?: WorkerEffort): ExecutionProfileDefinition {
  const workInput = workInputSchema.safeParse(input);
  if (!workInput.success) throw new NativeCodingProfileError('NATIVE_CODING_INVOCATION_INVALID');
  const { docker, invocation: { composition, maxTurns, ...invocation } } = parseTemplate(template);
  const { model, task, scope, acceptance } = workInput.data; const turns = workInput.data.maxTurns ?? maxTurns;
  if (maxTurns !== undefined && turns !== undefined && turns > maxTurns) throw new NativeCodingProfileError('NATIVE_CODING_TURN_LIMIT_EXCEEDS_TEMPLATE');
  return compileNativeCodingDockerProfile(docker, { ...invocation, schemaVersion: 4, ...(turns === undefined ? {} : { maxTurns: turns }),
    ...(workInput.data.effort === undefined ? {} : { effort: workInput.data.effort }),
    model: { channelId: model.channelId, modelId: model.modelId, auxiliaryModelIds: [...model.auxiliaryModelIds] },
    composition: { schemaVersion: 1, ...composition, task, scope: renderWorkScope(scope.paths), acceptance } }, effort);
}

/** Registry code for a refused compilation: exact-model and turn-limit refusals stay typed; anything else is an invalid profile. */
export function nativeCodingRefusalCode(error: unknown): 'WORKER_MODEL_ALIAS_REFUSED' | 'WORKER_EFFORT_UNSUPPORTED' | 'WORK_INPUT_TURN_LIMIT_UNSUPPORTED' | 'WORK_INPUT_TURN_LIMIT_EXCEEDS_TEMPLATE' | 'EXECUTION_PROFILE_INVALID' {
  if (!(error instanceof NativeCodingProfileError)) return 'EXECUTION_PROFILE_INVALID';
  return (error.code === 'WORKER_MODEL_ALIAS_REFUSED' || error.code === 'WORKER_EFFORT_UNSUPPORTED') ? error.code : error.code === 'NATIVE_CODING_TURN_LIMIT_UNSUPPORTED' ? 'WORK_INPUT_TURN_LIMIT_UNSUPPORTED'
    : error.code === 'NATIVE_CODING_TURN_LIMIT_EXCEEDS_TEMPLATE' ? 'WORK_INPUT_TURN_LIMIT_EXCEEDS_TEMPLATE' : 'EXECUTION_PROFILE_INVALID';
}

/** Adapter-owned capability lookup for template/prepared profiles; no provider-specific application logic. */
export function nativeWorkerEffortCapability(profile: ExecutionProfileDefinition) {
  if (isNativeCodingTemplate(profile)) return nativeCliCommand(parseTemplate(profile).invocation.provider).capabilities.reasoningEffort;
  const binding = profile.parameters['nativeSubscription'] as { provider: string };
  return nativeCliCommand(binding.provider).capabilities.reasoningEffort;
}
