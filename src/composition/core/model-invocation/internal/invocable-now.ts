import { randomUUID } from 'node:crypto';
import { ModelBindingApplication, DeclaredModelsApplication, ModelInvocableNowApplication, inspectModelSwitch, type InvocableModel, type InvocableModels } from '#engine/index.js';
import { effectiveTerminalOutputCap, WORKSPACE_READ_TOOL_SPECS, OPENAI_CHAT_COMPLETIONS_FAMILY, ANTHROPIC_MESSAGES_FAMILY, type NativeJsonHttpAuthentication } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadInvocationContext } from './context.js';
import { application } from './invoke.js';
import { scopedInvocationCredentialResolver } from './credential.js';
import { configuredModelInvocationDeliverySurfaces } from './delivery-audit.js';

/** One fresh scoped read, using invocation's exact target, native preparation, tariff and read-only account capacity.
 * No model send, activation refresh, state initialization or network acquisition. Credentials stay inside their resolver. */
export async function inspectConfiguredInvocableModels(root: string, scopeId: string, options: ConfigLoadOptions = {}): Promise<InvocableModels> {
  const context = await loadInvocationContext(root, scopeId, { ...options, heal: false }, 'read');
  const config = await context.freshConfig(), catalog = await new DeclaredModelsApplication({ async read() { return config['provider_catalog']; } }).inspect();
  if (catalog.status !== 'declared') return { schemaVersion: 1, scopeId, models: [] };
  const bindings = new ModelBindingApplication({ read: async () => (await context.freshConfig())['provider_catalog'] });
  const targets: Omit<InvocableModel, 'availability'>[] = [];
  for (const provider of catalog.catalog.providers) for (const model of provider.models) {
    const reference = { providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version }, binding = await bindings.inspect(reference);
    targets.push({ reference, label: model.id, nativeId: model.nativeId, catalogRevision: catalog.catalog.revision,
      bindingDigest: binding.status === 'declared' ? binding.binding.digest : '' });
  }
  return new ModelInvocableNowApplication(async reference => {
    const invocation = application(context, options, undefined, true);
    await inspectModelSwitch(scopeId, reference, {
      commandId: randomUUID, families: [OPENAI_CHAT_COMPLETIONS_FAMILY, ANTHROPIC_MESSAGES_FAMILY], tools: WORKSPACE_READ_TOOL_SPECS,
      snapshot: async ref => ({ binding: await bindings.inspect(ref), outputTokens: effectiveTerminalOutputCap(await context.freshConfig(), scopeId, ref) }),
      activate: async () => { throw new Error('read-only'); },
      preview: command => invocation.preview(command, undefined, undefined, {
        surfaces: configuredModelInvocationDeliverySurfaces(config),
        async credentialPresent(profile) {
          const definition = profile.adapter.definition as { authentication?: NativeJsonHttpAuthentication; transport?: { authentication?: NativeJsonHttpAuthentication } };
          const authentication = definition.authentication ?? definition.transport?.authentication;
          if (!authentication) return false;
          if (authentication.type === 'none') return true;
          return Boolean(await scopedInvocationCredentialResolver(context, profile, authentication, options)(authentication.credentialRef));
        },
      }),
    });
  }).read(scopeId, targets);
}
