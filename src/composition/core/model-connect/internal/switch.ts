import { randomUUID } from 'node:crypto';
import type { ModelReference } from '#domain/index.js';
import { inspectModelSwitch, prepareModelSwitch, type ModelSwitchPorts } from '#engine/index.js';
import { readTerminalChatConfig, WORKSPACE_READ_TOOL_SPECS, OPENAI_CHAT_COMPLETIONS_FAMILY, ANTHROPIC_MESSAGES_FAMILY } from '#adapters/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { previewConfiguredModel } from '#composition/core/model-invocation/index.js';
import { admitConfiguredModelActivation } from '#composition/core/model-activation/index.js';
const ports = (root: string, options: ConfigLoadOptions): ModelSwitchPorts => ({
  commandId: randomUUID, families: [OPENAI_CHAT_COMPLETIONS_FAMILY, ANTHROPIC_MESSAGES_FAMILY], tools: WORKSPACE_READ_TOOL_SPECS,
  async snapshot(reference) {
    const chat = readTerminalChatConfig(await loadComposedConfig(root, options) as Record<string, unknown>);
    if (!chat) throw ErrorRegistry.createError('TERMINAL_CHAT_NOT_CONFIGURED');
    return { binding: await inspectModelBinding(root, reference, options), outputTokens: chat.maxCompletionTokens };
  }, preview: command => previewConfiguredModel(root, command, options), activate: command => admitConfiguredModelActivation(root, command, options),
});
export const inspectConfiguredModelReadiness = (root: string, scopeId: string, reference: ModelReference, options: ConfigLoadOptions = {}, reasoning?: 'off') => inspectModelSwitch(scopeId, reference, ports(root, options), reasoning);
export const prepareConfiguredModelSwitch = (root: string, scopeId: string, reference: ModelReference, options: ConfigLoadOptions = {}, reasoning?: 'off') => prepareModelSwitch(scopeId, reference, ports(root, options), reasoning);
