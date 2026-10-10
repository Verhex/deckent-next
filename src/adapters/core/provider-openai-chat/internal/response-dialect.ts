import { z } from 'zod';
import COMPATIBILITY from './request-compatibility.json' with { type: 'json' };
import { OPENAI_CHAT_DEFAULT_DIALECT, openAiChatFinishReasonSchema, type OpenAiChatDialect, type OpenAiChatHttpDefinition } from './contract.js';
/** Existing profiles carry verified provider tariff identity. It supplies response grammar without a profile migration or host-name guess. */
export function responseDialect(definition: OpenAiChatHttpDefinition): OpenAiChatDialect {
  const dialect = definition.dialect ?? OPENAI_CHAT_DEFAULT_DIALECT, tariff = definition.tariff;
  if (tariff.kind !== 'vendor-published') return dialect;
  if (tariff.vendor === 'zai') return { ...dialect, responseObject: 'optional', finishReasons: ['sensitive', 'model_context_window_exceeded', 'network_error'] };
  if (tariff.vendor === 'deepseek') return { ...dialect, finishReasons: ['insufficient_system_resource', 'aborted'] };
  return dialect;
}
/** Published identity also narrows legacy profiles; unsupported choices are never silently changed. */
export function requestToolChoiceAccepted(definition: OpenAiChatHttpDefinition, choice: 'auto' | 'none' | 'required'): boolean {
  const dialect = definition.dialect ?? OPENAI_CHAT_DEFAULT_DIALECT;
  const tariff = definition.tariff;
  const rules: Readonly<Record<string, readonly string[]>> = COMPATIBILITY.toolChoices;
  return dialect.toolChoice.includes(choice) && (tariff.kind !== 'vendor-published' || !Object.hasOwn(rules, tariff.vendor) || rules[tariff.vendor]!.includes(choice));
}
export function finishReasonAccepted(reason: unknown, dialect?: OpenAiChatDialect): boolean {
  return openAiChatFinishReasonSchema.safeParse(reason).success
    || (typeof reason === 'string' && (dialect?.finishReasons as readonly string[] | undefined)?.includes(reason) === true);
}
export const reasoningDetailsSchema = z.array(z.object({ type: z.enum(['reasoning.text', 'reasoning.summary', 'reasoning.encrypted']),
  id: z.string().nullable().optional(), format: z.string().optional(), index: z.number().int().nonnegative().optional(),
  text: z.string().nullable().optional(), summary: z.string().nullable().optional(), data: z.string().nullable().optional(),
  signature: z.string().nullable().optional() }).passthrough());
