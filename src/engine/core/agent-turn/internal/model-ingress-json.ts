import policy from './model-ingress-policy.json' with { type: 'json' };
import { projectModelIngressField, type ModelIngressProjection } from './model-ingress-project.js';

export type ModelIngressRecorder = (notice: ModelIngressProjection) => Promise<void>;
export type ModelIngressArgumentsResult = { readonly ok: true } | { readonly ok: false; readonly text: string };

/** Parsed JSON only: escape spelling cannot bypass classification. Keys and nested values share one path.
 * Never substitute a projected string into an executable argument. Pure tests may omit the audit port. */
export async function checkModelIngressArguments(value: unknown, record?: ModelIngressRecorder): Promise<ModelIngressArgumentsResult> {
  const pending: unknown[] = [value];
  let refused: ModelIngressProjection | null = null, auditFailed = false;
  const check = async (text: string) => {
    const notice = projectModelIngressField(text);
    if (notice.disposition === 'unchanged') return;
    if (!refused || notice.disposition === 'quarantine') refused = notice;
    try { await record?.(notice); } catch { auditFailed = true; }
  };
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') await check(item);
    else if (Array.isArray(item)) for (const child of item) pending.push(child);
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { await check(key); pending.push(child); }
  }
  const notice = refused as ModelIngressProjection | null;
  return notice ? { ok: false, text: `ingress-refused:arguments (${auditFailed || notice.disposition === 'quarantine' ? notice.withheld
    : `[hidden-unicode: ${notice.codePoints} cp, argument, ${notice.fieldDigest.slice(0, 12)}]`})` } : { ok: true };
}

/** Project schema prose only; property names, refs, required/default/enum values keep their exact meaning.
 * Iterative traversal also covers definitions/combinators. Original schema custody and pins are untouched. */
export async function projectModelIngressSchema<T extends object>(schema: T, record?: ModelIngressRecorder): Promise<T> {
  const projected = Array.isArray(schema) ? [] : {};
  const pending: { source: object; target: Record<string, unknown>; schemaMap?: boolean }[] = [{ source: schema, target: projected as Record<string, unknown> }];
  let changed = false;
  while (pending.length) {
    const { source, target, schemaMap } = pending.pop()!;
    for (const [key, value] of Object.entries(source)) {
      let shown = value;
      if (!schemaMap && policy.schemaTextFields.includes(key) && typeof value === 'string') {
        const notice = projectModelIngressField(value);
        if (notice.disposition !== 'unchanged') {
          changed = true;
          shown = notice.disposition === 'quarantine' ? notice.withheld : notice.modelText;
          try { await record?.(notice); } catch { shown = notice.withheld; }
        }
      } else if (value && typeof value === 'object' && (schemaMap || !['enum', 'const', 'default', 'examples'].includes(key))) {
        shown = Array.isArray(value) ? [] : {};
        pending.push({ source: value, target: shown as Record<string, unknown>,
          schemaMap: !schemaMap && ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key) });
      }
      // Define an own data property, including __proto__; never invoke Object.prototype's setter.
      Object.defineProperty(target, key, { value: shown, enumerable: true, configurable: true, writable: true });
    }
  }
  return changed ? projected as T : schema;
}
