import type { InferenceServingProfile, ModelInvocationCommand } from '#domain/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { completeInferenceChatTurn, type InferenceChatMessage } from '#engine/index.js';
import { invokeConfiguredModel } from '#composition/core/model-invocation/index.js';
import { extractOpenAiChatTextFromInvocation } from './extract-text.js';
import { TERMINAL_CHAT_INVOKE_PAYLOAD_MISSING } from './block.js';

export type TerminalChatBackend = 'inference_http' | 'invoke_model';

export interface TerminalChatTurnInput {
  readonly projectRoot: string;
  readonly profile: InferenceServingProfile;
  readonly messages: readonly InferenceChatMessage[];
  readonly backend: TerminalChatBackend;
  readonly scopeId?: string;
  readonly modelInvocation?: ModelInvocationCommand;
  readonly options?: ConfigLoadOptions;
  readonly signal?: AbortSignal;
}

/** Single turn owner: managed invoke_model; inference_http only when explicitly configured. */
export async function completeTerminalChatTurn(input: TerminalChatTurnInput): Promise<string> {
  if (input.backend === 'invoke_model') {
    if (!input.modelInvocation) throw new Error(TERMINAL_CHAT_INVOKE_PAYLOAD_MISSING);
    const outcome = await invokeConfiguredModel(input.projectRoot, input.modelInvocation, input.options ?? {}, input.signal);
    const text = extractOpenAiChatTextFromInvocation(outcome);
    if (text) return text;
    throw new Error('TERMINAL_CHAT_INVOKE_EMPTY');
  }
  if (input.backend !== 'inference_http') throw new Error('TERMINAL_CHAT_BACKEND_UNSUPPORTED');
  return completeInferenceChatTurn(input.profile, input.messages, input.signal);
}
