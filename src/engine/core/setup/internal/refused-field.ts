import { z } from 'zod';
import limits from './limits.json' with { type: 'json' };

/** Placeholders for path parts that come from the refused input, not from the schema: a key the schema does not own, a record entry. */
const REFUSED_UNKNOWN_KEY = '<unknown-key>', REFUSED_ENTRY = '<entry>';
const MAX_DEPTH = limits.refusedFieldSchemaDepth; // schema wrappers and union branches walked per path segment

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  let current: z.ZodTypeAny = schema;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable || current instanceof z.ZodDefault || current instanceof z.ZodCatch
      || current instanceof z.ZodReadonly || current instanceof z.ZodPrefault) current = current.unwrap() as z.ZodType;
    else if (current instanceof z.ZodLazy) current = current.unwrap() as z.ZodType;
    else if (current instanceof z.ZodPipe) current = current.in as z.ZodType;
    else return current;
  }
  return undefined;
}
type Step = Readonly<{ label: string; next?: z.ZodTypeAny | undefined }>;
/** One path segment as the schema owns it: a declared object key or a position; anything input-derived becomes a placeholder. */
function step(schema: z.ZodTypeAny, segment: string | number, depth = 0): Step {
  const current = unwrap(schema);
  if (!current || depth > MAX_DEPTH) return { label: REFUSED_UNKNOWN_KEY };
  if (current instanceof z.ZodObject) {
    const shape = current.shape as Record<string, z.ZodTypeAny>;
    return typeof segment === 'string' && Object.hasOwn(shape, segment) ? { label: segment, next: shape[segment] } : { label: REFUSED_UNKNOWN_KEY };
  }
  if (typeof segment === 'number') {
    if (current instanceof z.ZodArray) return { label: String(segment), next: current.element as z.ZodType };
    if (current instanceof z.ZodTuple) return { label: String(segment), next: (current.def.items[segment] ?? current.def.rest ?? undefined) as z.ZodType | undefined };
    if (current instanceof z.ZodSet) return { label: String(segment), next: current.def.valueType as z.ZodType };
  }
  if (current instanceof z.ZodRecord || current instanceof z.ZodMap) return { label: REFUSED_ENTRY };
  const options: readonly z.ZodTypeAny[] = current instanceof z.ZodUnion || current instanceof z.ZodDiscriminatedUnion ? current.options as readonly z.ZodType[]
    : current instanceof z.ZodIntersection ? [current.def.left as z.ZodType, current.def.right as z.ZodType] : [];
  for (const option of options) { const found = step(option, segment, depth + 1); if (found.next) return found; }
  return { label: typeof segment === 'number' ? String(segment) : REFUSED_UNKNOWN_KEY };
}
/**
 * The first refused fact's dotted path for a one-line notice (FIX14; Astra R1 alpha.56.1): only the schema's own key names and positions.
 * A key the schema does not own (an unrecognized key, a record entry) can come from the input and could carry a secret, so it is never
 * echoed: it becomes `<unknown-key>` / `<entry>` (several unrecognized keys: `<unknown-key>(N)`). Never a value; bounded.
 */
export function refusedSchemaField(error: unknown, schema: z.ZodTypeAny): string {
  const issue = (error as { issues?: readonly { path?: readonly (string | number)[]; keys?: readonly string[] }[] } | null)?.issues?.[0];
  if (!issue) return '-';
  const labels: string[] = []; let current: z.ZodTypeAny | undefined = schema;
  for (const segment of issue.path ?? []) {
    const found: Step = current ? step(current, segment) : { label: typeof segment === 'number' ? String(segment) : REFUSED_UNKNOWN_KEY };
    labels.push(found.label === REFUSED_UNKNOWN_KEY || found.label === REFUSED_ENTRY ? found.label : found.label.replace(/[^A-Za-z0-9_:-]/gu, '?'));
    current = found.next;
  }
  const unknown = issue.keys?.length ?? 0;
  if (unknown) labels.push(unknown > 1 ? `${REFUSED_UNKNOWN_KEY}(${unknown})` : REFUSED_UNKNOWN_KEY);
  return labels.length ? labels.join('.').slice(0, 120) : '-';
}
