import type { AgentToolSpec, JsonObject, ModelActivationCommand, ModelActivationRecord, ModelInvocationCommand, ModelReference } from '#domain/index.js';
import { ModelInvocationError } from '#domain/index.js';
import { ModelInvocationStoreError } from './port.js';
import type { ModelBindingInspection } from '#engine/core/provider-catalog/index.js';

export interface ModelSwitchPreview { readonly command: ModelInvocationCommand; readonly activation: ModelActivationRecord; readonly refreshRequired: boolean }
export interface ModelSwitchPorts {
  snapshot(reference: ModelReference): Promise<{ readonly binding: ModelBindingInspection; readonly outputTokens: number }>;
  preview(command: ModelInvocationCommand): Promise<{ readonly activation: ModelActivationRecord; readonly refreshRequired: boolean }>;
  activate(command: ModelActivationCommand): Promise<unknown>;
  commandId(): string;
  readonly families: readonly string[];
  readonly tools: readonly AgentToolSpec[];
}

/** Non-sending readiness: declared tool capability determines its native shape; adapters retain protocol and price authority.
 * This check cannot guarantee future prompts or remote availability. No model claim or spending reservation. */
export async function inspectModelSwitch(scopeId: string, reference: ModelReference, ports: ModelSwitchPorts, reasoning?: 'off'): Promise<ModelSwitchPreview> {
  const { binding, outputTokens } = await ports.snapshot(reference);
  if (binding.status !== 'declared') throw new ModelInvocationError('MODEL_INVOCATION_BINDING_CONFLICT');
  const protocols = binding.definition.model.protocols.filter(protocol => ports.families.includes(protocol.family));
  if (!protocols.length) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
  if (reasoning === 'off' && !protocols.some(protocol => protocol.capabilities.some(capability => capability.id === 'chat-template-enable-thinking'
    && capability.version === 1 && capability.state === 'supported'))) throw new ModelInvocationStoreError('MODEL_INVOCATION_REASONING_UNSUPPORTED');
  const tools = protocols.some(protocol => protocol.capabilities.some(capability => capability.id === 'tool-calls' && capability.version === 1 && capability.state === 'supported')) ? ports.tools : [];
  const command: ModelInvocationCommand = { schemaVersion: 1, commandId: ports.commandId(), scopeId, reference, catalogRevision: binding.catalogRevision, expectedBinding: binding.binding,
    nativeRequest: { model: binding.definition.model.nativeId, messages: [{ role: 'user', content: ' ' }], max_completion_tokens: outputTokens,
      stream: true, stream_options: { include_usage: true }, ...(reasoning === 'off' ? { chat_template_kwargs: { enable_thinking: false } } : {}), ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: {
        name: tool.name, description: tool.description, parameters: tool.inputSchema } })), tool_choice: 'auto' } : {}) } as unknown as JsonObject };
  return { command, ...await ports.preview(command) };
}

/** Only an already-active identical binding can be refreshed. Existing activate owns policy, revision compare-and-set and durable evidence.
 * A deactivation or changed binding refuses; invoke still requires the exact current activation. */
export async function prepareModelSwitch(scopeId: string, reference: ModelReference, ports: ModelSwitchPorts, reasoning?: 'off'): Promise<void> {
  const preview = await inspectModelSwitch(scopeId, reference, ports, reasoning);
  if (!preview.refreshRequired) return;
  await ports.activate({ schemaVersion: 1, action: 'activate', commandId: ports.commandId(), scopeId, reference,
    expectedRevision: preview.activation.revision, catalogRevision: preview.command.catalogRevision, expectedBinding: preview.command.expectedBinding });
  if ((await inspectModelSwitch(scopeId, reference, ports, reasoning)).refreshRequired) throw new ModelInvocationStoreError('MODEL_INVOCATION_ACTIVATION_CONFLICT');
}
