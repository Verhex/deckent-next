import { configSchemaNode, ProjectedConfigNode, projectConfigSchema, type ConfigSchemaNode } from './schema-node.js';
import { z } from 'zod';
import { CONFIG_FIELDS, configSections, configRegistryGeneration, createDefaultConfig, isRecord, isSensitiveConfigKey, redactSensitive, resolveLocale, messageText } from '#platform/index.js';
import { ConfigApplicationError, type ConfigDefinition, type ConfigFieldView, type ConfigSnapshot } from './contract.js';
import RESTART_EXEMPT from './restart-exempt.json' with { type: 'json' };

let definitionsGeneration = -1;
let definitionsMemo: ReadonlyMap<string, ConfigDefinition>;
export function configDefinitions(): ReadonlyMap<string, ConfigDefinition> {
  const generation = configRegistryGeneration();
  if (generation === definitionsGeneration) return new Map(definitionsMemo);
  const definitions = new Map<string, ConfigDefinition>();
  for (const [key, field] of Object.entries(CONFIG_FIELDS)) definitions.set(key, { schema: field.schema, ...field.metadata, ...(field.derivedFrom ? { derivedFrom: field.derivedFrom } : {}) });
  for (const [key, section] of configSections()) {
    const metadata = section.options.metadata;
    if (!metadata) throw new ConfigApplicationError('CONFIG_METADATA_MISSING');
    definitions.set(key, { schema: configSchemaNode(section.schema), ...metadata });
  }
  definitionsMemo = new Map([...definitions].map(([key, definition]) => [key, Object.freeze({ ...definition,
    binding: definition.binding.state === 'bound' ? Object.freeze({ ...definition.binding, consumers: Object.freeze([...definition.binding.consumers]) }) : Object.freeze({ ...definition.binding }), ...(definition.derivedFrom ? { derivedFrom: Object.freeze({ ...definition.derivedFrom }) } : {}) })]));
  definitionsGeneration = generation;
  return new Map(definitionsMemo);
}
/** BeUser KER-02: the refusal names the key the person asked for (control and format characters shown as `?`), never a literal `{key}`. */
const unknownKey = (keyPath: string) => new ConfigApplicationError('CONFIG_KEY_UNKNOWN', { key: keyPath.slice(0, 256).replace(/[\p{Cc}\p{Cf}]/gu, '?') });
export function configPath(keyPath: string): string[] {
  const path = keyPath.split('.');
  if (!path.length || path.some(part => !part || ['__proto__', 'constructor', 'prototype'].includes(part))) throw unknownKey(keyPath);
  return path;
}
export function isDerivedConfigPath(keyPath: string): boolean {
  const definition = configDefinitions().get(configPath(keyPath)[0]!);
  return Object.keys(definition?.derivedFrom ?? {}).some(key => keyPath === key || keyPath.startsWith(key + '.'));
}
export function atConfigPath(value: unknown, path: readonly string[]): unknown {
  for (const part of path) { if (!isRecord(value) && !Array.isArray(value)) return undefined; value = (value as Record<string, unknown>)[part]; }
  return value;
}
function unwrap(schema: ConfigSchemaNode): ConfigSchemaNode {
  if (schema instanceof z.ZodDefault || schema instanceof z.ZodPrefault) return unwrap(schema.unwrap() as z.ZodType);
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional || schema instanceof z.ZodReadonly) return unwrap(schema.unwrap() as z.ZodType);
  if (schema instanceof z.ZodPipe) return unwrap(schema.in as z.ZodType);
  return schema;
}
function childSchema(schema: ConfigSchemaNode, part: string): ConfigSchemaNode | undefined {
  const inner = unwrap(schema);
  if (inner instanceof ProjectedConfigNode) return inner.child(part);
  if (inner instanceof z.ZodObject) return inner.shape[part] as ConfigSchemaNode | undefined;
  if (inner instanceof z.ZodRecord) return inner.valueType as z.ZodType;
  if (inner instanceof z.ZodArray && /^(0|[1-9]\d*)$/.test(part)) return inner.element as z.ZodType;
  if (inner instanceof z.ZodUnion || inner instanceof z.ZodDiscriminatedUnion) {
    const children = [...inner.options].map(option => childSchema(option as z.ZodType, part)).filter((value): value is ConfigSchemaNode => value !== undefined);
    return children.length > 1 ? children.every(child => child instanceof z.ZodType)
      ? z.union(children as [z.ZodType, z.ZodType, ...z.ZodType[]])
      : new ProjectedConfigNode({ anyOf: children.map(child => { const projection = projectConfigSchema(child); delete projection['$schema']; return projection; }) }) : children[0];
  }
  return undefined;
}
let schemaGeneration = -1;
const schemaViews = new Map<string, unknown>();
function schemaCachePart(schema: ConfigSchemaNode, part: string): string {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodArray || inner instanceof z.ZodRecord || inner instanceof ProjectedConfigNode && (inner.item || inner.entry)) return '*';
  if (inner instanceof z.ZodUnion || inner instanceof z.ZodDiscriminatedUnion) return JSON.stringify([...inner.options]
    .map(option => childSchema(option as z.ZodType, part) ? schemaCachePart(option as z.ZodType, part) : null));
  return part;
}
export function definitionFor(keyPath: string) {
  const path = configPath(keyPath), definition = configDefinitions().get(path[0]!);
  if (!definition) throw unknownKey(keyPath);
  let schema = definition.schema;
  // Dynamic array indexes and record names share their registry node; cache growth follows schemas, not document values.
  const schemaPath = [path[0]!];
  for (const part of path.slice(1)) {
    schemaPath.push(schemaCachePart(schema, part));
    const child = childSchema(schema, part); if (!child) throw unknownKey(keyPath); schema = child;
  }
  return { path, definition, schema, schemaKey: JSON.stringify(schemaPath) };
}
/**
 * T3 L4: the typed value of a person's text for one key (the `/config` panel's free entry and `/config key=value`): the text itself when the
 * key's schema takes a string, otherwise its JSON; `ok: false` when neither fits. The write still validates the whole layer.
 */
export function parseConfigInput(keyPath: string, text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const { schema } = definitionFor(keyPath);
  if (schema.safeParse(text).success) return { ok: true, value: text };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false }; }
  return schema.safeParse(parsed).success ? { ok: true, value: parsed } : { ok: false };
}
/** L-KIT `--schema` (option B, no new dependency owner): a command's zod input contract as JSON Schema with the MCP tool list's projection,
 * so CLI, MCP and SDK describe one contract; the CLI prints it with `renderInputSchema`. */
export function projectInputSchema(schema: ConfigSchemaNode): unknown {
  return projectConfigSchema(schema);
}
function jsonSchemaView(schema: ConfigSchemaNode, schemaKey: string): unknown {
  const generation = configRegistryGeneration();
  if (schemaGeneration !== generation) { schemaViews.clear(); schemaGeneration = generation; }
  if (!schemaViews.has(schemaKey)) schemaViews.set(schemaKey, projectConfigSchema(schema));
  return schemaViews.get(schemaKey);
}
function redact(value: unknown, path: readonly string[], secrets: ReadonlySet<string> = new Set()): unknown {
  const pointer = '/' + path.map(part => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
  if (secrets.has(pointer)) return '[REDACTED]';
  if (path.some(isSensitiveConfigKey) || typeof value === 'string' && /^\$DECK:|^\$ENV:/.test(value)) return '[REDACTED]';
  if (typeof value === 'string') return redactSensitive(value);
  if (Array.isArray(value)) return value.map((item, i) => redact(item, [...path, String(i)], secrets));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, [...path, key], secrets)]));
  return value;
}
/** Schema defaults are values too: keep type/range structure while masking credential-bearing annotations. */
function schemaDisplayView(value: unknown, path: readonly string[], secrets: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map(child => schemaDisplayView(child, path, secrets));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (key === 'properties' && isRecord(child)) return [key, Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, schemaDisplayView(schema, [...path, name], secrets)]))];
    if (['default', 'const', 'enum', 'examples'].includes(key)) return [key, redact(child, path, secrets)];
    return [key, schemaDisplayView(child, path, secrets)];
  }));
}
export function configFieldView(snapshot: ConfigSnapshot, keyPath: string): ConfigFieldView {
  const { path, definition, schema, schemaKey } = definitionFor(keyPath), defaults = createDefaultConfig();
  const field = CONFIG_FIELDS[path[0] as keyof typeof CONFIG_FIELDS];
  const env = field?.environment.some(binding => binding.names.some(name => snapshot.env[name] !== undefined && snapshot.env[name] !== '') &&
    (() => { const bound = [path[0]!, ...(binding.path ?? [])]; return path.slice(0, bound.length).join('.') === bound.join('.'); })());
  const sourcePath = (definition.derivedFrom?.[keyPath] ?? keyPath).split('.');
  const source = env ? 'env' : atConfigPath(snapshot.project, sourcePath) !== undefined ? 'project' : atConfigPath(snapshot.global, sourcePath) !== undefined ? 'global' : 'default';
  const provenance = snapshot.effective['secretPaths'];
  const secretPaths = new Set<string>(Array.isArray(provenance) ? provenance.filter((item): item is string => typeof item === 'string') : []);
  const declaredDefault = schema.safeParse(undefined);
  const toolchains = snapshot.effective.toolchains, providers = [...new Set(toolchains.image.consents.flatMap(record => record.providers))];
  const derived = atConfigPath({ ...snapshot.effective, toolchains: { ...toolchains, image: { ...toolchains.image, providers } } }, path);
  const value = redact(derived, path, secretPaths), defaultValue = redact(atConfigPath(defaults, path) ?? (declaredDefault.success ? declaredDefault.data : undefined), path);
  const descriptionKey = schema.description ?? definition.descriptionKey;
  return { key: keyPath, value, defaultValue, source, descriptionKey,
    description: messageText(descriptionKey, resolveLocale(undefined, snapshot.env, snapshot.effective.language)) ?? descriptionKey, schema: schemaDisplayView(jsonSchemaView(schema, schemaKey), path, secretPaths),
    binding: definition.binding, apply: path.length > 1 && (RESTART_EXEMPT as Readonly<Record<string, readonly string[]>>)[path[0]!]?.includes(path[1]!) ? 'live' : definition.apply,
    redacted: value === '[REDACTED]' };
}
/** A card's bounded display copy of a value at `keyPath` (T3 L2): redacted like every field view, JSON text, cut with "…" past `max`. */
export function configDisplayText(snapshot: ConfigSnapshot, keyPath: string, value: unknown, max: number): string {
  const provenance = snapshot.effective['secretPaths'];
  const secretPaths = new Set<string>(Array.isArray(provenance) ? provenance.filter((item): item is string => typeof item === 'string') : []);
  const text = JSON.stringify(redact(value, configPath(keyPath), secretPaths) ?? null);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
export function allConfigKeys(snapshot: ConfigSnapshot): string[] {
  const keys: string[] = [];
  function visit(schema: ConfigSchemaNode, path: string[], value: unknown) {
    const inner = unwrap(schema);
    if (inner instanceof ProjectedConfigNode) {
      if (inner.options.length) { for (const option of inner.options) visit(option, path, value); return; }
      if (inner.properties) { for (const [key, child] of Object.entries(inner.properties)) visit(child, [...path, key], atConfigPath(value, [key])); return; }
      keys.push(path.join('.'));
      if (inner.item && Array.isArray(value)) value.forEach((item, index) => visit(inner.item!, [...path, String(index)], item));
      if (inner.entry && isRecord(value)) for (const [key, item] of Object.entries(value)) if (!key.includes('.')) visit(inner.entry!, [...path, key], item);
      return;
    }
    if (inner instanceof z.ZodUnion || inner instanceof z.ZodDiscriminatedUnion) { for (const option of inner.options) visit(option as z.ZodType, path, value); return; }
    if (inner instanceof z.ZodObject) { for (const [key, child] of Object.entries(inner.shape)) visit(child as ConfigSchemaNode, [...path, key], atConfigPath(value, [key])); return; }
    keys.push(path.join('.'));
    if (inner instanceof z.ZodArray && Array.isArray(value)) value.forEach((item, index) => visit(inner.element as z.ZodType, [...path, String(index)], item));
    if (inner instanceof z.ZodRecord && isRecord(value)) for (const [key, item] of Object.entries(value)) if (!key.includes('.')) visit(inner.valueType as z.ZodType, [...path, key], item);
  }
  for (const [key, definition] of configDefinitions()) visit(definition.schema, [key], snapshot.effective[key]);
  return [...new Set(keys)];
}
