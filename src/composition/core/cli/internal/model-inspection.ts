import { openModelInspection } from '#composition/core/model-inspection/index.js';
import { inspectConfiguredModelActivation, inspectConfiguredModelCatalog } from '#composition/core/model-activation/index.js';
import { inspectConfiguredInvocableModels } from '#composition/core/model-invocation/index.js';
import { inspectConfiguredBrainModels } from '#composition/core/run-planner/index.js';
import { describeTerminalChat, inspectConfiguredNativeChat } from '#composition/core/terminal-chat/index.js';
import type { ProviderPanelHost } from '#surfaces/index.js';

/** The window receives only read producers. Every action remains on the ordinary host with fresh inputs. */
export const openConfiguredModelInspection: NonNullable<ProviderPanelHost['openModelInspection']> = async (root, scopeId, options, signal) => {
  const snapshot = await openModelInspection(root, scopeId, options, signal);
  return { config: snapshot.config, dispose: snapshot.dispose, host: {
    inspectDeclaredModels: async () => snapshot.declared,
    inspectModelBinding: async (_root, reference) => snapshot.bindings.inspect(reference),
    inspectModelActivation: (root, query, options) => inspectConfiguredModelActivation(root, query, options, {}, snapshot),
    inspectModelCatalog: (root, query, options) => inspectConfiguredModelCatalog(root, query, options, {}, snapshot),
    inspectInvocableModels: (root, scopeId, options) => inspectConfiguredInvocableModels(root, scopeId, options, snapshot),
    inspectBrainModels: (root, scopeId, options) => inspectConfiguredBrainModels(root, scopeId, options, snapshot),
    describeTerminalChatPlan: (root, options) => describeTerminalChat(root, options, undefined, snapshot),
    inspectSubscriptionReadiness: (root, query, options) => inspectConfiguredNativeChat(root, query, options, snapshot),
  } };
};
