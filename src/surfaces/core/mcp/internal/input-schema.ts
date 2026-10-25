type Schema = Record<string, unknown>;
const isObjectSchema = (value: unknown): value is Schema => !!value && typeof value === 'object' && !Array.isArray(value) && (value as Schema)['type'] === 'object';
const isEmpty = (value: unknown) => !!value && typeof value === 'object' && Object.keys(value).length === 0;

/**
 * One object at the root of an advertised `inputSchema` (Ek A): clients that hand MCP tool schemas to a model API keep only one variant of a root
 * `anyOf` (control_run reached Claude Code as `hold` alone). A root union of object variants is merged into one object — every variant's
 * properties, a differing const/enum joined into one enum, other differences as a property-level `anyOf`; required = in every variant. A root
 * `allOf` of objects is merged the same way (required = in any part, differences as `allOf`). Advertisement only: every call is still parsed by
 * the tool's exact zod schema, so a variant's own required fields and exclusions are enforced at the wire.
 */
export function rootObjectSchema(schema: Schema): Schema {
  const key = Array.isArray(schema['anyOf']) ? 'anyOf' : Array.isArray(schema['allOf']) ? 'allOf' : null;
  if (!key) return schema;
  const parts = (schema[key] as unknown[]).filter(part => !(key === 'allOf' && isEmpty(part)));
  if (!parts.length || !parts.every(isObjectSchema)) return schema;
  const values = new Map<string, unknown[]>();
  for (const part of parts) for (const [name, value] of Object.entries((part['properties'] ?? {}) as Schema)) values.set(name, [...(values.get(name) ?? []), value]);
  const requiredOf = (part: Schema) => (part['required'] ?? []) as string[];
  const required = key === 'anyOf' ? parts.map(requiredOf).reduce((kept, next) => kept.filter(name => next.includes(name)))
    : [...new Set(parts.flatMap(requiredOf))];
  const rest = { ...schema }; delete rest[key];
  return { ...rest, type: 'object', properties: Object.fromEntries([...values].map(([name, list]) => [name, mergeProperty(list, key)])),
    ...(required.length ? { required } : {}), ...(parts.every(part => part['additionalProperties'] === false) ? { additionalProperties: false } : {}) };
}

function mergeProperty(values: readonly unknown[], key: 'anyOf' | 'allOf'): unknown {
  const distinct = [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
  if (distinct.length === 1) return distinct[0];
  const literals = distinct.map(value => { const entry = value as Schema; return 'const' in entry ? [entry['const']] : Array.isArray(entry['enum']) ? entry['enum'] as unknown[] : null; });
  const type = (distinct[0] as Schema)['type'];
  if (key === 'anyOf' && literals.every(list => list !== null) && distinct.every(value => (value as Schema)['type'] === type))
    return { ...(type === undefined ? {} : { type }), enum: [...new Set(literals.flat())] };
  return { [key]: distinct };
}
