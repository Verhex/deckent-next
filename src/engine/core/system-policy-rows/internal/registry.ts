import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import { BEUSER_EVALUATOR_ALLOWED_PAIRS, policyRoleSchema } from '#domain/index.js';
import asset from '../../../../../assets/beuser/system-policy-rows.json' with { type: 'json' };

const localId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,25}$/u);
const unique = (values: readonly string[]) => new Set(values).size === values.length;
/** Fixed workload ceiling is code; an asset cannot grant another principal or relax the AI floor. */
export const systemPolicyRowsSchema = z.object({ schemaVersion: z.literal(1), id: identitySchema, revision: z.number().int().positive().safe(),
  roles: z.array(policyRoleSchema).min(1).readonly(), bindings: z.array(z.object({ id: localId, actor: z.literal('beuser-evaluator'),
    roles: z.array(localId).min(1).readonly() }).strict().readonly()).min(1).readonly(),
}).strict().superRefine((value, context) => {
  const ids = value.roles.map(role => role.id);
  if (!unique(ids) || !unique(value.bindings.map(binding => binding.id))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'SYSTEM_POLICY_ROWS_DUPLICATE' });
  for (const role of value.roles) {
    if (!localId.safeParse(role.id).success || !unique(role.permissions.map(permission => permission.id))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'SYSTEM_POLICY_ROWS_INVALID' });
    for (const permission of role.permissions) {
      if (permission.effect !== 'allow' || permission.modeEligible !== undefined || permission.actions === 'all' || !unique(permission.actions)
        || !localId.safeParse(permission.id).success || permission.actions.some(action => !BEUSER_EVALUATOR_ALLOWED_PAIRS.some(([kind, allowed]) => kind === permission.resource.kind && allowed === action))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'SYSTEM_POLICY_ROWS_CEILING' });
      }
    }
  }
  for (const binding of value.bindings) if (!unique(binding.roles) || binding.roles.some(role => !ids.includes(role))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'SYSTEM_POLICY_ROWS_ROLE_UNKNOWN' });
}).readonly();
export type SystemPolicyRows = z.infer<typeof systemPolicyRowsSchema>;
/** Canonical object keys, ordered arrays; digest is content custody, not a signature or grant. */
export function systemPolicyCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(systemPolicyCanonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${systemPolicyCanonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export const systemPolicyDigest = (value: unknown) => createHash('sha256').update(systemPolicyCanonical(value)).digest('hex');
export function loadSystemPolicyRows(input: unknown, expectedDigest?: string): Readonly<{ data: SystemPolicyRows; digest: string }> {
  const data = systemPolicyRowsSchema.parse(input), digest = systemPolicyDigest(data);
  if (expectedDigest !== undefined && expectedDigest !== digest) throw new SystemPolicyRowsError('SYSTEM_POLICY_ROWS_DIGEST');
  return Object.freeze({ data, digest });
}
export const CORE_SYSTEM_POLICY_ROWS = loadSystemPolicyRows(asset);
export class SystemPolicyRowsError extends Error {
  constructor(readonly code: 'SYSTEM_POLICY_ROWS_DIGEST' | 'SYSTEM_POLICY_ROWS_INVALID') { super(code); this.name = 'SystemPolicyRowsError'; }
}
