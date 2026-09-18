import { expect, it } from 'vitest';
import { criterionDefinitionSchema, immutableJsonObjectSchema, JSON_VALUE_LIMITS } from '#domain/index.js';
const definition = { id: 'receipt-valid', version: 1, description: 'Verify the required receipt', evaluator: { id: 'receipt-check', version: 2 }, parameters: { required: true, expected: { digest: 'fixture', count: 1 }, tags: ['a'] } };
it('copies and freezes a versioned criterion without selecting evaluator policy', () => {
  const input = structuredClone(definition); const parsed = criterionDefinitionSchema.parse(input);
  input.parameters.expected.digest = 'changed'; input.evaluator.version = 3;
  expect(parsed).toEqual(definition); expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.evaluator)).toBe(true);
  expect(Object.isFrozen(parsed.parameters.expected)).toBe(true); expect(Object.isFrozen(parsed.parameters.tags)).toBe(true);
  expect(criterionDefinitionSchema.safeParse({ ...definition, actor: 'admin' }).success).toBe(false);
  expect(criterionDefinitionSchema.safeParse({ ...definition, version: 0 }).success).toBe(false);
  expect(criterionDefinitionSchema.safeParse({ ...definition, description: '  ' }).success).toBe(false);
});
it('rejects non-JSON values, sparse arrays, cycles and getters without invoking getters', () => {
  let read = false; const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { read = true; return 'secret'; } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const value of [{ bad: undefined }, { bad: Infinity }, { bad: NaN }, { bad: 1n }, { bad: () => 1 }, { bad: new Date() }, { bad: new Array(2) }, cycle, getter]) {
    expect(immutableJsonObjectSchema.safeParse(value).success).toBe(false);
  }
  expect(read).toBe(false);
});
it('bounds parameter depth, node count and text while copying shared JSON subtrees safely', () => {
  let deep: unknown = null; for (let i = 0; i <= JSON_VALUE_LIMITS.maxDepth; i++) deep = { nested: deep };
  for (const value of [deep, { values: Array(JSON_VALUE_LIMITS.maxNodes).fill(null) }, { text: 'x'.repeat(JSON_VALUE_LIMITS.maxCodeUnits + 1) }]) {
    expect(immutableJsonObjectSchema.safeParse(value).success).toBe(false);
  }
  const shared = { x: 1 }; const result = immutableJsonObjectSchema.parse({ a: shared, b: shared });
  expect(result.a).toEqual(result.b); expect(result.a).not.toBe(result.b);
});
it('normalizes key insertion order without dropping prototype-like JSON keys or negative zero', () => {
  const left = immutableJsonObjectSchema.parse(JSON.parse('{"z":-0,"__proto__":{"safe":true},"a":{"y":2,"x":1}}'));
  const right = immutableJsonObjectSchema.parse(JSON.parse('{"a":{"x":1,"y":2},"__proto__":{"safe":true},"z":0}'));
  expect(JSON.stringify(left)).toBe(JSON.stringify(right)); expect(Object.hasOwn(left, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(left)).toBe(Object.prototype); expect(({} as { safe?: boolean }).safe).toBeUndefined();
});
