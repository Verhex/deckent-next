import type { InferenceServingProfile } from '#domain/index.js';
import { chatCompletionsUrl } from './openai-endpoints.js';
import { resolveServedModelId } from './openai-models.js';

export type InferenceChatMessage = Readonly<{ role: 'system' | 'user' | 'assistant'; content: string }>;

export async function completeInferenceChatTurn(profile: InferenceServingProfile, messages: readonly InferenceChatMessage[],
  signal?: AbortSignal): Promise<string> {
  const url = chatCompletionsUrl(profile);
  const model = await resolveServedModelId(profile, signal);
  const apiKey = process.env.DECKENT_INFERENCE_API_KEY?.trim();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: Math.min(1024, profile.workload.roleMaxCtx.brain),
      max_completion_tokens: Math.min(1024, profile.workload.roleMaxCtx.brain),
      stream: false,
    }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`INFERENCE_CHAT_HTTP_FAILED:${response.status}:${detail.slice(0, 200)}`);
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
  const message = payload.choices?.[0]?.message;
  const content = (message?.content ?? message?.reasoning_content ?? '').trim();
  if (!content) throw new Error('INFERENCE_CHAT_EMPTY');
  return content;
}
