/**
 * Deckent's JSON Schema validator for MCP tool schemas (MCP-SCHEMA-VALIDATOR, owner 2026-09-29: problematic dependencies are not accepted).
 *
 * It implements the MCP SDK's `jsonSchemaValidator` provider shape (`getValidator(schema) → (input) → {valid, data, errorMessage}`, synchronous)
 * structurally, so the SDK Client and Server take it instead of the bundled ajv/fast-uri or @cfworker/json-schema. A server's `outputSchema`
 * is untrusted input: the whole reachable schema is compiled eagerly into closures (no code generation, no eval, the schema is never written)
 * and everything this module does not implement exactly is refused at compile time with a typed {@link JsonSchemaRefusal} — the MCP client
 * then refuses the call before sending it (MCP-PIN-DEF). Dialects: 2020-12 (also when `$schema` is absent, SEP-1613) and draft-07 (draft-06 is
 * read as draft-07, as the SDK does). Compile and validation are bounded ({@link JSON_SCHEMA_LIMITS}); `pattern` runs on the linear-time
 * engine of `./linear-regex.ts`; a validation that exhausts its budget is invalid (fail closed), never slow. `format` is an annotation unless a
 * checker is registered for its name. `$ref` resolves only inside the document (`#…` or `<root $id>#…`): nothing is fetched and no URI parser
 * runs; an embedded `$id` resource is refused. The dialect contract and the measured limits: proof/MCP-SCHEMA-VALIDATOR-2026-09-29/design.md.
 */
import { compilePattern, PatternRefusal, StepBudgetExceeded, type LinearPattern, type StepBudget } from './linear-regex.js';

export type JsonSchemaRefusalReason = 'unsupported-dialect' | 'unsupported-keyword' | 'remote-ref' | 'unsupported-pattern' | 'invalid-schema' | 'limit';
/** A schema this validator will not compile (fail closed); `at` is the JSON Pointer of the schema location. */
export class JsonSchemaRefusal extends Error {
  readonly code = 'JSON_SCHEMA_REFUSED';
  constructor(readonly reason: JsonSchemaRefusalReason, readonly at: string, detail: string) {
    super(`${reason} at #${at}: ${detail}`);
    this.name = 'JsonSchemaRefusal';
  }
}
export interface JsonSchemaLimits {
  /** Schema object nesting (JSON Pointer depth) and compile recursion including `$ref` hops. */
  readonly schemaDepth: number;
  readonly schemaNodes: number;
  /** Keywords of every compiled schema object plus `enum` members. */
  readonly schemaKeywords: number;
  readonly patternSource: number;
  readonly patternStates: number;
  readonly patternRepeat: number;
  /** Linear-regex program states over the whole document. */
  readonly schemaPatternStates: number;
  readonly instanceDepth: number;
  /** Nested schema evaluations of one validation (bounds recursion through `$ref`). */
  readonly evaluationDepth: number;
  /** Weighted steps of one validation (≈ 10 ns each): schema evaluations, visited members and values, string characters, regex states. */
  readonly validationSteps: number;
}
export const JSON_SCHEMA_LIMITS: JsonSchemaLimits = Object.freeze({
  schemaDepth: 64, schemaNodes: 10_000, schemaKeywords: 50_000, patternSource: 4_096, patternStates: 2_000, patternRepeat: 1_000,
  schemaPatternStates: 20_000, instanceDepth: 128, evaluationDepth: 512, validationSteps: 5_000_000,
});
/** Keywords that never change a validation result and are accepted in both dialects (policy: extend per provider, not by editing code paths).
 * Also accepted: `x-`-prefixed extensions. `discriminator` (OpenAPI, emitted by pydantic) and `nullable` are hints; ignoring them never
 * loosens a result. `$defs` / `definitions` are containers: their members compile only when a `$ref` reaches them. */
export const JSON_SCHEMA_ANNOTATIONS: readonly string[] = Object.freeze(['$schema', '$id', '$comment', 'title', 'description', 'default',
  'examples', 'deprecated', 'readOnly', 'writeOnly', 'format', 'contentMediaType', 'contentEncoding', 'contentSchema', 'discriminator',
  'nullable', '$defs', 'definitions']);
export type JsonSchemaResult<T> = { valid: true; data: T; errorMessage: undefined } | { valid: false; data: undefined; errorMessage: string };
export type JsonSchemaCheck<T> = (input: unknown) => JsonSchemaResult<T>;
export interface JsonSchemaValidatorOptions {
  readonly limits?: Partial<JsonSchemaLimits>;
  /** Format checkers by name (asserted only for strings); an unregistered format is an annotation (2020-12 default). */
  readonly formats?: Readonly<Record<string, (value: string) => boolean>>;
  /** Extra annotation keywords beyond {@link JSON_SCHEMA_ANNOTATIONS}. */
  readonly annotations?: readonly string[];
}

type Dialect = '2020-12' | 'draft-07';
const DIALECTS: ReadonlyMap<string, Dialect> = new Map([
  ['https://json-schema.org/draft/2020-12/schema', '2020-12'], ['http://json-schema.org/draft/2020-12/schema', '2020-12'],
  ['https://json-schema.org/draft-07/schema', 'draft-07'], ['http://json-schema.org/draft-07/schema', 'draft-07'],
  ['https://json-schema.org/draft-06/schema', 'draft-07'], ['http://json-schema.org/draft-06/schema', 'draft-07'],
]);
const COMMON = ['type', 'enum', 'const', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'maxLength', 'minLength',
  'pattern', 'maxItems', 'minItems', 'uniqueItems', 'contains', 'maxProperties', 'minProperties', 'required', 'properties', 'patternProperties',
  'additionalProperties', 'propertyNames', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', '$ref', 'items'];
const KEYWORDS: Readonly<Record<Dialect, ReadonlySet<string>>> = {
  '2020-12': new Set([...COMMON, 'prefixItems', '$anchor', 'dependentRequired', 'dependentSchemas', 'maxContains', 'minContains',
    'unevaluatedItems', 'unevaluatedProperties']),
  'draft-07': new Set([...COMMON, 'additionalItems', 'dependencies']),
};
const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer']);
const ANCHOR = /^[A-Za-z_][-A-Za-z0-9._]*$/u;

type Json = unknown;
type JsonObject = Readonly<Record<string, Json>>;
/** Evaluated members of one instance (2020-12 annotations consumed by unevaluatedProperties / unevaluatedItems). */
interface Evaluated { readonly props: Set<string>; readonly items: Set<number>; all: boolean }
interface Ctx { readonly budget: StepBudget; readonly path: (string | number)[]; depth: number; message: string }
type Validate = (instance: Json, ctx: Ctx, ev: Evaluated | null) => boolean;

class ValidationLimit extends Error {}
const isObject = (value: Json): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const newEv = (): Evaluated => ({ props: new Set(), items: new Set(), all: false });
const merge = (from: Evaluated, into: Evaluated) => {
  for (const key of from.props) into.props.add(key);
  for (const index of from.items) into.items.add(index);
  if (from.all) into.all = true;
};
/** Step weights: one step ≈ 10 ns on the calibration machine (a regex state visit is one step), so the default budget of 5 000 000 steps
 * answers in ≈ 50 ms at worst (proof/MCP-SCHEMA-VALIDATOR-2026-09-29/logs/budget-bench-*.json). Work linear in the instance that is cheaper
 * than the SDK's own JSON.parse of it (enumerating a member list, copying a key) is not charged separately. */
const NODE_STEPS = 20, MEMBER_STEPS = 12, VALUE_STEPS = 12, CANONICAL_STEPS = 16, CHARS_PER_STEP_SHIFT = 3;
const charge = (ctx: Ctx, steps: number) => { if ((ctx.budget.remaining -= steps) < 0) throw new StepBudgetExceeded(); };
const pointer = (path: readonly (string | number)[]) => path.map(part => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
const fail = (ctx: Ctx, detail: string) => { ctx.message = `#${pointer(ctx.path)}: ${detail}`.slice(0, 500); return false; };
const matchesType = (value: Json, type: string) => type === 'integer' ? Number.isInteger(value)
  : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? isObject(value) : typeof value === type;

/** Runs an in-place subschema with its own annotations (so its unevaluated* never sees a cousin's) and merges them only when it passed. */
function isolated(validate: Validate, instance: Json, ctx: Ctx, ev: Evaluated | null): boolean {
  const own = ev ? newEv() : null, ok = validate(instance, ctx, own);
  if (ok && own && ev) merge(own, ev);
  return ok;
}
/** JSON equality (numbers by value, object members regardless of order), charged per visited value. */
function equal(a: Json, b: Json, ctx: Ctx, depth = 0): boolean {
  charge(ctx, VALUE_STEPS);
  if (depth > 256) throw new ValidationLimit('value nested too deeply');
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, k) => equal(item, b[k], ctx, depth + 1));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key], ctx, depth + 1));
}
/** Canonical text of a JSON value (sorted members) for uniqueItems: one pass instead of pairwise comparison. */
function canonical(value: Json, ctx: Ctx, depth = 0): string {
  charge(ctx, CANONICAL_STEPS);
  if (depth > 256) throw new ValidationLimit('value nested too deeply');
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, ctx, depth + 1)).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], ctx, depth + 1)}`).join(',')}}`;
  if (typeof value === 'string') charge(ctx, value.length >> CHARS_PER_STEP_SHIFT);
  return JSON.stringify(value) ?? 'undefined';
}
/** Exact decimal divisibility: both numbers as their shortest round-trip decimal (what a JSON author wrote), compared as BigInt. */
function decimal(value: number): readonly [bigint, number] {
  const [coefficient = '0', exponent] = String(value).split('e');
  const dot = coefficient.indexOf('.');
  const digits = dot < 0 ? coefficient : coefficient.slice(0, dot) + coefficient.slice(dot + 1);
  return [BigInt(digits), Number(exponent ?? 0) - (dot < 0 ? 0 : coefficient.length - dot - 1)];
}
function isMultipleOf(value: number, divisor: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (Number.isSafeInteger(value) && Number.isSafeInteger(divisor)) return value % divisor === 0;
  const [a, ea] = decimal(value), [b, eb] = decimal(divisor), e = Math.min(ea, eb);
  return (a * 10n ** BigInt(ea - e)) % (b * 10n ** BigInt(eb - e)) === 0n;
}
const codePoints = (value: string, ctx: Ctx) => {
  charge(ctx, value.length >> CHARS_PER_STEP_SHIFT);
  let count = 0;
  for (let i = 0; i < value.length; i++, count++) { const unit = value.charCodeAt(i); if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < value.length) { const low = value.charCodeAt(i + 1); if (low >= 0xdc00 && low <= 0xdfff) i++; } }
  return count;
};

/** One schema document compiled for one dialect; every reachable subschema is compiled before the first validation. */
class Compiler {
  private readonly memo = new Map<object, Validate>();
  private readonly anchors = new Map<string, JsonObject>();
  private readonly patterns = new Map<string, LinearPattern>();
  private nodes = 0; private keywords = 0; private patternStates = 0;
  private readonly rootId: string | null;
  private readonly dialect: Dialect;
  /** True once any compiled schema uses unevaluated*: in-place applicators then collect and isolate annotations. */
  track = false;
  constructor(private readonly root: Json, private readonly limits: JsonSchemaLimits, private readonly formats: Readonly<Record<string, (value: string) => boolean>>,
    private readonly annotations: ReadonlySet<string>) {
    this.dialect = 'draft-07';
    const declared = isObject(root) ? root['$schema'] : undefined;
    if (declared === undefined) this.dialect = '2020-12';
    else if (typeof declared !== 'string') throw new JsonSchemaRefusal('invalid-schema', '', '$schema is not a string');
    else {
      const dialect = DIALECTS.get(declared.replace(/#$/u, ''));
      if (!dialect) throw new JsonSchemaRefusal('unsupported-dialect', '', `$schema ${JSON.stringify(declared.slice(0, 120))}`);
      this.dialect = dialect;
    }
    const id = isObject(root) ? root['$id'] : undefined;
    if (id !== undefined && typeof id !== 'string') throw new JsonSchemaRefusal('invalid-schema', '/$id', 'not a string');
    this.rootId = id === undefined ? null : id.replace(/#$/u, '');
    if (this.rootId?.includes('#')) throw new JsonSchemaRefusal('invalid-schema', '/$id', 'the root $id carries a fragment');
    this.scan(root, '', 0);
  }
  /** Collects anchors over every subschema location and refuses embedded `$id` resources; bounded by the node and depth limits. */
  private scan(node: Json, at: string, depth: number): void {
    if (!isObject(node)) return;
    if (++this.nodes > this.limits.schemaNodes) throw new JsonSchemaRefusal('limit', at, `more than ${this.limits.schemaNodes} schema objects`);
    if (depth > this.limits.schemaDepth) throw new JsonSchemaRefusal('limit', at, `schema nested deeper than ${this.limits.schemaDepth}`);
    const siblingsIgnored = this.dialect === 'draft-07' && '$ref' in node;
    const id = node['$id'], anchor = this.dialect === '2020-12' ? node['$anchor'] : undefined;
    if (depth > 0 && id !== undefined && !siblingsIgnored) {
      if (this.dialect === 'draft-07' && typeof id === 'string' && id.startsWith('#') && ANCHOR.test(id.slice(1))) this.addAnchor(id.slice(1), node, at);
      else throw new JsonSchemaRefusal('unsupported-keyword', `${at}/$id`, 'embedded $id resources are not supported');
    }
    if (anchor !== undefined) {
      if (typeof anchor !== 'string' || !ANCHOR.test(anchor)) throw new JsonSchemaRefusal('invalid-schema', `${at}/$anchor`, 'invalid anchor');
      this.addAnchor(anchor, node, at);
    }
    for (const [key, value] of Object.entries(node)) {
      if (siblingsIgnored && key !== 'definitions' && key !== '$defs') continue;
      const child = `${at}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies'].includes(key) && isObject(value))
        for (const [name, sub] of Object.entries(value)) this.scan(sub, `${child}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`, depth + 1);
      else if (['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'].includes(key) && Array.isArray(value)) value.forEach((sub, k) => this.scan(sub, `${child}/${k}`, depth + 1));
      else if (['additionalProperties', 'propertyNames', 'items', 'additionalItems', 'contains', 'not', 'if', 'then', 'else', 'unevaluatedItems',
        'unevaluatedProperties'].includes(key)) this.scan(value, child, depth + 1);
    }
  }
  private addAnchor(name: string, node: JsonObject, at: string): void {
    if (this.anchors.has(name)) throw new JsonSchemaRefusal('invalid-schema', at, `duplicate anchor ${name}`);
    this.anchors.set(name, node);
  }
  compileRoot(): Validate { this.nodes = 0; return this.compile(this.root, '', 0, new Set()); }
  private resolve(ref: string, at: string): { readonly node: Json; readonly at: string } {
    let fragment = ref;
    if (this.rootId !== null && ref.startsWith(this.rootId) && (ref.length === this.rootId.length || ref[this.rootId.length] === '#')) fragment = ref.slice(this.rootId.length);
    if (fragment === '') return { node: this.root, at: '' };
    if (!fragment.startsWith('#')) throw new JsonSchemaRefusal('remote-ref', at, `$ref ${JSON.stringify(ref.slice(0, 120))} is not inside this schema`);
    let decoded: string;
    try { decoded = decodeURIComponent(fragment.slice(1)); } catch { throw new JsonSchemaRefusal('invalid-schema', at, 'malformed $ref fragment'); }
    if (decoded === '') return { node: this.root, at: '' };
    if (!decoded.startsWith('/')) {
      const anchored = this.anchors.get(decoded);
      if (!anchored) throw new JsonSchemaRefusal('invalid-schema', at, `unresolvable $ref ${JSON.stringify(ref.slice(0, 120))}`);
      return { node: anchored, at: `#${decoded}` };
    }
    let node: Json = this.root;
    for (const raw of decoded.slice(1).split('/')) {
      const part = raw.replaceAll('~1', '/').replaceAll('~0', '~');
      if (Array.isArray(node) && /^(?:0|[1-9]\d*)$/u.test(part) && Number(part) < node.length) node = node[Number(part)];
      else if (isObject(node) && Object.hasOwn(node, part)) node = node[part];
      else throw new JsonSchemaRefusal('invalid-schema', at, `unresolvable $ref ${JSON.stringify(ref.slice(0, 120))}`);
    }
    return { node, at: decoded };
  }
  /** `chain` holds the schemas reached from the nearest instance step through in-place applicators only: meeting one again is a cycle that
   * would recurse without consuming the instance, refused here instead of at validation time. */
  private compile(node: Json, at: string, depth: number, chain: ReadonlySet<object>): Validate {
    if (node === true) return () => true;
    if (node === false) return (_instance, ctx) => fail(ctx, 'no value is allowed here');
    if (!isObject(node)) throw new JsonSchemaRefusal('invalid-schema', at, 'a schema is an object or a boolean');
    if (chain.has(node)) throw new JsonSchemaRefusal('invalid-schema', at, 'reference cycle without instance progress');
    const known = this.memo.get(node);
    if (known) return known;
    if (depth > this.limits.schemaDepth * 4) throw new JsonSchemaRefusal('limit', at, 'schema references nested too deeply');
    if (++this.nodes > this.limits.schemaNodes) throw new JsonSchemaRefusal('limit', at, `more than ${this.limits.schemaNodes} schema objects`);
    let compiled: Validate | null = null;
    this.memo.set(node, (instance, ctx, ev) => compiled!(instance, ctx, ev));
    const inPlace = new Set(chain).add(node), fresh = new Set<object>();
    const sub = (value: Json, where: string, same: boolean) => this.compile(value, `${at}/${where}`, depth + 1, same ? inPlace : fresh);
    // A `$ref` applies its target in place (both dialects): the target joins this object's in-place chain.
    const ref = (target: Json, targetAt: string) => this.compile(target, targetAt, depth + 1, inPlace);
    const checks = this.keywords_(node, at, sub, ref);
    compiled = (instance, ctx, ev) => {
      charge(ctx, NODE_STEPS);
      if (++ctx.depth > this.limits.evaluationDepth) throw new ValidationLimit(`schema evaluation nested deeper than ${this.limits.evaluationDepth}`);
      try { for (const check of checks) if (!check(instance, ctx, ev)) return false; return true; }
      finally { ctx.depth--; }
    };
    return this.memo.get(node)!;
  }
  private refuse(at: string, key: string, detail: string): never { throw new JsonSchemaRefusal('unsupported-keyword', `${at}/${key}`, detail); }
  private invalid(at: string, key: string, detail: string): never { throw new JsonSchemaRefusal('invalid-schema', `${at}/${key}`, detail); }
  private count(at: string, amount: number): void {
    if ((this.keywords += amount) > this.limits.schemaKeywords) throw new JsonSchemaRefusal('limit', at, `more than ${this.limits.schemaKeywords} keywords`);
  }
  private pattern(source: Json, at: string): LinearPattern {
    if (typeof source !== 'string') this.invalid(at, '', 'a pattern is a string');
    const known = this.patterns.get(source);
    if (known) return known;
    let compiled: LinearPattern;
    try { compiled = compilePattern(source, { sourceMax: this.limits.patternSource, statesMax: this.limits.patternStates, repeatMax: this.limits.patternRepeat }); }
    catch (error) {
      if (!(error instanceof PatternRefusal)) throw error;
      throw new JsonSchemaRefusal(error.reason === 'invalid-pattern' ? 'invalid-schema' : error.reason === 'limit' ? 'limit' : 'unsupported-pattern', at, error.message);
    }
    if ((this.patternStates += compiled.states) > this.limits.schemaPatternStates) throw new JsonSchemaRefusal('limit', at, `patterns above ${this.limits.schemaPatternStates} states`);
    this.patterns.set(source, compiled);
    return compiled;
  }
  /** The checks of one schema object, in evaluation order (unevaluated* last, after every annotation of the object is collected). */
  private keywords_(node: JsonObject, at: string, sub: (value: Json, where: string, same: boolean) => Validate,
    ref: (target: Json, targetAt: string) => Validate): Validate[] {
    const allowed = KEYWORDS[this.dialect], other = KEYWORDS[this.dialect === '2020-12' ? 'draft-07' : '2020-12'];
    const draft07Ref = this.dialect === 'draft-07' && '$ref' in node;
    const keys = draft07Ref ? ['$ref'] : Object.keys(node);
    this.count(at, keys.length);
    for (const key of keys) {
      if (allowed.has(key) || this.annotations.has(key) || key.startsWith('x-')) continue;
      if (['$dynamicRef', '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor', '$vocabulary'].includes(key)) this.refuse(at, key, `${key} is not supported`);
      this.refuse(at, key, other.has(key) ? `${key} is not a ${this.dialect} keyword` : `unknown keyword ${key}`);
    }
    if (this.dialect === '2020-12' && Array.isArray(node['items'])) this.refuse(at, 'items', 'the array form of items is not a 2020-12 keyword (use prefixItems)');
    const has = (key: string) => keys.includes(key) && node[key] !== undefined;
    const nonNegative = (key: string) => { const v = node[key]; if (!Number.isSafeInteger(v) || (v as number) < 0) this.invalid(at, key, 'a non-negative integer'); return v as number; };
    const number = (key: string) => { const v = node[key]; if (typeof v !== 'number' || !Number.isFinite(v)) this.invalid(at, key, 'a number'); return v; };
    const schemaMap = (key: string) => { const v = node[key]; if (!isObject(v)) this.invalid(at, key, 'an object of schemas'); return new Map(Object.entries(v).map(([name, s]) => [name, sub(s, `${key}/${name}`, key === 'dependentSchemas' || key === 'dependencies')])); };
    const schemaList = (key: string, same: boolean) => { const v = node[key]; if (!Array.isArray(v) || (v.length === 0 && key !== 'prefixItems' && key !== 'items')) this.invalid(at, key, 'a non-empty array of schemas'); return (v as Json[]).map((s, k) => sub(s, `${key}/${k}`, same)); };
    const stringList = (value: Json, key: string) => { if (!Array.isArray(value) || value.some(item => typeof item !== 'string') || new Set(value).size !== value.length) this.invalid(at, key, 'an array of unique strings'); return value as string[]; };
    const checks: Validate[] = [];
    if (has('$ref')) {
      const value = node['$ref'];
      if (typeof value !== 'string') this.invalid(at, '$ref', 'a string');
      const target = this.resolve(value, `${at}/$ref`), validate = ref(target.node, target.at);
      checks.push((instance, ctx, ev) => isolated(validate, instance, ctx, ev));
    }
    if (draft07Ref) return checks;
    if (has('type')) {
      const raw = node['type'], types = typeof raw === 'string' ? [raw] : raw;
      if (!Array.isArray(types) || types.length === 0 || types.some(t => typeof t !== 'string' || !TYPES.has(t))) this.invalid(at, 'type', 'a type name or a non-empty array of type names');
      checks.push((instance, ctx) => types.some(t => matchesType(instance, t as string)) || fail(ctx, `must be ${types.join(' or ')}`));
    }
    if (has('enum')) {
      const values = node['enum'];
      if (!Array.isArray(values)) this.invalid(at, 'enum', 'an array');
      this.count(at, values.length);
      // Primitive members are a Set lookup (SameValueZero: 0 equals -0, as JSON numbers do); only object/array members compare deeply.
      const primitives = new Set(values.filter(value => typeof value !== 'object' || value === null)), containers = values.filter(value => typeof value === 'object' && value !== null);
      checks.push((instance, ctx) => (typeof instance !== 'object' || instance === null ? primitives.has(instance) : containers.some(value => equal(value, instance, ctx)))
        || fail(ctx, 'must be one of the enum values'));
    }
    if (has('const')) { const value = node['const']; checks.push((instance, ctx) => equal(value, instance, ctx) || fail(ctx, 'must equal the const value')); }
    this.numeric(at, has, number, checks);
    if (has('maxLength') || has('minLength') || has('pattern') || has('format')) {
      const max = has('maxLength') ? nonNegative('maxLength') : Infinity, min = has('minLength') ? nonNegative('minLength') : 0;
      const pattern = has('pattern') ? this.pattern(node['pattern'], `${at}/pattern`) : null;
      const format = node['format'];
      if (format !== undefined && typeof format !== 'string') this.invalid(at, 'format', 'a string');
      const checker = typeof format === 'string' && Object.hasOwn(this.formats, format) ? this.formats[format]! : null;
      checks.push((instance, ctx) => {
        if (typeof instance !== 'string') return true;
        if (max !== Infinity || min > 0) { const length = codePoints(instance, ctx); if (length > max) return fail(ctx, `must be at most ${max} characters`); if (length < min) return fail(ctx, `must be at least ${min} characters`); }
        if (pattern && !pattern.test(instance, ctx.budget)) return fail(ctx, `must match the pattern ${JSON.stringify(pattern.source)}`);
        if (checker && !checker(instance)) return fail(ctx, `must be a valid ${String(format)}`);
        return true;
      });
    }
    this.arrays(node, at, has, nonNegative, schemaList, sub, checks);
    this.objects(node, at, has, nonNegative, schemaMap, stringList, sub, checks);
    this.inPlace(node, at, has, schemaList, schemaMap, stringList, sub, checks);
    // unevaluated* read the annotations of every other keyword of this object, in-place applicators included: they run last.
    if (has('unevaluatedItems')) checks.push(this.unevaluatedItems(sub(node['unevaluatedItems'], 'unevaluatedItems', false)));
    if (has('unevaluatedProperties')) checks.push(this.unevaluatedProperties(sub(node['unevaluatedProperties'], 'unevaluatedProperties', false)));
    return checks;
  }
  private numeric(at: string, has: (key: string) => boolean, number: (key: string) => number, checks: Validate[]): void {
    const bounds: [string, (value: number, bound: number) => boolean, string][] = [['maximum', (v, b) => v <= b, 'at most'],
      ['exclusiveMaximum', (v, b) => v < b, 'less than'], ['minimum', (v, b) => v >= b, 'at least'], ['exclusiveMinimum', (v, b) => v > b, 'greater than']];
    for (const [key, holds, words] of bounds) if (has(key)) {
      const bound = number(key);
      checks.push((instance, ctx) => typeof instance !== 'number' || holds(instance, bound) || fail(ctx, `must be ${words} ${bound}`));
    }
    if (has('multipleOf')) {
      const divisor = number('multipleOf');
      if (divisor <= 0) this.invalid(at, 'multipleOf', 'a number greater than 0');
      checks.push((instance, ctx) => typeof instance !== 'number' || isMultipleOf(instance, divisor) || fail(ctx, `must be a multiple of ${divisor}`));
    }
  }
  private arrays(node: JsonObject, at: string, has: (key: string) => boolean, nonNegative: (key: string) => number, schemaList: (key: string, same: boolean) => Validate[],
    sub: (value: Json, where: string, same: boolean) => Validate, checks: Validate[]): void {
    if (has('maxItems') || has('minItems')) {
      const max = has('maxItems') ? nonNegative('maxItems') : Infinity, min = has('minItems') ? nonNegative('minItems') : 0;
      checks.push((instance, ctx) => !Array.isArray(instance) || (instance.length <= max || fail(ctx, `must have at most ${max} items`)) && (instance.length >= min || fail(ctx, `must have at least ${min} items`)));
    }
    if (has('uniqueItems')) {
      if (typeof node['uniqueItems'] !== 'boolean') this.invalid(at, 'uniqueItems', 'a boolean');
      if (node['uniqueItems']) checks.push((instance, ctx) => {
        if (!Array.isArray(instance)) return true;
        const seen = new Set<string>();
        for (const item of instance) { const text = canonical(item, ctx); if (seen.has(text)) return fail(ctx, 'must not contain duplicate items'); seen.add(text); }
        return true;
      });
    }
    const tuple = this.dialect === '2020-12' ? (has('prefixItems') ? schemaList('prefixItems', false) : []) : Array.isArray(node['items']) ? schemaList('items', false) : [];
    const restKey = this.dialect === '2020-12' ? 'items' : Array.isArray(node['items']) ? 'additionalItems' : 'items';
    const rest = has(restKey) ? sub(node[restKey], restKey, false) : null;
    if (tuple.length > 0 || rest) checks.push((instance, ctx, ev) => {
      if (!Array.isArray(instance)) return true;
      for (let k = 0; k < instance.length; k++) {
        const validate = k < tuple.length ? tuple[k]! : rest;
        if (!validate) break;
        ctx.path.push(k);
        if (ctx.path.length > this.limits.instanceDepth) throw new ValidationLimit(`instance nested deeper than ${this.limits.instanceDepth}`);
        const ok = validate(instance[k], ctx, this.track ? newEv() : null);
        ctx.path.pop();
        if (!ok) return false;
        if (ev) { if (k < tuple.length) ev.items.add(k); else ev.all = true; }
      }
      return true;
    });
    if (has('contains')) {
      const contains = sub(node['contains'], 'contains', false);
      const min = this.dialect === '2020-12' && has('minContains') ? nonNegative('minContains') : 1;
      const max = this.dialect === '2020-12' && has('maxContains') ? nonNegative('maxContains') : Infinity;
      checks.push((instance, ctx, ev) => {
        if (!Array.isArray(instance)) return true;
        let matched = 0;
        const message = ctx.message;
        for (let k = 0; k < instance.length; k++) {
          ctx.path.push(k);
          const ok = contains(instance[k], ctx, this.track ? newEv() : null);
          ctx.path.pop();
          if (ok) { matched++; ev?.items.add(k); if (!ev && matched >= min && max === Infinity) break; }
        }
        ctx.message = message;
        if (matched < min) return fail(ctx, `must contain at least ${min} matching item(s)`);
        return matched <= max || fail(ctx, `must contain at most ${max} matching item(s)`);
      });
    }
  }
  private unevaluatedItems(unevaluated: Validate): Validate {
    this.track = true;
    return (instance, ctx, ev) => {
      if (!Array.isArray(instance) || ev?.all) return true;
      for (let k = 0; k < instance.length; k++) {
        if (ev?.items.has(k)) continue;
        ctx.path.push(k);
        const ok = unevaluated(instance[k], ctx, newEv());
        ctx.path.pop();
        if (!ok) return false;
      }
      if (ev) ev.all = true;
      return true;
    };
  }
  private unevaluatedProperties(unevaluated: Validate): Validate {
    this.track = true;
    return (instance, ctx, ev) => {
      if (!isObject(instance)) return true;
      for (const key of Object.keys(instance)) {
        if (ev?.props.has(key)) continue;
        ctx.path.push(key);
        const ok = unevaluated(instance[key], ctx, newEv());
        ctx.path.pop();
        if (!ok) return false;
        ev?.props.add(key);
      }
      return true;
    };
  }
  private objects(node: JsonObject, at: string, has: (key: string) => boolean, nonNegative: (key: string) => number,
    schemaMap: (key: string) => Map<string, Validate>, stringList: (value: Json, key: string) => string[], sub: (value: Json, where: string, same: boolean) => Validate,
    checks: Validate[]): void {
    if (has('maxProperties') || has('minProperties')) {
      const max = has('maxProperties') ? nonNegative('maxProperties') : Infinity, min = has('minProperties') ? nonNegative('minProperties') : 0;
      checks.push((instance, ctx) => { if (!isObject(instance)) return true; const size = Object.keys(instance).length; return (size <= max || fail(ctx, `must have at most ${max} properties`)) && (size >= min || fail(ctx, `must have at least ${min} properties`)); });
    }
    if (has('required')) {
      const required = stringList(node['required'], 'required');
      checks.push((instance, ctx) => { if (!isObject(instance)) return true; charge(ctx, required.length); const missing = required.find(key => !Object.hasOwn(instance, key)); return missing === undefined || fail(ctx, `must have required property ${JSON.stringify(missing)}`); });
    }
    const properties = has('properties') ? schemaMap('properties') : null;
    const patterns = has('patternProperties') ? (() => {
      const v = node['patternProperties'];
      if (!isObject(v)) this.invalid(at, 'patternProperties', 'an object of schemas');
      return Object.entries(v).map(([source, s]) => [this.pattern(source, `${at}/patternProperties`), sub(s, `patternProperties/${source}`, false)] as const);
    })() : [];
    const additional = has('additionalProperties') ? sub(node['additionalProperties'], 'additionalProperties', false) : null;
    if (properties || patterns.length > 0 || additional) checks.push((instance, ctx, ev) => {
      if (!isObject(instance)) return true;
      for (const key of Object.keys(instance)) {
        charge(ctx, MEMBER_STEPS);
        const applied: Validate[] = [];
        const own = properties?.get(key);
        if (own) applied.push(own);
        for (const [pattern, validate] of patterns) if (pattern.test(key, ctx.budget)) applied.push(validate);
        if (applied.length === 0 && additional) applied.push(additional);
        if (applied.length === 0) continue;
        ctx.path.push(key);
        if (ctx.path.length > this.limits.instanceDepth) throw new ValidationLimit(`instance nested deeper than ${this.limits.instanceDepth}`);
        const ok = applied.every(validate => validate(instance[key], ctx, this.track ? newEv() : null));
        ctx.path.pop();
        if (!ok) return false;
        ev?.props.add(key);
      }
      return true;
    });
    if (has('propertyNames')) {
      const names = sub(node['propertyNames'], 'propertyNames', false);
      checks.push((instance, ctx) => !isObject(instance) || Object.keys(instance).every(key => names(key, ctx, null)));
    }
  }
  /** allOf / anyOf / oneOf / not / if-then-else / dependentSchemas / dependentRequired / dependencies: same instance, annotations merged only
   * from subschemas that passed (a failing `not`/`if`/branch contributes none). */
  private inPlace(node: JsonObject, at: string, has: (key: string) => boolean, schemaList: (key: string, same: boolean) => Validate[],
    schemaMap: (key: string) => Map<string, Validate>, stringList: (value: Json, key: string) => string[], sub: (value: Json, where: string, same: boolean) => Validate,
    checks: Validate[]): void {
    if (has('allOf')) { const all = schemaList('allOf', true); checks.push((instance, ctx, ev) => all.every(validate => isolated(validate, instance, ctx, ev))); }
    if (has('anyOf')) {
      const any = schemaList('anyOf', true);
      checks.push((instance, ctx, ev) => {
        let passed = false;
        for (const validate of any) if (isolated(validate, instance, ctx, ev)) { passed = true; if (!ev) break; }
        return passed || fail(ctx, `must match a schema in anyOf (${ctx.message})`);
      });
    }
    if (has('oneOf')) {
      const one = schemaList('oneOf', true);
      checks.push((instance, ctx, ev) => {
        let passed = 0, first: Evaluated | null = null;
        for (const validate of one) {
          const own = ev ? newEv() : null;
          if (validate(instance, ctx, own)) { passed++; first ??= own; if (passed > 1) return fail(ctx, 'must match exactly one schema in oneOf (more than one matched)'); }
        }
        if (passed === 0) return fail(ctx, `must match exactly one schema in oneOf (${ctx.message})`);
        if (first && ev) merge(first, ev);
        return true;
      });
    }
    if (has('not')) {
      const not = sub(node['not'], 'not', true);
      checks.push((instance, ctx, ev) => !isolated(not, instance, ctx, ev ? newEv() : null) || fail(ctx, 'must not match the schema in not'));
    }
    if (has('if')) {
      const test = sub(node['if'], 'if', true), then = has('then') ? sub(node['then'], 'then', true) : null, otherwise = has('else') ? sub(node['else'], 'else', true) : null;
      checks.push((instance, ctx, ev) => {
        const message = ctx.message;
        if (isolated(test, instance, ctx, ev)) return !then || isolated(then, instance, ctx, ev);
        ctx.message = message;
        return !otherwise || isolated(otherwise, instance, ctx, ev);
      });
    }
    const requiredBy = new Map<string, readonly string[]>(), schemaBy = new Map<string, Validate>();
    if (has('dependentRequired')) {
      const v = node['dependentRequired'];
      if (!isObject(v)) this.invalid(at, 'dependentRequired', 'an object of string arrays');
      for (const [name, list] of Object.entries(v)) requiredBy.set(name, stringList(list, `dependentRequired/${name}`));
    }
    if (has('dependentSchemas')) for (const [name, validate] of schemaMap('dependentSchemas')) schemaBy.set(name, validate);
    if (has('dependencies')) {
      const v = node['dependencies'];
      if (!isObject(v)) this.invalid(at, 'dependencies', 'an object');
      for (const [name, dependency] of Object.entries(v)) {
        if (Array.isArray(dependency)) requiredBy.set(name, stringList(dependency, `dependencies/${name}`));
        else schemaBy.set(name, sub(dependency, `dependencies/${name}`, true));
      }
    }
    if (requiredBy.size > 0 || schemaBy.size > 0) checks.push((instance, ctx, ev) => {
      if (!isObject(instance)) return true;
      for (const [name, required] of requiredBy) if (Object.hasOwn(instance, name)) {
        const missing = required.find(key => !Object.hasOwn(instance, key));
        if (missing !== undefined) return fail(ctx, `must have property ${JSON.stringify(missing)} when ${JSON.stringify(name)} is present`);
      }
      for (const [name, validate] of schemaBy) if (Object.hasOwn(instance, name) && !isolated(validate, instance, ctx, ev)) return false;
      return true;
    });
  }
}

/** The MCP SDK `jsonSchemaValidator` provider (structural): Deckent passes it to every SDK Client and Server. Each `getValidator` compiles the
 * whole reachable schema or throws a {@link JsonSchemaRefusal}; the returned function never throws for a JSON instance and never exceeds the
 * step budget (an exhausted budget or instance depth is `valid: false`, fail closed). */
export class DeckentJsonSchemaValidator {
  private readonly limits: JsonSchemaLimits;
  private readonly formats: Readonly<Record<string, (value: string) => boolean>>;
  private readonly annotations: ReadonlySet<string>;
  constructor(options: JsonSchemaValidatorOptions = {}) {
    this.limits = Object.freeze({ ...JSON_SCHEMA_LIMITS, ...options.limits });
    this.formats = Object.freeze({ ...options.formats });
    this.annotations = new Set([...JSON_SCHEMA_ANNOTATIONS, ...(options.annotations ?? [])]);
  }
  getValidator<T>(schema: object | boolean): JsonSchemaCheck<T> {
    const compiler = new Compiler(schema, this.limits, this.formats, this.annotations), root = compiler.compileRoot(), limits = this.limits;
    return (input: unknown): JsonSchemaResult<T> => {
      const ctx: Ctx = { budget: { remaining: limits.validationSteps }, path: [], depth: 0, message: '' };
      let valid: boolean;
      try { valid = root(input, ctx, compiler.track ? newEv() : null); }
      catch (error) {
        if (error instanceof StepBudgetExceeded || error instanceof ValidationLimit)
          return { valid: false, data: undefined, errorMessage: `#${pointer(ctx.path)}: not validated, ${error.message} (fail closed)` };
        throw error;
      }
      return valid ? { valid: true, data: input as T, errorMessage: undefined } : { valid: false, data: undefined, errorMessage: ctx.message || '#: invalid' };
    };
  }
}
