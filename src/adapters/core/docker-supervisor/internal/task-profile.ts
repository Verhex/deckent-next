import { z } from 'zod';
import { createHash } from 'node:crypto';
import { dockerOutputFilesSchema } from './output-files.js';
import { dockerReadOnlyMountsSchema } from './mounts.js';
import { environmentRequirementsSchema, executionProfileDefinitionSchema, frozenHiddenPaths, type ExecutionProfileDefinition } from '#domain/index.js';
import { DOCKER_EXECUTION_SETTINGS } from '#platform/index.js';
import { nativeSubscriptionSchema } from '#adapters/core/native-connection/index.js';
import { nativeCliAppServer } from '#adapters/core/native-cli-registry/index.js';

const person = z.object({ issuer: z.string().min(1).max(256), subject: z.string().min(1).max(256) }).strict().readonly();
/** U9-7 (v1): the worker's model traffic goes through the person's own Sign in with ChatGPT connection via the private host relay, never through a
 * credential in the worker. Nonsecret only: the connection and the person whose plan it is. Instruction discovery is the compiled native profile's
 * own (U9F: no relay-specific hidden set; one resolver, `frozenHiddenPaths`). */
export const siwcWorkerProfileSchema = z.object({ schemaVersion: z.literal(1), connectionId: z.string().uuid(), owner: person }).strict().readonly();

const dockerTaskProfileParametersSchema = DOCKER_EXECUTION_SETTINGS.omit({ executable: true }).extend({
  nativeSubscription: nativeSubscriptionSchema.optional(), billingAxis: z.literal('local').optional(), siwcWorker: siwcWorkerProfileSchema.optional(),
  outputFiles: dockerOutputFilesSchema.optional(),
  readOnlyMounts: dockerReadOnlyMountsSchema.optional(),
  /** PRE-7: declared environment requirements (registry data), checked by Deckent before the worker starts. */
  environment: environmentRequirementsSchema.optional(),
  argv: z.array(z.string().refine(value => !value.includes(String.fromCharCode(0)))).min(1)
    .refine(argv => (argv[0]?.length ?? 0) > 0).readonly(),
}).strict().readonly();

export class DockerTaskProfileError extends Error {
  constructor(readonly code = 'DOCKER_TASK_PROFILE_INVALID') { super(code); this.name = 'DockerTaskProfileError'; }
}

/** Installed registry validator for task templates. Host executable, workspace and OS identity are
 * supplied later by trusted runtime composition and are never accepted as registry parameters. */
export function validateDockerTaskProfile(input: ExecutionProfileDefinition): undefined {
  resolveDockerTaskProfile(input);
  return undefined;
}

/** Materialize only pinned task data. Host executable and OS/workspace custody stay in composition. */
export function resolveDockerTaskProfile(input: ExecutionProfileDefinition) {
  const profile = executionProfileDefinitionSchema.safeParse(input);
  if (!profile.success || profile.data.adapter.id !== 'docker' || profile.data.adapter.version !== 2) {
    throw new DockerTaskProfileError();
  }
  const parsed = dockerTaskProfileParametersSchema.safeParse(profile.data.parameters);
  if (!parsed.success) throw new DockerTaskProfileError();
  // `billingAxis: 'local'` declares no provider connection (spending class only); a subscription binding opens one, so both are refused.
  const { argv, nativeSubscription, readOnlyMounts, billingAxis, environment, siwcWorker, ...options } = parsed.data;
  if ((billingAxis && nativeSubscription) || (nativeSubscription?.promptDelivery && nativeSubscription.promptDelivery.argvSha256
    !== createHash('sha256').update(JSON.stringify(argv)).digest('hex'))) throw new DockerTaskProfileError();
  // A relay worker runs the pinned model through the embedded app-server of the one CLI that declares it, with the compiled prompt; its own
  // checkout shaping replaces the CLI's (the app-server does not take the exec instruction flags).
  if (siwcWorker && (nativeSubscription?.schemaVersion !== 2 || !nativeSubscription.model || !nativeSubscription.promptDelivery || !nativeSubscription.preflight || nativeSubscription.checkout
    || nativeSubscription.provider !== nativeCliAppServer().id)) throw new DockerTaskProfileError();
  // Project-relative binds stay profile data; trusted composition resolves them to host paths (resolveDockerReadOnlyMounts).
  return Object.freeze({ argv, nativeSubscription, siwcWorker, readOnlyMounts, environment, options: Object.freeze(options) });
}
/** Effect reach of a frozen profile for automatic re-runs (delivery re-attempt, R3 stall retry): a profile this adapter resolves runs with
 * `--network none` and reaches only its workspace and the gateway's model tunnel; anything else is unknown and never re-run. */
export function classifyDockerTaskEffects(profile: ExecutionProfileDefinition): 'workspace-only' | 'unknown' {
  try { resolveDockerTaskProfile(profile); return 'workspace-only'; } catch { return 'unknown'; }
}
/** R3: the deadline a silence policy must stop before, for profiles with a host-observed liveness channel (the native gateway); else null. */
export function dockerTaskSilenceDeadline(profile: ExecutionProfileDefinition): number | null {
  try { const resolved = resolveDockerTaskProfile(profile); return resolved.nativeSubscription ? resolved.options.deadlineMs : null; } catch { return null; }
}
/** C2: a frozen profile's pinned checkout shaping (instruction-surface paths its worker checkout leaves out); null when it has none. */
export function dockerTaskHiddenPaths(profile: ExecutionProfileDefinition): readonly string[] | null {
  try { resolveDockerTaskProfile(profile); return frozenHiddenPaths(profile.parameters); } catch { return null; }
}
