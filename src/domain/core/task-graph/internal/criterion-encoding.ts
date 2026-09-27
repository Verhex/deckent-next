import type { JsonValue } from '#domain/core/primitives/index.js';
import { criterionDefinitionSchema } from './criteria.js';
export const CRITERION_ENCODING_VERSION = 1;
/** Deckent criterion encoding v1: recursive UTF-16 key order, JSON string escaping and ECMAScript
 * finite-number serialization, no whitespace or Unicode normalization. Parameters were copied and
 * bounded by criterionDefinitionSchema. This is a named internal encoding, not an RFC JCS claim.
 * Application hashes UTF-8 bytes of this complete envelope; evaluator code does not choose the digest.
 */
export function encodeDeckentJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(encodeDeckentJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + encodeDeckentJson((value as { readonly [key: string]: JsonValue })[key]!)).join(',') + '}';
}
export function encodeCriterionDefinition(input: unknown): string {
  const definition = criterionDefinitionSchema.parse(input);
  return encodeDeckentJson({ encodingVersion: CRITERION_ENCODING_VERSION, definition });
}
