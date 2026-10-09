import type { ModelInvocationNativeResponse } from '#domain/index.js';
import { RESPONSES_CONTROLS as CONTROLS } from './responses-controls.js';

export type OpenAiProviderRefusal = Readonly<{ kind: 'provider-refusal'; message: string }>;
export type OpenAiProviderError = Readonly<{ kind: 'invalid-request'; message: string | null; type: string | null; code: string | null; param: string | null }>;
const safeText = (value: unknown): string | null => typeof value === 'string'
  ? value.replace(/\p{Cc}/gu, ' ').slice(0, CONTROLS.errorMessageMaxChars) : null;

/** Only an authorized, retained error body reaches this pure mapper. It never reads keys or infers billing from HTTP status. */
export function mapOpenAiErrorResponse(status: number | null, body?: string | null): OpenAiProviderError | null {
  if (status !== 400) return null;
  const empty: OpenAiProviderError = { kind: 'invalid-request', message: null, type: null, code: null, param: null };
  if (!body || body.length > CONTROLS.continuationMaxBytes) return empty;
  try {
    const value = JSON.parse(Buffer.from(body, 'base64').toString('utf8')) as { error?: unknown };
    const error = value?.error;
    if (!error || typeof error !== 'object' || Array.isArray(error)) return empty;
    const record = error as Record<string, unknown>;
    return { kind: 'invalid-request', message: safeText(record['message']), type: safeText(record['type']),
      code: safeText(record['code']), param: safeText(record['param']) };
  } catch { return empty; }
}

/** A refusal is typed provider output, never hidden reasoning or an empty successful answer. */
export function openAiProviderRefusal(response: ModelInvocationNativeResponse | null): OpenAiProviderRefusal | null {
  const value = response?.native['deckent_responses'] as { refusal?: unknown } | undefined;
  const refusal = value?.refusal as { kind?: unknown; message?: unknown } | null | undefined;
  return refusal?.kind === 'provider-refusal' && typeof refusal.message === 'string'
    ? { kind: 'provider-refusal', message: safeText(refusal.message)! } : null;
}
