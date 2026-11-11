import { openModelInspection, type ModelInspectionSnapshot } from '#composition/core/model-inspection/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { randomUUID } from 'node:crypto';
import { textOnlyModelInvocationRequest, ModelInvocableNowApplication, inspectModelSwitch, type InvocableModel, type InvocableModels } from '#engine/index.js';
import { terminalTextChatFamilies, isNativeCliHeadlessAdapter, effectiveTerminalOutputCap, WORKSPACE_READ_TOOL_SPECS, OPENAI_CHAT_COMPLETIONS_FAMILY, ANTHROPIC_MESSAGES_FAMILY, SIWC_INFERENCE, type NativeJsonHttpAuthentication } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { application } from './invoke.js';
import { scopedInvocationCredentialResolver } from './credential.js';
import { configuredModelInvocationDeliverySurfaces } from './delivery-audit.js';

/** One fresh scoped read, using invocation's exact target, native preparation, tariff and read-only account capacity.
 * No model send, activation refresh, state initialization or network acquisition. Credentials stay inside their resolver. */
export async function inspectConfiguredInvocableModels(root: string, scopeId: string, options: ConfigLoadOptions = {}, snapshot?: ModelInspectionSnapshot): Promise<InvocableModels> {
  // One read-only snapshot: every model is checked against the same config and policy document (re-reading both per model took ~1 s for 16).
  const ownSnapshot = snapshot === undefined;
  snapshot ??= await openModelInspection(root, scopeId, options);
  try {
    const loaded = await snapshot.context(), config = snapshot.config;
    const context = { ...loaded, policy: contextPolicySource(loaded, loaded.document), freshConfig: async () => config }, catalog = snapshot.declared;
    if (catalog.status !== 'declared') return { schemaVersion: 1, scopeId, models: [] };
    const bindings = snapshot.bindings;
    const targets: Omit<InvocableModel, 'availability'>[] = [];
    for (const provider of catalog.catalog.providers) for (const model of provider.models) {
      const reference = { providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version }, binding = await bindings.inspect(reference);
      targets.push({ reference, label: model.id, nativeId: model.nativeId, catalogRevision: catalog.catalog.revision,
        bindingDigest: binding.status === 'declared' ? binding.binding.digest : '' });
    }
    return await new ModelInvocableNowApplication(async reference => {
      const invocation = application({ context, options, readOnly: true, entry: 'feature', snapshot });
      await inspectModelSwitch(scopeId, reference, {
        commandId: randomUUID, families: [OPENAI_CHAT_COMPLETIONS_FAMILY, ANTHROPIC_MESSAGES_FAMILY, ...terminalTextChatFamilies], tools: WORKSPACE_READ_TOOL_SPECS,
        shapeRequest: (request, definition) => definition.model.protocols.some(protocol => terminalTextChatFamilies.includes(protocol.family)) ? textOnlyModelInvocationRequest(request) : request,
        snapshot: async ref => ({ binding: await bindings.inspect(ref), outputTokens: effectiveTerminalOutputCap(await context.freshConfig(), scopeId, ref) }),
        activate: async () => { throw new Error('read-only'); },
        preview: command => invocation.preview(command, undefined, undefined, {
          surfaces: configuredModelInvocationDeliverySurfaces(config),
          async credentialPresent(profile) {
            // SIWC has no named credential. Preview's native.admit below checks its owner/binding/renewable plan without renewing or exposing it.
            if (profile.adapter.id === SIWC_INFERENCE.adapter.id || isNativeCliHeadlessAdapter(profile.adapter)) return true;
            const definition = profile.adapter.definition as { authentication?: NativeJsonHttpAuthentication; transport?: { authentication?: NativeJsonHttpAuthentication } };
            const authentication = definition.authentication ?? definition.transport?.authentication;
            if (!authentication) return false;
            if (authentication.type === 'none') return true;
            return Boolean(await scopedInvocationCredentialResolver(context, profile, authentication, options, snapshot)(authentication.credentialRef));
          },
        }),
      });
    }).read(scopeId, targets);
  } finally { if (ownSnapshot) snapshot.dispose(); }
}
