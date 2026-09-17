import { z } from 'zod';
import { validateApiMode } from '#providers/core/registry/index.js';
import { isDeepStrictEqual } from 'node:util';
import { ConfigValidationError, CONFIG_CONTRACT_SINCE, registerConfigSection } from '#kernel/index.js';
const units = z.enum(['percent', 'requests', 'tokens', 'credits', 'usd']);
const values = z.object({
  ratioEnforcement: z.enum(['enforce', 'observe_only']).optional(),
  warnAtRatio: z.number().finite().min(0).max(1).optional(),
  blockAtRatio: z.number().finite().min(0).max(1).optional(),
  minimumRemaining: z.record(units, z.number().finite().nonnegative()).optional(),
}).strict();
// Identity semantics remain provider-owned; K1 preserves exact selector equality.
const policy = z.object({ selector: z.record(z.unknown()), values }).strict();
export const LIMIT_SCHEMA = z.object({ schemaVersion: z.literal(1), policies: z.array(policy) }).strict();
function invalid(): never { throw new ConfigValidationError([{ path: 'provider_limits', reason: 'POLICY_AUTHORITY_INVALID' }]); }
function read(value: unknown, complete: boolean) {
  const parsed = LIMIT_SCHEMA.safeParse(value);
  if (!parsed.success) return invalid();
  const seen: unknown[] = [];
  for (const entry of parsed.data.policies) {
    if (!Object.keys(entry.selector).length || seen.some(s => isDeepStrictEqual(s, entry.selector))) invalid();
    seen.push(entry.selector);
    const v = entry.values;
    if (complete && (v.warnAtRatio === undefined || v.blockAtRatio === undefined)) invalid();
    if (v.warnAtRatio !== undefined && v.blockAtRatio !== undefined && v.warnAtRatio > v.blockAtRatio) invalid();
  }
  return parsed.data;
}
export function assertProviderLimitPolicyLayerPrecedence(global: unknown, project: unknown): void {
  const parent = global === undefined ? undefined : read(global, true);
  if (project === undefined) return;
  if (!parent) invalid();
  for (const entry of read(project, false).policies) {
    const ancestor = parent.policies.find(p => isDeepStrictEqual(p.selector, entry.selector));
    if (!ancestor) invalid();
    const p = ancestor.values, v = entry.values;
    if (v.ratioEnforcement === 'observe_only' && (p.ratioEnforcement ?? 'enforce') === 'enforce') invalid();
    if ((v.warnAtRatio ?? p.warnAtRatio!) > p.warnAtRatio! || (v.blockAtRatio ?? p.blockAtRatio!) > p.blockAtRatio!) invalid();
    for (const [unit, floor] of Object.entries(v.minimumRemaining ?? {})) {
      const parentFloor = p.minimumRemaining?.[unit as z.infer<typeof units>] ?? 0;
      if (floor < parentFloor || (parentFloor === 0 && floor <= 0)) invalid();
    }
    if ((v.warnAtRatio ?? p.warnAtRatio!) > (v.blockAtRatio ?? p.blockAtRatio!)) invalid();
  }
}

let registered = false;
/** Called by application ingress before config resolution; kernel never imports provider policy. */
export function registerProviderConfig(): void {
  if (registered) return;
  registerConfigSection('provider_limits', LIMIT_SCHEMA, { optional: true, metadata: { descriptionKey: 'config.field.provider_limits', tier: 'core', since: CONFIG_CONTRACT_SINCE }, validateEffective: validateApiMode, validateLayers: assertProviderLimitPolicyLayerPrecedence });
  registered = true;
}
