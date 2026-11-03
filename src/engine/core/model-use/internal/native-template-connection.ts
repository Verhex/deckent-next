import { NATIVE_CLI_HEADLESS_ADAPTER_ID } from '#domain/index.js';
import { nativeCliHeadlessDefinitionSchema, nativeCliWorkerBindingSchema, type NativeCliHeadlessDefinition } from '#capabilities/index.js';
import { ErrorRegistry, type DeckentConfig } from '#platform/index.js';
import { modelUseProfiles, resolveModelUse } from './read.js';
import type { ModelUseReadPorts, ModelUseContext } from './ports.js';
import { modelInvocationProfileDigest } from '#engine/core/model-invocation/index.js';

/** A profile selector is not a raw worker binding. Reuse source/person/policy/activation checks before reading the capacity identity. */
export async function resolveNativeTemplateConnection(root: string, config: DeckentConfig, id: string, provider: string,
  reads: ModelUseReadPorts, agent: (family: string) => { id: string } | null,
  resource: (context: ModelUseContext, definition: NativeCliHeadlessDefinition) => Promise<{ resourceKey: string } | null>) {
  const scopeId = config.service.identity?.scopeId ?? (config['terminal'] as { scopeId?: string } | undefined)?.scopeId;
  if (!scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  const profiles = modelUseProfiles(config).filter(profile => profile.id === id && profile.scopeId === scopeId);
  const profile = profiles.length === 1 ? profiles[0] : null;
  if (!profile) throw ErrorRegistry.createError('NATIVE_AGENT_RECONNECT_REQUIRED');
  const entry = agent(profile.protocol.family);
  if (!entry || entry.id !== provider) throw ErrorRegistry.createError('CODING_TEMPLATE_CONNECTION_UNSUPPORTED');
  const definition = nativeCliHeadlessDefinitionSchema.safeParse(profile.adapter.definition);
  if (profile.adapter.id !== NATIVE_CLI_HEADLESS_ADAPTER_ID || !definition.success || !definition.data.sourceBinding) throw ErrorRegistry.createError('NATIVE_AGENT_RECONNECT_REQUIRED');
  const context = await reads.context(root, profile.scopeId);
  await resolveModelUse(reads, root, profile, context.principal, { action: 'pin' });
  const capacity = await resource(context, definition.data);
  if (!capacity) throw ErrorRegistry.createError('NATIVE_AGENT_RECONNECT_REQUIRED');
  // K6b's persisted UUID identifies this login connection across profiles; it is not a new random identity or a credential.
  return nativeCliWorkerBindingSchema.parse({ schemaVersion: 1, connectionId: capacity.resourceKey, resourceKey: capacity.resourceKey,
    protocolFamily: profile.protocol.family, profileDigest: modelInvocationProfileDigest(profile), definition: definition.data });
}
