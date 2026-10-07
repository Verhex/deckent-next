import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CONFIG_FIELDS } from '#platform/index.js';
import { configSections, configRegistryGeneration, createDefaultConfig } from '#platform/index.js';
import { isRecord, isSensitiveConfigKey, redactSensitive } from '#platform/index.js';
import { resolveLocale, MESSAGE_REGISTRY } from '#platform/index.js';
import { ConfigApplicationError, type ConfigDefinition, type ConfigFieldView, type ConfigSnapshot } from './contract.js';

export function configDefinitions(): ReadonlyMap<string, ConfigDefinition> {
  const definitions = new Map<string, ConfigDefinition>();
  for (const [key, field] of Object.entries(CONFIG_FIELDS)) definitions.set(key, { schema: field.schema, ...field.metadata });
  for (const [key, section] of configSections()) {
    const metadata = section.options.metadata;
    if (!metadata) throw new ConfigApplicationError('CONFIG_METADATA_MISSING');
    definitions.set(key, { schema: section.schema, ...metadata });
  }
  return definitions;
}
export function configPath(keyPath: string): string[] {
  const path = keyPath.split('.');
  if (!path.length || path.some(part => !part || ['__proto__', 'constructor', 'prototype'].includes(part))) throw new ConfigApplicationError('CONFIG_KEY_UNKNOWN');
  return path;
}
export function atConfigPath(value: unknown, path: readonly string[]): unknown {
  for (const part of path) { if (!isRecord(value) && !Array.isArray(value)) return undefined; value = (value as Record<string, unknown>)[part]; }
  return value;
}
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodDefault) return unwrap(schema._def.innerType);
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional || schema instanceof z.ZodReadonly) return unwrap(schema.unwrap());
  if (schema instanceof z.ZodEffects) return unwrap(schema.innerType());
  return schema;
}
function childSchema(schema: z.ZodTypeAny, part: string): z.ZodTypeAny | undefined {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodObject) return inner.shape[part] as z.ZodTypeAny | undefined;
  if (inner instanceof z.ZodRecord) return inner.valueSchema;
  if (inner instanceof z.ZodArray && /^(0|[1-9]\d*)$/.test(part)) return inner.element;
  if (inner instanceof z.ZodUnion || inner instanceof z.ZodDiscriminatedUnion) {
    const children = [...inner.options].map(option => childSchema(option, part)).filter((value): value is z.ZodTypeAny => value !== undefined);
    return children.length > 1 ? z.union(children as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]) : children[0];
  }
  return undefined;
}
let schemaGeneration = -1;
const schemaViews = new Map<string, unknown>();
function schemaCachePart(schema: z.ZodTypeAny, part: string): string {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodArray || inner instanceof z.ZodRecord) return '*';
  if (inner instanceof z.ZodUnion || inner instanceof z.ZodDiscriminatedUnion) return JSON.stringify([...inner.options]
    .map(option => childSchema(option, part) ? schemaCachePart(option, part) : null));
  return part;
}
export function definitionFor(keyPath: string) {
  const path = configPath(keyPath), definition = configDefinitions().get(path[0]!);
  if (!definition) throw new ConfigApplicationError('CONFIG_KEY_UNKNOWN');
  let schema = definition.schema;
  // Dynamic array indexes and record names share their registry node; cache growth follows schemas, not document values.
  const schemaPath = [path[0]!];
  for (const part of path.slice(1)) {
    schemaPath.push(schemaCachePart(schema, part));
    const child = childSchema(schema, part); if (!child) throw new ConfigApplicationError('CONFIG_KEY_UNKNOWN'); schema = child;
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
function jsonSchemaView(schema: z.ZodTypeAny, schemaKey: string): unknown {
  const generation = configRegistryGeneration();
  if (schemaGeneration !== generation) { schemaViews.clear(); schemaGeneration = generation; }
  if (!schemaViews.has(schemaKey)) schemaViews.set(schemaKey, zodToJsonSchema(schema, { $refStrategy: 'none' }));
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
  const field = Object.entries(CONFIG_FIELDS).find(([key]) => key === path[0])?.[1];
  const env = field?.environment.some(binding => binding.names.some(name => snapshot.env[name] !== undefined && snapshot.env[name] !== '') &&
    (() => { const bound = [path[0]!, ...(binding.path ?? [])]; return path.slice(0, bound.length).join('.') === bound.join('.'); })());
  const source = env ? 'env' : atConfigPath(snapshot.project, path) !== undefined ? 'project' : atConfigPath(snapshot.global, path) !== undefined ? 'global' : 'default';
  const provenance = snapshot.effective['secretPaths'];
  const secretPaths = new Set<string>(Array.isArray(provenance) ? provenance.filter((item): item is string => typeof item === 'string') : []);
  const declaredDefault = schema.safeParse(undefined);
  const value = redact(atConfigPath(snapshot.effective, path), path, secretPaths), defaultValue = redact(atConfigPath(defaults, path) ?? (declaredDefault.success ? declaredDefault.data : undefined), path);
  return { key: keyPath, value, defaultValue, source, descriptionKey: definition.descriptionKey,
    description: (MESSAGE_REGISTRY.catalogs[resolveLocale(undefined, snapshot.env, snapshot.effective.language)] as Readonly<Record<string, string>>)[definition.descriptionKey] ?? definition.descriptionKey, schema: schemaDisplayView(jsonSchemaView(schema, schemaKey), path, secretPaths),
    binding: definition.binding, apply: definition.apply, redacted: value === '[REDACTED]' };
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
  function visit(schema: z.ZodTypeAny, path: string[], value: unknown) {
    const inner = unwrap(schema);
    if (inner instanceof z.ZodUnion || inner instanceof z.ZodDiscriminatedUnion) { for (const option of inner.options) visit(option, path, value); return; }
    if (inner instanceof z.ZodObject) { for (const [key, child] of Object.entries(inner.shape)) visit(child as z.ZodTypeAny, [...path, key], atConfigPath(value, [key])); return; }
    keys.push(path.join('.'));
    if (inner instanceof z.ZodArray && Array.isArray(value)) value.forEach((item, index) => visit(inner.element, [...path, String(index)], item));
    if (inner instanceof z.ZodRecord && isRecord(value)) for (const [key, item] of Object.entries(value)) if (!key.includes('.')) visit(inner.valueSchema, [...path, key], item);
  }
  for (const [key, definition] of configDefinitions()) visit(definition.schema, [key], snapshot.effective[key]);
  return [...new Set(keys)];
}
