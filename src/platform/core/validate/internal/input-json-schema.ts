import { numberJsonBounds } from './persisted-schema.js';
import { z } from 'zod';

/** Native conversion with the existing draft-07 wire projection, independent of parser acceptance. */
export function toInputJsonSchema(schema: z.core.$ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-07', io: 'input', unrepresentable: ({ zodSchema }) =>
    zodSchema._zod.def.type === 'custom' ? {} : zodSchema._zod.def.type === 'undefined' ? { not: {} } : 'throw', override({ zodSchema, jsonSchema }) {
    if (zodSchema instanceof z.ZodPipe && zodSchema.out._zod.def.type !== 'transform') {
      const parts = [zodSchema.in, zodSchema.out].map(part => { const projection = toInputJsonSchema(part); delete projection['$schema']; return projection; });
      for (const key of Object.keys(jsonSchema)) delete (jsonSchema as Record<string, unknown>)[key];
      Object.assign(jsonSchema, { allOf: parts });
    }
    if (zodSchema instanceof z.ZodObject) {
      const required = Object.entries(zodSchema.shape).filter(([, member]) => {
        try { return !z.safeParse(member as z.core.$ZodType, undefined).success; } catch { return false; }
      }).map(([key]) => key);
      if (required.length) jsonSchema.required = required; else delete jsonSchema.required;
      if (!zodSchema.def.catchall) jsonSchema.additionalProperties = false;
    }
    if (zodSchema._zod.def.type === 'readonly') delete jsonSchema.readOnly;
    if (zodSchema._zod.def.type === 'union' && 'discriminator' in zodSchema._zod.def && jsonSchema.oneOf) { jsonSchema.anyOf = jsonSchema.oneOf; delete jsonSchema.oneOf; }
    if (['date-time', 'uuid', 'email'].includes(String(jsonSchema.format))) delete jsonSchema.pattern;
    if (zodSchema._zod.def.type !== 'number') return;
    // The former converter retained the last authored bound of each kind (including .safe() bounds).
    delete jsonSchema.minimum; delete jsonSchema.maximum; delete jsonSchema.exclusiveMinimum; delete jsonSchema.exclusiveMaximum;
    Object.assign(jsonSchema, numberJsonBounds(zodSchema));
  } });
}
