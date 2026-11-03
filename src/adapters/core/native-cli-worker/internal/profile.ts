import { createHash } from 'node:crypto';
import { z } from 'zod';
import { executionProfileDefinitionSchema, identitySchema, persistedUuid, immutableJsonObjectSchema, type ExecutionProfileDefinition } from '#domain/index.js';
import { nativeCliHeadlessDefinitionSchema } from '#capabilities/index.js';
import { resolveDockerTaskProfile } from '#adapters/core/docker-supervisor/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';

export const NATIVE_CLI_WORKER_ADAPTER = Object.freeze({ id: 'native-cli-worker', version: 1 });
/** Nonsecret connection identity, frozen at witnessed connection/admission; a capability is checked again at dispatch. */
export const nativeCliWorkerBindingSchema = z.strictObject({ schemaVersion: z.literal(1), connectionId: persistedUuid(),
  protocolFamily: identitySchema, profileDigest: z.string().regex(/^[a-f0-9]{64}$/u), resourceKey: identitySchema,
  definition: nativeCliHeadlessDefinitionSchema,
  /** K5 admission snapshot; only trusted composition writes it, fresh resolution checks it at every spawn/tool. */
  modelUsePin: immutableJsonObjectSchema.optional() }).readonly();
export type NativeCliWorkerBinding = z.infer<typeof nativeCliWorkerBindingSchema>;
const parametersSchema = z.strictObject({ schemaVersion: z.literal(1), base: executionProfileDefinitionSchema, binding: nativeCliWorkerBindingSchema }).readonly();
export class NativeCliWorkerError extends Error {
  constructor(readonly code: 'NATIVE_CLI_WORKER_PROFILE_INVALID' | 'NATIVE_CLI_WORKER_UNAVAILABLE') { super(code); this.name = 'NativeCliWorkerError'; }
}
export const isNativeCliWorkerProfile = (profile: ExecutionProfileDefinition) => profile.adapter.id === NATIVE_CLI_WORKER_ADAPTER.id;
/** The base is retained only as admitted task data, never as an alternative execution route. */
export function resolveNativeCliWorkerProfile(input: ExecutionProfileDefinition) {
  const profile = executionProfileDefinitionSchema.safeParse(input);
  if (!profile.success || profile.data.adapter.id !== NATIVE_CLI_WORKER_ADAPTER.id || profile.data.adapter.version !== NATIVE_CLI_WORKER_ADAPTER.version)
    throw new NativeCliWorkerError('NATIVE_CLI_WORKER_PROFILE_INVALID');
  const parameters = parametersSchema.safeParse(profile.data.parameters);
  if (!parameters.success) throw new NativeCliWorkerError('NATIVE_CLI_WORKER_PROFILE_INVALID');
  const { base, binding } = parameters.data, task = resolveDockerTaskProfile(base), entry = nativeCliAgent(binding.protocolFamily);
  if (!entry || task.siwcWorker || task.nativeSubscription?.provider !== entry.id || task.nativeSubscription.schemaVersion !== 2
    || !task.nativeSubscription.promptDelivery || !task.nativeSubscription.model || task.nativeSubscription.model.auxiliaryModelIds.length
    || task.nativeSubscription.preflight?.discovery !== 'disabled') throw new NativeCliWorkerError('NATIVE_CLI_WORKER_PROFILE_INVALID');
  return Object.freeze({ base, binding, entry, ...task });
}
/** Expand beside legacy profiles. No credential access, login refresh or model/route substitution. */
export function createNativeCliWorkerProfile(base: ExecutionProfileDefinition, binding: NativeCliWorkerBinding): ExecutionProfileDefinition {
  const parameters = parametersSchema.parse({ schemaVersion: 1, base, binding });
  const profile = executionProfileDefinitionSchema.parse({ id: `native-cli-worker-${createHash('sha256').update(JSON.stringify(parameters)).digest('hex')}`,
    version: 1, adapter: NATIVE_CLI_WORKER_ADAPTER, parameters });
  resolveNativeCliWorkerProfile(profile); return profile;
}
