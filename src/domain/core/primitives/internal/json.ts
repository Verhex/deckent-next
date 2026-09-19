import { z } from 'zod';
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }
export interface JsonValueLimits { readonly maxDepth: number; readonly maxNodes: number; readonly maxCodeUnits: number }
/** Version-1 wire bounds, not evaluator policy or model context limits. */
export const JSON_VALUE_LIMITS = Object.freeze({ maxDepth: 16, maxNodes: 4096, maxCodeUnits: 65536 });
/** Copy plain JSON without invoking property getters. Sorted keys give stable parameter encoding;
 * no RFC canonicalization or cryptographic digest is claimed by this primitive. */
function copyJson(input: unknown, limits: JsonValueLimits): JsonValue {
  let nodes = 0; let units = 0; const ancestors = new Set<object>();
  const invalid = (): never => { throw new Error('JSON_VALUE_INVALID'); };
  const countText = (value: string) => { units += value.length; if (units > limits.maxCodeUnits) invalid(); };
  const visit = (value: unknown, depth: number): JsonValue => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) return invalid();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { countText(value); return value; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) return invalid(); return Object.is(value, -0) ? 0 : value; }
    if (typeof value !== 'object' || ancestors.has(value)) return invalid();
    const array = Array.isArray(value); const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) return invalid();
    ancestors.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some(key => typeof key !== 'string')) return invalid();
      if (array) {
        const length = descriptors['length']?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > limits.maxNodes || keys.length !== length + 1) return invalid();
        const result: JsonValue[] = [];
        for (let index = 0; index < length; index++) {
          const entry = descriptors[String(index)];
          if (!entry || !('value' in entry) || !entry.enumerable) return invalid();
          result.push(visit(entry.value, depth + 1));
        }
        return Object.freeze(result);
      }
      const entries: [string, JsonValue][] = [];
      for (const key of (keys as string[]).sort()) {
        const entry = descriptors[key]!;
        if (!('value' in entry) || !entry.enumerable) return invalid();
        countText(key); entries.push([key, visit(entry.value, depth + 1)]);
      }
      return Object.freeze(Object.fromEntries(entries));
    } finally { ancestors.delete(value); }
  };
  return visit(input, 0);
}
export function createImmutableJsonObjectSchema(inputLimits: JsonValueLimits) {
  const limits = Object.freeze({ ...inputLimits });
  if (![limits.maxDepth, limits.maxNodes, limits.maxCodeUnits].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('JSON_VALUE_LIMITS_INVALID');
  }
  return z.unknown().transform((input, context): JsonObject => {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('JSON_VALUE_INVALID');
      return copyJson(input, limits) as JsonObject;
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'JSON_VALUE_INVALID' });
      return z.NEVER;
    }
  });
}
export const immutableJsonObjectSchema = createImmutableJsonObjectSchema(JSON_VALUE_LIMITS);
