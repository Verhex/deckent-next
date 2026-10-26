import { z } from 'zod';
import { OpenAiChatHttpError, parseOpenAiChatTextRequest, openAiChatWireObjectSchema } from '#adapters/core/provider-openai-chat/index.js';
import type { HeadlessRejectionBody } from '#domain/index.js';
import { SIWC_INFERENCE as I, SIWC_REQUEST_RULES as R, SIWC_USAGE_ERRORS } from './registry.js';

/** A separate, allowlisted dialect: no API billing fields, server conversation or unsupported preview controls. */
export function siwcResponsesBody(input: unknown) {
  const request = parseOpenAiChatTextRequest(input, { maxOutputTokens: Number.MAX_SAFE_INTEGER });
  if (request.chat_template_kwargs || request.service_tier || request.reasoning_effort && !R.allowedFields.includes('reasoning')
    || request.tool_choice === 'required' && !R.allowedFields.includes('tool_choice')) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  const history: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') history.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
    else if (message.role === 'assistant') {
      if (message.content) history.push({ role: 'assistant', content: message.content });
      for (const call of message.tool_calls ?? []) history.push({ type: 'function_call', call_id: call.id, name: call.function.name,
        namespace: I.namespace.name, arguments: call.function.arguments });
    } else history.push({ role: message.role, content: message.content });
  }
  const instructions = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const candidate = { model: request.model, input: history, ...(instructions ? { instructions } : {}), store: R.store, stream: R.stream,
    ...(request.tools && request.tool_choice !== 'none' ? { tools: [{ type: 'namespace', ...I.namespace,
      tools: request.tools.map(tool => ({ type: 'function', ...tool.function, strict: false })) }] } : {}),
    ...(request.reasoning_effort ? { reasoning: { effort: request.reasoning_effort } } : {}),
    ...(request.tool_choice && R.allowedFields.includes('tool_choice') ? { tool_choice: request.tool_choice } : {}) };
  if (Object.keys(candidate).some(key => !R.allowedFields.includes(key) || R.forbiddenFields.includes(key))) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  return openAiChatWireObjectSchema.parse(candidate);
}

/** Account-specific catalog; preserve server ordering and exact slugs, with no inferred capability or alias. */
export function parseSiwcModels(input: unknown): readonly Readonly<{ slug: string; display_name: string }>[] {
  const copied = openAiChatWireObjectSchema.safeParse(input);
  const parsed = copied.success && z.object({ models: z.array(z.object({ slug: z.string().min(1).max(I.modelFieldMaxChars),
    display_name: z.string().min(1).max(I.modelFieldMaxChars), visibility: z.string().min(1) }).passthrough()).max(I.modelsMaxEntries) }).passthrough().safeParse(copied.data);
  if (!parsed || !parsed.success || Buffer.byteLength(JSON.stringify(copied.data)) > I.modelsMaxBytes
    || new Set(parsed.data.models.map(model => model.slug)).size !== parsed.data.models.length) throw new OpenAiChatHttpError('OPENAI_CHAT_REQUEST_INVALID');
  return Object.freeze(parsed.data.models.filter(model => model.visibility === I.visibility)
    .map(({ slug, display_name }) => Object.freeze({ slug, display_name })));
}
const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** A confirmed code/status pair alone can establish quota. Provider prose and unknown codes are never retained. */
export function siwcRejection(input: unknown, status: number | null): HeadlessRejectionBody | null {
  const error = object(object(input)?.['error']), code = error?.['code'];
  const rule = typeof code === 'string' && Object.hasOwn(SIWC_USAGE_ERRORS, code) ? SIWC_USAGE_ERRORS[code] : undefined;
  if (rule && (status === rule.status || status === null && (rule.refusal === 'usage-unavailable' || rule.refusal === 'service-unavailable'))) {
    const { refusal } = rule;
    if (refusal === 'usage-unavailable' || refusal === 'service-unavailable') return Object.freeze({ schemaVersion: 3, refusal, code: code as string, status });
    if (refusal === 'plan-unavailable') return Object.freeze({ schemaVersion: 2, refusal, status });
    return Object.freeze({ schemaVersion: 1, refusal, status, ...(refusal === 'quota' ? { resetsAtMs: null } : {}) });
  }
  if (status === 503) return Object.freeze({ schemaVersion: 3, refusal: 'service-unavailable', ...(rule ? { code: code as string } : {}), status });
  return status === 401 ? Object.freeze({ schemaVersion: 1, refusal: 'login-required', status }) : null;
}
