import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compilePattern, DeckentJsonSchemaValidator, JSON_SCHEMA_LIMITS, JsonSchemaRefusal, PatternRefusal, type JsonSchemaRefusalReason } from '#platform/core/validate/index.js';

// MCP-SCHEMA-VALIDATOR (owner 2026-09-29: problematic dependencies are not accepted; build our own when needed). Deckent's own JSON Schema
// validator replaces @cfworker/json-schema and the SDK's bundled ajv/fast-uri for MCP tool schemas: a server's outputSchema is untrusted.
const validator = new DeckentJsonSchemaValidator();
const refusal = (schema: object | boolean): JsonSchemaRefusalReason | 'compiled' => {
  try { validator.getValidator(schema); return 'compiled'; } catch (error) { if (error instanceof JsonSchemaRefusal) return error.reason; throw error; }
};
const valid = (schema: object | boolean, instance: unknown) => validator.getValidator(schema)(instance).valid;
const timed = <T>(run: () => T): { value: T; ms: number } => { const start = performance.now(), value = run(); return { value, ms: performance.now() - start }; };
// CI-FIX-R3: the previous 50/500ms guards were one-machine wall-clock measurements, not portable CPU limits.
// Independent 5m xorshift iterations take 5.6–6.9ms on the lane host (Node24, 2026-10-03); preserve 6ms as
// the reference and the old guards as floors. Three samples expose runner slowdown without timing the validator itself.
// The factor is capped at 10: excessive calibration load fails visibly, never grants an unbounded timing allowance.
function timingBudget(baseMs: number): number {
  const control = () => {
    let value = 0x5eed;
    for (let i = 0; i < 5_000_000; i++) { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; }
    return value;
  };
  expect(control()).toBe(-242512527); // warm the independent control, and make its work observable
  const samples = Array.from({ length: 3 }, () => timed(control));
  for (const sample of samples) expect(sample.value).toBe(-242512527);
  const calibrationMs = Math.max(...samples.map(sample => sample.ms)), factor = Math.max(1, calibrationMs / 6);
  console.info('JSON_SCHEMA_TIMING_CALIBRATION', JSON.stringify({ platform: process.platform, node: process.version,
    control: 'xorshift32-5000000', samplesMs: samples.map(sample => sample.ms), referenceMs: 6, baseMs, factor, budgetMs: baseMs * factor }));
  expect(factor, 'JSON_SCHEMA_TIMING_CALIBRATION_OVERLOADED: independent CPU control exceeds the bounded 10x range').toBeLessThanOrEqual(10);
  return baseMs * factor;
}


// JSON-Schema-Test-Suite @ 5b0ee16 (2026-09-21; the last tag 23.1.0 is from 2023), vendored with its MIT LICENSE and upstream sha256s in
// MANIFEST.json: every required draft2020-12 and draft7 file plus optional ecmascript-regex, non-bmp-regex and float-overflow. Each group either
// compiles and answers every test as the suite expects, or is refused at compile time; the refused groups per file and reason are pinned
// below, so a new refusal (or a newly accepted feature) is a visible change. No group may compile and answer wrongly.
const SUITE = join(import.meta.dirname, '../../fixtures/json-schema-test-suite');
const EXPECTED_REFUSALS: Readonly<Record<string, number>> = {
  'draft2020-12/anchor.json unsupported-keyword': 3, 'draft2020-12/defs.json remote-ref': 1,
  'draft2020-12/dynamicRef.json remote-ref': 1, 'draft2020-12/dynamicRef.json unsupported-keyword': 20, 'draft2020-12/ref.json remote-ref': 1,
  'draft2020-12/ref.json unsupported-keyword': 12, 'draft2020-12/refRemote.json remote-ref': 12, 'draft2020-12/refRemote.json unsupported-keyword': 3,
  'draft2020-12/unevaluatedItems.json unsupported-keyword': 1, 'draft2020-12/unevaluatedProperties.json unsupported-keyword': 1,
  'draft2020-12/vocabulary.json unsupported-dialect': 2, 'draft7/definitions.json remote-ref': 1, 'draft7/ref.json remote-ref': 1,
  'draft7/ref.json unsupported-keyword': 10, 'draft7/refRemote.json remote-ref': 8, 'draft7/refRemote.json unsupported-keyword': 3,
};
interface SuiteGroup { readonly description: string; readonly schema: object | boolean; readonly tests: readonly { readonly description: string; readonly data: unknown; readonly valid: boolean }[] }
function runSuite() {
  const refused: Record<string, number> = {}, wrong: string[] = [];
  let passed = 0;
  for (const dialect of ['draft2020-12', 'draft7']) for (const file of readdirSync(join(SUITE, dialect)).sort()) {
    const groups = JSON.parse(readFileSync(join(SUITE, dialect, file), 'utf8')) as SuiteGroup[];
    for (const group of groups) {
      // draft7 files carry no $schema (the runner knows the dialect); Deckent reads a schema without $schema as 2020-12 (SEP-1613).
      const schema = dialect === 'draft7' && typeof group.schema === 'object' && !('$schema' in group.schema)
        ? { $schema: 'http://json-schema.org/draft-07/schema#', ...group.schema } : group.schema;
      let check;
      try { check = validator.getValidator(schema); } catch (error) {
        if (!(error instanceof JsonSchemaRefusal)) throw error;
        const key = `${dialect}/${file} ${error.reason}`;
        refused[key] = (refused[key] ?? 0) + 1;
        continue;
      }
      for (const test of group.tests) {
        if (check(test.data).valid === test.valid) passed++;
        else wrong.push(`${dialect}/${file}: ${group.description} / ${test.description}`);
      }
    }
  }
  return { refused, wrong, passed };
}

describe('JSON Schema validator: the official test suite', () => {
  it('answers every compiled group as the suite expects and refuses only the pinned unsupported groups', () => {
    const { refused, wrong, passed } = runSuite();
    expect(wrong).toEqual([]);
    expect(refused).toEqual(EXPECTED_REFUSALS);
    expect(passed).toBe(2235);
  });
});

describe('JSON Schema validator: the open @cfworker/json-schema reports', () => {
  it('#337 negative and fractional multipleOf is exact (cfworker rejected valid values)', () => {
    expect(valid({ multipleOf: 0.001 }, -1.234)).toBe(true);
    expect(valid({ multipleOf: 0.1 }, -0.3)).toBe(true);
    expect(valid({ multipleOf: 0.001 }, 1.234)).toBe(true);
    expect(valid({ multipleOf: 0.001 }, -1.2345)).toBe(false);
    expect(valid({ multipleOf: 2 }, -4)).toBe(true);
    expect(valid({ type: 'integer', multipleOf: 0.5 }, 1e308)).toBe(true);
  });
  it('#335 an embedded $id resource is a typed refusal (cfworker threw "Duplicate schema URI")', () => {
    expect(refusal({ allOf: [{ $id: 'https://e.example/v1', properties: { kind: { $id: 'https://e.example/v2', enum: ['a'] } } }] })).toBe('unsupported-keyword');
  });
  it('#150 $dynamicRef / $dynamicAnchor are refused, never ignored (cfworker validated the invalid instance as valid: fail-open)', () => {
    expect(refusal({ $schema: 'https://json-schema.org/draft/2020-12/schema', $dynamicAnchor: 'node', type: 'object',
      properties: { children: { type: 'array', items: { $dynamicRef: '#node' } }, v: { type: 'string' } } })).toBe('unsupported-keyword');
    for (const key of ['$recursiveRef', '$recursiveAnchor', '$vocabulary']) expect(refusal({ [key]: key === '$recursiveAnchor' ? true : key === '$vocabulary' ? {} : '#' })).toBe('unsupported-keyword');
  });
});

describe('JSON Schema validator: ReDoS (a remote server controls both the pattern and the instance)', () => {
  // Measured before (FASTURI-OUT §5): cfworker 1443 ms and ajv 1445 ms synchronous on 27 characters of `^(a+)+$`; the same backtracking is
  // exponential in V8's own RegExp, which this engine never runs on the instance.
  it.each([['^(a+)+$', 27], ['^(a+)+$', 10_000], ['(a*)*b', 10_000], ['^(a|a)*$', 10_000], ['^(\\w+\\s?)*$', 10_000]] as const)(
    'pattern %s on %i characters answers within the independently calibrated 50ms guard', (pattern, length) => {
      const budgetMs = timingBudget(50);
      const check = validator.getValidator({ type: 'string', pattern });
      check('aaaa');
      const { value, ms } = timed(() => check('a'.repeat(length - 1) + '!'));
      expect(value.valid).toBe(false);
      expect(ms).toBeLessThan(budgetMs);
    });
  it.each(['^(a+)+$', '(a*)*b', '^(a|a)*$', '^(\\w+\\s?)*$'])(
    'charges linear bounded work for hostile %s independently of host speed', pattern => {
      const matcher = compilePattern(pattern, { sourceMax: 4_096, statesMax: 2_000, repeatMax: 1_000 });
      for (const length of [27, 1_000, 10_000]) {
        const budget = { remaining: JSON_SCHEMA_LIMITS.validationSteps };
        expect(matcher.test('a'.repeat(length - 1) + '!', budget)).toBe(false);
        const used = JSON_SCHEMA_LIMITS.validationSteps - budget.remaining;
        expect(used).toBeGreaterThanOrEqual(length);
        expect(used).toBeLessThanOrEqual(8 * matcher.states * (length + 1));
      }
    });
  it('patternProperties is the same engine: a hostile key answers in linear time', () => {
    const budgetMs = timingBudget(50);
    const check = validator.getValidator({ type: 'object', patternProperties: { '^(a+)+$': { type: 'string' } }, additionalProperties: false });
    const { value, ms } = timed(() => check({ ['a'.repeat(5_000) + '!']: 1 }));
    expect(value.valid).toBe(false);
    expect(ms).toBeLessThan(budgetMs);
  });
  // The budget's time is calibrated in proof/MCP-SCHEMA-VALIDATOR-2026-09-29/logs/budget-bench-weighted.json (≈ 18–45 ms); here only a
  // generous bound, so a loaded full verify cannot turn a correct fail-closed answer red.
  it('the largest accepted pattern on a long string exhausts the step budget and fails closed (bounded time)', () => {
    const budgetMs = timingBudget(500);
    const pattern = `(?:${'[a-z]?'.repeat(600)})*x`;
    const check = validator.getValidator({ type: 'string', pattern });
    const { value, ms } = timed(() => check('a'.repeat(100_000)));
    expect(value).toMatchObject({ valid: false, errorMessage: expect.stringContaining('not validated, validation step budget exceeded (fail closed)') });
    expect(ms).toBeLessThan(budgetMs);
  });
  it.each([['(a)\\1', 'unsupported-pattern'], ['(?<n>a)\\k<n>', 'unsupported-pattern'], ['(?=a)a', 'unsupported-pattern'], ['(?!a)b', 'unsupported-pattern'],
    ['(?<=a)b', 'unsupported-pattern'], ['(?<!a)b', 'unsupported-pattern'], ['(?i:a)', 'unsupported-pattern'], ['a{1001}', 'limit'], ['(a{1000}){3}', 'limit'],
    ['['.repeat(1) + 'a', 'invalid-schema'], ['\\-', 'invalid-schema'], ['a'.repeat(4_097), 'limit'], ['('.repeat(65) + ')'.repeat(65), 'limit']] as const)(
    'pattern %s is refused at compile time (%s)', (pattern, reason) => {
      expect(refusal({ type: 'string', pattern })).toBe(reason);
      expect(refusal({ type: 'object', patternProperties: { [pattern]: true } })).toBe(reason);
    });
});

describe('JSON Schema validator: the linear engine agrees with V8 on the patterns it accepts', () => {
  // Property check (deterministic PRNG): random patterns from the accepted grammar over a small alphabet, random short strings (short, so the
  // backtracking reference stays fast). Classes, escapes and `.` exercise the one-code-point V8 atoms; quantifiers, groups, `|`, anchors and
  // `\b` exercise the NFA. Any disagreement is printed with its pattern and input.
  let seed = 0x5eed;
  const random = (n: number) => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed % n; };
  const pick = <T>(items: readonly T[]) => items[random(items.length)]!;
  const ATOMS = ['a', 'b', 'c', '.', '[ab]', '[^a]', '[a-c]', '\\d', '\\w', '\\s', '\\W', '\\u0061', '\\x62', '[\\s\\d]', '😀', '\\p{L}', '[^]', '[]', '\\n', 'ğ'];
  const pattern = (depth: number): string => {
    const items: string[] = [];
    for (let k = 1 + random(3); k > 0; k--) {
      let item = depth > 0 && random(4) === 0 ? `(${random(2) ? '?:' : ''}${pattern(depth - 1)}${random(3) === 0 ? `|${pattern(depth - 1)}` : ''})` : pick(ATOMS);
      const q = random(9);
      item += q === 0 ? '*' : q === 1 ? '+' : q === 2 ? '?' : q === 3 ? `{${random(3)}}` : q === 4 ? `{${random(2)},${2 + random(2)}}` : q === 5 ? `{1,}` : '';
      if (q < 6 && random(4) === 0) item += '?';
      items.push(random(10) === 0 ? pick(['^', '$', '\\b', '\\B']) : item);
    }
    return items.join('');
  };
  const TEXT = ['a', 'b', 'c', '1', ' ', '\n', '😀', 'ğ', '_', '-'];
  it('2 000 random patterns × 8 inputs match exactly like RegExp(pattern, "u").test', () => {
    const disagreements: string[] = [];
    for (let n = 0; n < 2_000; n++) {
      const source = pattern(2);
      const ours = compilePattern(source, { sourceMax: 4_096, statesMax: 2_000, repeatMax: 1_000 }), reference = new RegExp(source, 'u');
      for (let k = 0; k < 8; k++) {
        const input = Array.from({ length: random(7) }, () => pick(TEXT)).join('');
        const budget = { remaining: 1_000_000 };
        if (ours.test(input, budget) !== reference.test(input)) disagreements.push(`${JSON.stringify(source)} on ${JSON.stringify(input)}`);
      }
    }
    expect(disagreements).toEqual([]);
  });
  it('a pattern is never anchored implicitly and lazy quantifiers match like greedy ones', () => {
    const lazy = compilePattern('a+?b', { sourceMax: 100, statesMax: 100, repeatMax: 10 });
    expect(lazy.test('xxaab', { remaining: 1_000 })).toBe(true);
    expect(compilePattern('es', { sourceMax: 100, statesMax: 100, repeatMax: 10 }).test('expression', { remaining: 1_000 })).toBe(true);
    expect(() => compilePattern('(?=a)', { sourceMax: 100, statesMax: 100, repeatMax: 10 })).toThrow(PatternRefusal);
  });
});

describe('JSON Schema validator: dialects, keywords and fail-closed refusals', () => {
  it('2020-12 is the default (SEP-1613); draft-07 and draft-06 are read as draft-07; every other dialect is refused', () => {
    expect(valid({ type: 'array', prefixItems: [{ type: 'string' }] }, [1])).toBe(false);
    expect(valid({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'array', items: [{ type: 'string' }], additionalItems: false }, ['a', 1])).toBe(false);
    expect(valid({ $schema: 'http://json-schema.org/draft-06/schema#', type: 'string' }, 'x')).toBe(true);
    for (const $schema of ['https://json-schema.org/draft/2019-09/schema', 'http://json-schema.org/draft-04/schema#', 'https://e.example/meta'])
      expect(refusal({ $schema, type: 'string' })).toBe('unsupported-dialect');
    expect(refusal({ $schema: 1 })).toBe('invalid-schema');
  });
  it('draft-07 ignores the siblings of $ref; 2020-12 applies them', () => {
    const defs = { definitions: { s: { type: 'string' } } };
    expect(valid({ $schema: 'http://json-schema.org/draft-07/schema#', ...defs, $ref: '#/definitions/s', maxLength: 1 }, 'long')).toBe(true);
    expect(valid({ ...defs, $ref: '#/definitions/s', maxLength: 1 }, 'long')).toBe(false);
  });
  it('an unknown keyword or one of the other dialect is refused; annotations and x- extensions are accepted', () => {
    expect(refusal({ type: 'string', maxLenght: 3 })).toBe('unsupported-keyword');
    expect(refusal({ type: 'array', items: [{ type: 'string' }] })).toBe('unsupported-keyword');
    expect(refusal({ additionalItems: false })).toBe('unsupported-keyword');
    expect(refusal({ dependencies: { a: ['b'] } })).toBe('unsupported-keyword');
    expect(refusal({ $schema: 'http://json-schema.org/draft-07/schema#', unevaluatedProperties: false })).toBe('unsupported-keyword');
    expect(refusal({ $schema: 'http://json-schema.org/draft-07/schema#', prefixItems: [] })).toBe('unsupported-keyword');
    expect(refusal({ type: 'object', title: 't', description: 'd', default: {}, examples: [], deprecated: false, readOnly: true, writeOnly: false,
      $comment: 'c', 'x-mcp-header': 'X', discriminator: { propertyName: 'kind' }, nullable: true, format: 'uuid', contentMediaType: 'text/plain' })).toBe('compiled');
    expect(new DeckentJsonSchemaValidator({ annotations: ['markdownDescription'] }).getValidator({ markdownDescription: 'm' })('x').valid).toBe(true);
  });
  it('$ref resolves only inside the document: remote and relative references are refused, nothing is fetched', () => {
    expect(refusal({ $ref: 'https://e.example/remote.json' })).toBe('remote-ref');
    expect(refusal({ $ref: 'other.json#/a' })).toBe('remote-ref');
    expect(refusal({ $ref: '#/$defs/missing' })).toBe('invalid-schema');
    expect(valid({ $id: 'https://e.example/root.json', $defs: { n: { type: 'number' } }, properties: { a: { $ref: 'https://e.example/root.json#/$defs/n' } } }, { a: 'x' })).toBe(false);
    expect(valid({ $defs: { 'a/b': { type: 'number' }, 'c%d': { type: 'string' } }, properties: { x: { $ref: '#/$defs/a~1b' }, y: { $ref: '#/$defs/c%25d' } } }, { x: 1, y: 'z' })).toBe(true);
    // The FASTURI-OUT host-confusion $id (%40 becomes @ in fast-uri) never reaches a URI parser: embedded $id is refused.
    expect(refusal({ type: 'object', $defs: { remote: { $id: 'http://trusted.example%40evil.example/s', type: 'string' } } })).toBe('unsupported-keyword');
    // Also where only a $ref pointer reaches (an x- container is not a subschema location): an embedded resource or another dialect there
    // would change how its references resolve, so it is refused rather than read as an annotation.
    expect(refusal({ 'x-lib': { inner: { $id: 'https://e.example/inner', $ref: '#/x' } }, $ref: '#/x-lib/inner' })).toBe('unsupported-keyword');
    expect(refusal({ 'x-lib': { inner: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' } }, $ref: '#/x-lib/inner' })).toBe('unsupported-dialect');
    expect(refusal({ 'x-lib': { inner: { $dynamicRef: '#n' } }, $ref: '#/x-lib/inner' })).toBe('unsupported-keyword');
    expect(valid({ 'x-lib': { inner: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' } }, $ref: '#/x-lib/inner' }, 'a')).toBe(true);
  });
  it('a reference cycle without instance progress is refused at compile time; recursion through the instance is fine', () => {
    expect(refusal({ $defs: { a: { $ref: '#/$defs/b' }, b: { anyOf: [{ type: 'string' }, { $ref: '#/$defs/a' }] } }, $ref: '#/$defs/a' })).toBe('invalid-schema');
    expect(refusal({ allOf: [{ $ref: '#' }] })).toBe('invalid-schema');
    const tree = { type: 'object', properties: { v: { type: 'string' }, children: { type: 'array', items: { $ref: '#' } } }, required: ['v'] };
    expect(valid(tree, { v: 'a', children: [{ v: 'b', children: [] }] })).toBe(true);
    expect(valid(tree, { v: 'a', children: [{ children: [] }] })).toBe(false);
  });
  it('format is an annotation unless a checker is registered for it', () => {
    expect(valid({ type: 'string', format: 'uuid' }, 'not-a-uuid')).toBe(true);
    const strict = new DeckentJsonSchemaValidator({ formats: { uuid: value => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value) } });
    expect(strict.getValidator({ type: 'string', format: 'uuid' })('not-a-uuid')).toMatchObject({ valid: false, errorMessage: '#: must be a valid uuid' });
    expect(strict.getValidator({ format: 'uuid' })(5).valid).toBe(true);
  });
  it('never writes into the schema it compiles (a deep-frozen pinned definition compiles and validates)', () => {
    const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
    const schema = freeze({ $id: 'https://e.example/s', type: 'object', $defs: { n: { type: 'integer', minimum: 0 } }, properties: { n: { $ref: '#/$defs/n' }, s: { pattern: '^a' } },
      unevaluatedProperties: false });
    const text = JSON.stringify(schema), check = validator.getValidator(schema);
    expect(check({ n: 1, s: 'ab' }).valid).toBe(true);
    expect(check({ n: -1 })).toMatchObject({ valid: false, errorMessage: '#/n: must be at least 0' });
    expect(check({ n: 1, extra: true }).valid).toBe(false);
    expect(JSON.stringify(schema)).toBe(text);
  });
  it('errors name the instance location, like the SDK expects ("<location>: <reason>")', () => {
    const check = validator.getValidator({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] });
    expect(check({ id: 5 })).toEqual({ valid: false, data: undefined, errorMessage: '#/id: must be string' });
    expect(check({})).toEqual({ valid: false, data: undefined, errorMessage: '#: must have required property "id"' });
    expect(check({ id: 'a' })).toEqual({ valid: true, data: { id: 'a' }, errorMessage: undefined });
  });
});

describe('JSON Schema validator: bounded compile and validation', () => {
  const nest = (depth: number): object => depth === 0 ? { type: 'string' } : { properties: { a: nest(depth - 1) } };
  const limited = (limits: Partial<typeof JSON_SCHEMA_LIMITS>) => new DeckentJsonSchemaValidator({ limits });
  it.each([
    ['schemaDepth', nest(65), {}],
    ['schemaNodes', { properties: Object.fromEntries(Array.from({ length: 10_001 }, (_, k) => [`p${k}`, {}])) }, {}],
    ['schemaKeywords', { enum: Array.from({ length: 50_001 }, (_, k) => k) }, {}],
    ['schemaPatternStates', { properties: Object.fromEntries(Array.from({ length: 11 }, (_, k) => [`p${k}`, { pattern: `${'a'.repeat(1_990)}${k}` }])) }, {}],
    ['patternStates', { pattern: 'a{1000}b{1000}' }, {}],
  ] as const)('%s: a schema above the limit is refused at compile time', (_limit, schema) => {
    expect(refusal(schema)).toBe('limit');
  });
  it('the defaults are the documented ones', () => {
    expect(JSON_SCHEMA_LIMITS).toEqual({ schemaDepth: 64, schemaNodes: 10_000, schemaKeywords: 50_000, patternSource: 4_096, patternStates: 2_000,
      patternRepeat: 1_000, schemaPatternStates: 20_000, instanceDepth: 128, evaluationDepth: 512, validationSteps: 5_000_000 });
    expect(refusal(nest(64))).toBe('compiled');
  });
  it('an instance nested deeper than instanceDepth fails closed', () => {
    const tree = { type: 'object', properties: { c: { $ref: '#' } } };
    let deep: object = {};
    for (let k = 0; k < 200; k++) deep = { c: deep };
    expect(validator.getValidator(tree)(deep)).toMatchObject({ valid: false, errorMessage: expect.stringContaining('instance nested deeper than 128 (fail closed)') });
    expect(limited({ instanceDepth: 300 }).getValidator(tree)(deep).valid).toBe(true);
  });
  it('recursion through $ref is bounded by evaluationDepth', () => {
    const list = { $defs: { l: { anyOf: [{ type: 'null' }, { type: 'array', prefixItems: [true, { $ref: '#/$defs/l' }] }] } }, $ref: '#/$defs/l' };
    let deep: unknown = null;
    for (let k = 0; k < 100; k++) deep = [k, deep];
    expect(limited({ evaluationDepth: 64, instanceDepth: 1_000 }).getValidator(list)(deep)).toMatchObject({ valid: false, errorMessage: expect.stringContaining('schema evaluation nested deeper than 64') });
    expect(limited({ instanceDepth: 1_000 }).getValidator(list)(deep).valid).toBe(true);
  });
  it('a validation above validationSteps fails closed (a large array with uniqueItems), within the calibrated time', () => {
    const budgetMs = timingBudget(500);
    const big = Array.from({ length: 300_000 }, (_, k) => k);
    const { value, ms } = timed(() => validator.getValidator({ type: 'array', items: { type: 'integer' }, uniqueItems: true })(big));
    expect(value).toMatchObject({ valid: false, errorMessage: expect.stringContaining('validation step budget exceeded (fail closed)') });
    expect(ms).toBeLessThan(budgetMs);
    expect(limited({ validationSteps: 20_000_000 }).getValidator({ type: 'array', items: { type: 'integer' }, uniqueItems: true })(big).valid).toBe(true);
  });
});
