import { createHash } from 'node:crypto';
import { z } from 'zod';
import { executionProfileDefinitionSchema, identitySchema, persistedUuid, immutableJsonObjectSchema, type ExecutionProfileDefinition } from '#domain/index.js';
import { nativeCliHeadlessDefinitionSchema } from './contract.js';

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
export function nativeCliWorkerParameters(input: ExecutionProfileDefinition) {
  const profile = executionProfileDefinitionSchema.safeParse(input);
  if (!profile.success || profile.data.adapter.id !== NATIVE_CLI_WORKER_ADAPTER.id || profile.data.adapter.version !== NATIVE_CLI_WORKER_ADAPTER.version)
    throw new NativeCliWorkerError('NATIVE_CLI_WORKER_PROFILE_INVALID');
  const parameters = parametersSchema.safeParse(profile.data.parameters);
  if (!parameters.success) throw new NativeCliWorkerError('NATIVE_CLI_WORKER_PROFILE_INVALID');
  return parameters.data;
}
export function nativeCliWorkerProfile(base: ExecutionProfileDefinition, binding: NativeCliWorkerBinding): ExecutionProfileDefinition {
  const parameters = parametersSchema.parse({ schemaVersion: 1, base, binding });
  return executionProfileDefinitionSchema.parse({ id: `native-cli-worker-${createHash('sha256').update(JSON.stringify(parameters)).digest('hex')}`,
    version: 1, adapter: NATIVE_CLI_WORKER_ADAPTER, parameters });
}
