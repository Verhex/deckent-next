import { expect, it } from 'vitest';
import { criterionDefinitionSchema, CRITERION_TEXT_LIMITS } from '#domain/index.js';
const base = { id: 'c1', version: 1, description: 'Check', evaluator: { id: 'ev', version: 1 }, parameters: {} };
const parse = (patch: Record<string, unknown>) => criterionDefinitionSchema.safeParse({ ...base, ...patch });
const firstPath = (r: ReturnType<typeof parse>) => (r.success ? undefined : r.error.issues[0]?.path.join('.'));
it('exposes a frozen 4096 code-unit text limit', () => {
  expect(CRITERION_TEXT_LIMITS).toEqual({ maxCodeUnits: 4096 });
  expect(Object.isFrozen(CRITERION_TEXT_LIMITS)).toBe(true);
});
it('accepts a description of exactly the limit and refuses one code unit more', () => {
  expect(parse({ description: 'x'.repeat(4096) }).success).toBe(true);
  const over = parse({ description: 'x'.repeat(4097) });
  expect(over.success).toBe(false); expect(firstPath(over)).toBe('description');
});
it('refuses empty and whitespace-only descriptions on the description path', () => {
  for (const description of ['', ' ', '\n\t\r ']) {
    const r = parse({ description }); expect(r.success).toBe(false); expect(firstPath(r)).toBe('description');
  }
});
it('allows tab, LF and CR but refuses other C0 and C1 control characters', () => {
  expect(parse({ description: 'a\tb\nc\rd' }).success).toBe(true);
  for (const code of [0, 8, 11, 27, 31, 127, 128, 159]) expect(parse({ description: `a${String.fromCharCode(code)}b` }).success).toBe(false);
  expect(parse({ description: `a${String.fromCharCode(160)}b` }).success).toBe(true);
});
it('refuses non-integer, zero, negative and string versions for definition and evaluator', () => {
  for (const version of [0, -1, 1.5, '1', null, NaN]) {
    expect(parse({ version }).success).toBe(false);
    expect(parse({ evaluator: { id: 'ev', version } }).success).toBe(false);
  }
});
it('refuses unknown keys on the definition and on the evaluator with unrecognized_keys', () => {
  const top = parse({ extra: 1 }); expect(top.success).toBe(false);
  if (!top.success) expect(top.error.issues[0]?.code).toBe('unrecognized_keys');
  const nested = parse({ evaluator: { id: 'ev', version: 1, extra: 1 } }); expect(nested.success).toBe(false);
  if (!nested.success) expect(nested.error.issues[0]?.code).toBe('unrecognized_keys');
});
it('refuses missing required fields and non-object parameters', () => {
  for (const key of ['id', 'version', 'description', 'evaluator', 'parameters']) {
    const { [key]: _omit, ...rest } = base as Record<string, unknown>; void _omit;
    const r = criterionDefinitionSchema.safeParse(rest); expect(r.success).toBe(false); expect(firstPath(r)).toBe(key);
  }
  for (const parameters of [null, [], 'x', 1]) expect(parse({ parameters }).success).toBe(false);
});
it('returns a frozen deep copy so later input mutation cannot alter the parsed criterion', () => {
  const input = { ...base, evaluator: { ...base.evaluator }, parameters: { list: [1, { a: 1 }] } };
  const out = criterionDefinitionSchema.parse(input);
  (input.parameters.list[1] as { a: number }).a = 2; input.evaluator.version = 9;
  expect(out.parameters).toEqual({ list: [1, { a: 1 }] }); expect(out.evaluator.version).toBe(1);
  expect(Object.isFrozen(out)).toBe(true); expect(Object.isFrozen(out.parameters.list)).toBe(true);
});
