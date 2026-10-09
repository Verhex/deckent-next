import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { policyGrantSchema, type PolicyGrant } from './schema.js';
import type { PolicyChange } from './administer.js';

const selection = z.union([z.literal('all'), z.array(identitySchema).min(1).max(32).readonly()]);
/** Mutable capability policy is catalog data. Installation cells explicitly cover all scopes; a scope selection never disguises them. */
export const mcpCapabilityGroupSchema = z.object({ schemaVersion: z.literal(1), id: z.string().regex(/^[a-z][a-z0-9.-]{0,47}$/u),
  version: z.number().int().positive().safe(), labelKey: identitySchema, noteKey: identitySchema,
  proposed: z.boolean().default(false),
  cells: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/u), tools: z.record(identitySchema, z.array(identitySchema).min(1).max(16).readonly()).readonly(), actions: z.array(identitySchema).min(1).max(16).readonly(),
    resource: z.object({ kind: identitySchema, ids: selection }).strict().readonly(), scope: z.enum(['selected', 'installation']),
    source: z.enum(['literal', 'owned-pools', 'configured-target']).default('literal') }).strict()
    .refine(cell => Object.keys(cell.tools).length > 0 && cell.actions.every(action => Object.values(cell.tools).some(actions => actions.includes(action)))
      && Object.values(cell.tools).every(actions => actions.every(action => cell.actions.includes(action)))).readonly()).min(1).max(32).readonly()
    .refine(cells => new Set(cells.map(cell => cell.id)).size === cells.length),
}).strict().readonly();
export type McpCapabilityGroup = z.infer<typeof mcpCapabilityGroupSchema>;
export type McpCapabilityAction = 'grant' | 'revoke';
export interface McpCapabilitySelection { readonly scopeId: string; readonly groupId: string; readonly action: McpCapabilityAction }
export interface McpCapabilityRequest extends McpCapabilitySelection { readonly mode: 'preview' | 'apply'; readonly expect?: string }
export interface McpCapabilityState { readonly group: McpCapabilityGroup; readonly managed: 'none' | 'partial' | 'granted' | 'conflict';
  readonly effective: 'denied' | 'partial' | 'allowed' }
export interface McpCapabilityView { readonly schemaVersion: 1; readonly scopeId: string; readonly revision: string;
  readonly principal: { readonly issuer: string; readonly subject: string }; readonly groups: readonly McpCapabilityState[] }
export interface McpCapabilityPreview extends McpCapabilitySelection {
  readonly schemaVersion: 1; readonly status: 'preview' | 'applied' | 'current' | 'conflict' | 'refused'; readonly revision: string; readonly digest: string;
  readonly principal: { readonly issuer: string; readonly subject: string }; readonly rules: readonly PolicyGrant[];
  readonly change: PolicyChange | null; readonly missing: readonly string[];
}

/** Stable ids isolate catalog grants from hand-built rules, first-run rules and other groups. No replace/rewrite path. */
export function mcpCapabilityRules(group: McpCapabilityGroup, scopeId: string, principal: { readonly issuer: string; readonly subject: string }, namespace: string): readonly PolicyGrant[] {
  return group.cells.map(cell => policyGrantSchema.parse({ id: `mcp-cap-${namespace}-${cell.id}`, effect: 'allow', principals: [principal],
    scopes: cell.scope === 'installation' ? 'all' : [scopeId], actions: cell.actions, resource: cell.resource }));
}
/** Shape equality, independent of JSON object key order. Any changed owned rule is a conflict, never silently removed or replaced. */
export function sameMcpCapabilityRule(left: PolicyGrant, right: PolicyGrant): boolean {
  const list = (value: unknown) => JSON.stringify(value);
  return left.id === right.id && left.effect === right.effect && left.modeEligible === right.modeEligible
    && list(left.actions) === list(right.actions) && list(left.scopes) === list(right.scopes) && list(left.principals) === list(right.principals)
    && left.resource.kind === right.resource.kind && list(left.resource.ids) === list(right.resource.ids);
}
