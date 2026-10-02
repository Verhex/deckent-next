import { z } from 'zod';
import { ConfigValidationError, assertSafeKeys, isRecord, assertConfigSecretPolicies } from '#platform/index.js';
import { configDefinitions } from './registry.js';
/** Validate only authored overlay members against the original registry nodes; merged semantics remain in validateConfig. */
export function validateAuthoredConfigOverlay(document: Record<string, unknown>): void {
  assertSafeKeys(document); assertConfigSecretPolicies(document);
  function visit(schema: z.ZodTypeAny, value: unknown, path: string[]) {
    let inner = schema;
    while (inner instanceof z.ZodDefault || inner instanceof z.ZodOptional || inner instanceof z.ZodNullable || inner instanceof z.ZodReadonly || inner instanceof z.ZodEffects) {
      if (inner instanceof z.ZodDefault) inner = inner._def.innerType;
      else if (inner instanceof z.ZodEffects) inner = inner.innerType(); else inner = inner.unwrap();
    }
    if ((inner instanceof z.ZodUnion || inner instanceof z.ZodDiscriminatedUnion) && isRecord(value)) {
      const discriminator = inner instanceof z.ZodDiscriminatedUnion ? inner.discriminator : null;
      const candidates = [...inner.options].filter(option => discriminator === null || !Object.hasOwn(value, discriminator) ||
        (option as z.AnyZodObject).shape[discriminator]?.safeParse(value[discriminator]).success);
      if (!candidates.length) throw new ConfigValidationError([{ path: [...path, discriminator ?? ''].join('.'), reason: 'invalid_union_discriminator' }]);
      let first: ConfigValidationError | undefined;
      for (const candidate of candidates) { try { visit(candidate, value, path); return; } catch (error) {
        if (!(error instanceof ConfigValidationError)) throw error; first ??= error;
      } }
      throw first;
    }
    if (inner instanceof z.ZodObject && isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        const member = inner.shape[key] as z.ZodTypeAny | undefined;
        if (!member) throw new ConfigValidationError([{ path: [...path, key].join('.'), reason: 'unrecognized_keys' }]);
        visit(member, child, [...path, key]);
      }
      return;
    }
    if (inner instanceof z.ZodRecord && isRecord(value)) {
      for (const [key, child] of Object.entries(value)) { const checked = inner.keySchema.safeParse(key);
        if (!checked.success) throw new ConfigValidationError([{ path: [...path, key].join('.'), reason: 'invalid_key' }]);
        visit(inner.valueSchema, child, [...path, key]);
      }
      return;
    }
    const checked = schema.safeParse(value);
    if (!checked.success) throw new ConfigValidationError(checked.error.issues.map(issue => ({ path: [...path, ...issue.path].join('.'), reason: issue.code })));
  }
  const definitions = configDefinitions();
  for (const [key, value] of Object.entries(document)) {
    const definition = definitions.get(key);
    if (!definition) throw new ConfigValidationError([{ path: key, reason: 'unrecognized_keys' }]);
    visit(definition.schema, value, [key]);
  }
}
/** SDK callers must preserve the same JSON values the CLI accepts; undefined/nonfinite/cyclic input cannot be silently serialized. */
export function assertConfigJsonValue(value: unknown, path: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if ((!isRecord(value) && !Array.isArray(value)) || ancestors.has(value)) throw new ConfigValidationError([{ path, reason: 'JSON_REQUIRED' }]);
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new ConfigValidationError([{ path, reason: 'JSON_REQUIRED' }]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = typeof key === 'string' ? descriptors[key] : undefined;
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key as string)) throw new ConfigValidationError([{ path, reason: 'JSON_REQUIRED' }]);
    assertConfigJsonValue(descriptor.value, path, ancestors);
  }
  ancestors.delete(value);
}
