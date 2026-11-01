import { persistedString } from '#platform/index.js';
import { z } from 'zod';
import instructions from '../../../../../assets/beuser/model-instructions.json' with { type: 'json' };
import { BeuserContractError, beuserSurfaceCommandSchema, type BeuserContext, type BeuserModelRole } from '#engine/index.js';
import { extractOpenAiChatTextFromInvocation, openAiChatStoppedAtLength } from '#adapters/index.js';
type ModelInvocationResult = Parameters<typeof extractOpenAiChatTextFromInvocation>[0];

const registry = z.strictObject({ schemaVersion: z.literal(1), revision: persistedString(z.string().min(1)), language: persistedString(z.string().min(1)),
  walker: persistedString(z.string().min(1)), evaluator: persistedString(z.string().min(1)) }).parse(instructions);
/** Only evaluator messages can contain sealed harness evidence. Persona and screen stay in the data message. */
export function beuserModelMessages(role: BeuserModelRole, input: unknown, evidence?: unknown) {
  return [{ role: 'system' as const, content: `${registry.revision}\n${role === 'beuser-walker' ? registry.walker : registry.evaluator}` },
    { role: 'user' as const, content: JSON.stringify(role === 'beuser-evaluator' ? { input, evidence } : input) }];
}
function modelJson(value: ModelInvocationResult): unknown {
  const text = extractOpenAiChatTextFromInvocation(value);
  if (!text || value.receipt.outcome?.state !== 'responded' || openAiChatStoppedAtLength(value)) throw new BeuserContractError('BEUSER_MODEL_OUTPUT_INVALID');
  // Anchored fence only: no prose extraction, multiple objects or unmarked inline reasoning. Provider reasoning fields are separate.
  const fenced = /^```json\s*\n([\s\S]*?)\n```$/u.exec(text);
  try { return JSON.parse(fenced ? fenced[1]! : text) as unknown; }
  catch { throw new BeuserContractError('BEUSER_MODEL_OUTPUT_INVALID'); }
}
export function decodeBeuserWalkerOutput(value: ModelInvocationResult, binding: BeuserContext['binding']) {
  const parsed = beuserSurfaceCommandSchema.safeParse({ schemaVersion: 1, binding, action: modelJson(value) });
  if (!parsed.success) throw new BeuserContractError('BEUSER_MODEL_OUTPUT_INVALID');
  return parsed.data;
}
const experienceSchema = z.strictObject({ verdict: z.enum(['pass', 'friction', 'fail', 'unknown']), evidenceRefs: z.array(z.string()) });
export function decodeBeuserEvaluatorOutput(value: ModelInvocationResult, evidenceRefs: readonly string[]) {
  const parsed = experienceSchema.safeParse(modelJson(value));
  if (!parsed.success || !parsed.data.evidenceRefs.every(ref => evidenceRefs.includes(ref))) throw new BeuserContractError('BEUSER_MODEL_OUTPUT_INVALID');
  return parsed.data;
}
