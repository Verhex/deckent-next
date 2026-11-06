import { isDeepStrictEqual } from 'node:util';
import { NATIVE_CLI_HEADLESS_ADAPTER_ID } from '#domain/index.js';
import { nativeCliHeadlessDefinitionSchema, nativeCliWorkerBindingSchema, type NativeCliHeadlessDefinition, type NativeCliWorkerBinding } from '#capabilities/index.js';
import { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
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

/** R9 (owner 2026-11-05): a worker template names a login connection (owner uid + login dir + executable, its capacity identity); an assigned model
 * runs on that login's connected profile for it, with that profile's own definition (state dir, consent) and checks. Null when none is declared. */
export async function connectedModelProfile(config: DeckentConfig, scopeId: string, binding: NativeCliWorkerBinding, model: { channelId: string; modelId: string }) {
  const login = (value: unknown) => { const parsed = nativeCliHeadlessDefinitionSchema.safeParse(value); return parsed.success ? [parsed.data.ownerUid, parsed.data.configDir, parsed.data.executable] : null; };
  for (const profile of modelUseProfiles(config)) {
    if (profile.scopeId !== scopeId || profile.protocol.family !== binding.protocolFamily || profile.reference.providerId !== model.channelId
      || profile.adapter.id !== NATIVE_CLI_HEADLESS_ADAPTER_ID || !isDeepStrictEqual(login(profile.adapter.definition), login(binding.definition))) continue;
    const catalog = await new ModelBindingApplication({ read: async () => config.provider_catalog }).inspect(profile.reference);
    if (catalog.status === 'declared' && catalog.binding.digest === profile.bindingDigest && catalog.definition.model.nativeId === model.modelId)
      return { profileDigest: modelInvocationProfileDigest(profile), definition: nativeCliHeadlessDefinitionSchema.parse(profile.adapter.definition) };
  }
  return null;
}
