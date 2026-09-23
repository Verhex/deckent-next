import { z } from 'zod';

/** Largest text carried by one streamed delta; producers split longer text into several deltas. */
export const MODEL_INVOCATION_DELTA_TEXT_MAX = 16_384;

/**
 * Presentation-only observation of a streamed native response (S-STREAM). A delta is never invocation truth:
 * the final governed result (receipt, retained response, settlement) is the only record. `reasoning` is model
 * thinking text and is never the answer.
 */
export const modelInvocationDeltaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(MODEL_INVOCATION_DELTA_TEXT_MAX) }).strict(),
  z.object({ kind: z.literal('reasoning'), text: z.string().min(1).max(MODEL_INVOCATION_DELTA_TEXT_MAX) }).strict(),
]).readonly();
export type ModelInvocationDelta = z.infer<typeof modelInvocationDeltaSchema>;
/** Receives deltas in wire order; it must not throw or block. */
export type ModelInvocationDeltaSink = (delta: ModelInvocationDelta) => void;

/** Splits text into schema-sized deltas without separating a UTF-16 surrogate pair. */
export function splitModelInvocationDelta(kind: ModelInvocationDelta['kind'], text: string): ModelInvocationDelta[] {
  const output: ModelInvocationDelta[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + MODEL_INVOCATION_DELTA_TEXT_MAX, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    output.push(Object.freeze({ kind, text: text.slice(start, end) }));
    start = end;
  }
  return output;
}
