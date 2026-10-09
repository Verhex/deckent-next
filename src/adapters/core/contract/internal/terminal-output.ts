import { modelInvocationProfileSchema, type ModelReference } from '#domain/index.js';
import defaults from './terminal-chat-defaults.json' with { type: 'json' };
import { readTerminalChatConfig } from './terminal.js';

/** Deckent output policy, not a vendor effort/token guarantee. A larger selected cap is explicit intent;
 * otherwise effort can narrow the chat default, never enlarge it to the model's absolute maximum.
 * The same effective number goes to admission, prompt, wire request and spending quote. */
export function effectiveTerminalOutputCap(config: Record<string, unknown>, scopeId: string, reference: ModelReference): number {
  const chat = readTerminalChatConfig(config);
  if (!chat) throw new Error('TERMINAL_CHAT_NOT_CONFIGURED');
  const profiles = (config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles ?? [];
  const profile = profiles.map(input => modelInvocationProfileSchema.parse(input)).find(value => value.scopeId === scopeId
    && value.reference.providerId === reference.providerId && value.reference.providerVersion === reference.providerVersion
    && value.reference.modelId === reference.modelId && value.reference.modelVersion === reference.modelVersion);
  const definition = profile?.adapter.definition;
  const effort = definition?.['effort'] ?? definition?.['reasoningEffort'];
  const mapped = typeof effort === 'string' ? (defaults.effortOutputTokens as Readonly<Record<string, number>>)[effort] : undefined;
  const cap = chat.maxCompletionTokens > defaults.maxCompletionTokens ? chat.maxCompletionTokens : Math.min(chat.maxCompletionTokens, mapped ?? chat.maxCompletionTokens);
  const maximum = definition?.['maxOutputTokens'];
  return typeof maximum === 'number' && Number.isSafeInteger(maximum) && maximum > 0 ? Math.min(cap, maximum) : cap;
}
