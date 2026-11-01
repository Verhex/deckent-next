/* Zod 3.25.76 datetime / UUID / email expressions, adapted under the upstream license:
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { z } from 'zod';
// Persisted contracts retain Zod 3.25.76 acceptance (v3/types.js:368,384,406-432; MIT).
const dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
function timeRegexSource(args: { precision?: number | null }) {
  let seconds = `[0-5]\\d`;
  if (args.precision) seconds += `\\.\\d{${args.precision}}`;
  else if (args.precision == null) seconds += `(\\.\\d+)?`;
  return `([01]\\d|2[0-3]):[0-5]\\d(:${seconds})${args.precision ? '+' : '?'}`;
}
// Adapted from https://stackoverflow.com/a/3143231
function datetimeRegex(args: { offset?: boolean; local?: boolean; precision?: number | null }) {
  const offsets = [args.local ? 'Z?' : 'Z'];
  if (args.offset) offsets.push(`([+-]\\d{2}:?\\d{2})`);
  return new RegExp(`^${dateRegexSource}T${timeRegexSource(args)}(${offsets.join('|')})$`);
}
const uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
const emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;
export function persistedDateTime(options: { offset?: boolean; local?: boolean; precision?: number | null } = {}) {
  return z.string().regex(datetimeRegex(options)).meta({ format: 'date-time' });
}
let uuidSchema: z.ZodString | undefined, emailSchema: z.ZodString | undefined, urlSchema: z.ZodString | undefined;
export const persistedUuid = () => uuidSchema ??= z.string().regex(uuidRegex).meta({ format: 'uuid' });
export const persistedEmail = () => emailSchema ??= z.string().regex(emailRegex).meta({ format: 'email' });
// URL.canParse and new URL use the same WHATWG parser, without v4 URL normalization.
export const persistedUrl = () => urlSchema ??= z.string().refine(value => URL.canParse(value), { params: { legacyCode: 'invalid_string' } }).meta({ format: 'uri' });
// Zod 3 int checked integrality; safe bounds were a separate check.
let integerSchema: z.ZodNumber | undefined;
export const persistedInteger = () => integerSchema ??= z.number().refine(Number.isInteger, { params: { legacyCode: 'invalid_type' } }).meta({ type: 'integer' });
export function persistedIssueCode(issue: { readonly code?: string | undefined; readonly discriminator?: string | undefined; readonly values?: readonly unknown[] | undefined; readonly params?: Readonly<Record<string, unknown>> | undefined }): string {
  if (typeof issue.params?.['legacyCode'] === 'string') return issue.params['legacyCode'];
  if (issue.code === 'invalid_union' && issue.discriminator !== undefined) return 'invalid_union_discriminator';
  if (issue.code === 'invalid_format') return 'invalid_string';
  if (issue.code === 'invalid_value') return issue.values?.length === 1 ? 'invalid_literal' : 'invalid_enum_value';
  return issue.code ?? 'SECTION_INVALID';
}
/** The v3 number parser allowed infinities unless a bound/finite/int check refused them. */
export function numberJsonBounds(schema: z.core.$ZodType): Record<string, number> {
  const output: Record<string, number> = {};
  for (const check of schema._zod.def.checks ?? []) {
    const definition = check._zod.def as { check: string; value?: number; inclusive?: boolean };
    if (definition.check === 'greater_than') output[definition.inclusive ? 'minimum' : 'exclusiveMinimum'] = definition.value!;
    if (definition.check === 'less_than') output[definition.inclusive ? 'maximum' : 'exclusiveMaximum'] = definition.value!;
  }
  return output;
}
export function persistedNumber(schema: z.ZodNumber) {
  return z.unknown().transform((value, context): number => {
    if (value === Infinity || value === -Infinity) {
      const checks = (schema.def.checks ?? []).map(check => check._zod.def as { check: string; value: number; inclusive: boolean });
      if (checks.every(check => check.check === 'greater_than' || check.check === 'less_than')) {
        const failures = checks.filter(check => check.check === 'greater_than'
          ? check.inclusive ? value < check.value : value <= check.value
          : check.inclusive ? value > check.value : value >= check.value);
        if (!failures.length) return value;
        for (const check of failures) {
          if (check.check === 'greater_than') context.addIssue({ code: 'too_small', origin: 'number', minimum: check.value, inclusive: check.inclusive });
          else context.addIssue({ code: 'too_big', origin: 'number', maximum: check.value, inclusive: check.inclusive });
        }
        return z.NEVER;
      }
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues) context.addIssue({ ...issue });
    return z.NEVER;
  }).meta({ type: 'number', ...numberJsonBounds(schema) });
}
