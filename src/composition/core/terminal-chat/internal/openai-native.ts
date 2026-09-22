import type { InferenceServingProfile } from '#domain/index.js';
import type { InferenceChatMessage } from '#engine/index.js';

export function buildOpenAiChatNativeRequest(profile: InferenceServingProfile, model: string,
  messages: readonly InferenceChatMessage[]): Record<string, unknown> {
  const maxTokens = Math.min(1024, profile.workload.roleMaxCtx.brain);
  return {
    model,
    messages: messages.map(message => ({ role: message.role, content: message.content })),
    max_tokens: maxTokens,
    max_completion_tokens: maxTokens,
    stream: false,
  };
}
