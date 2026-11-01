import { z } from 'zod';
import { catalogIdSchema, AGENT_CATALOG_LIMITS, skillSignatureSchema } from '#domain/core/agent-catalog/index.js';
import { identitySchema } from '#domain/core/primitives/index.js';
import { HUB_LIMITS } from './registry.js';
import { hubDigestSchema, hubFilesSchema, hubPackageIdSchema, hubSkillDescriptionSchema, hubSkillNameSchema, hubText, hubTimeSchema, hubVersionSchema } from './fields.js';

export const hubDependencySchema = z.strictObject({ hubId: hubDigestSchema.optional(), packageId: hubPackageIdSchema, version: hubVersionSchema,
  manifestDigest: hubDigestSchema }).readonly();
export const hubSkillItemSchema = z.strictObject({ kind: z.literal('skill'), skillId: catalogIdSchema, name: hubSkillNameSchema, description: hubSkillDescriptionSchema,
  entry: z.literal('SKILL.md'), files: hubFilesSchema, signature: skillSignatureSchema }).readonly();
export const hubAgentItemSchema = z.strictObject({ kind: z.literal('agent'), agentId: catalogIdSchema, name: hubText(AGENT_CATALOG_LIMITS.nameMaxBytes),
  persona: hubText(AGENT_CATALOG_LIMITS.personaMaxBytes), workClassHints: z.array(identitySchema).min(1).max(AGENT_CATALOG_LIMITS.workClassesPerAgentMax)
    .refine(ids => new Set(ids).size === ids.length).readonly(),
  skills: z.array(z.strictObject({ packageId: hubPackageIdSchema, version: hubVersionSchema, skillId: catalogIdSchema, digest: hubDigestSchema }).readonly())
    .max(AGENT_CATALOG_LIMITS.skillsPerAgentMax).refine(rows => new Set(rows.map(r => `${r.packageId}/${r.skillId}`)).size === rows.length).readonly(),
  parentHint: catalogIdSchema.nullable() }).refine(row => row.parentHint !== row.agentId).readonly();
export const hubPackageSchema = z.strictObject({ schemaVersion: z.literal(1), packageId: hubPackageIdSchema, version: hubVersionSchema,
  kind: z.enum(['skill', 'agent', 'set']), title: hubText(AGENT_CATALOG_LIMITS.nameMaxBytes), description: hubSkillDescriptionSchema,
  // An SPDX identifier token; license-list membership is a registry concern, never guessed from a label.
  license: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/),
  items: z.array(z.union([hubSkillItemSchema, hubAgentItemSchema])).min(1).max(HUB_LIMITS.itemsMax).readonly(),
  dependencies: z.array(hubDependencySchema).max(HUB_LIMITS.dependenciesMax)
    .refine(rows => new Set(rows.map(r => `${r.hubId ?? ''}/${r.packageId}`)).size === rows.length).readonly(),
  provenance: z.strictObject({ origin: z.enum(['person', 'ai', 'system', 'lessons(derived)']),
    authoredBy: z.strictObject({ kind: z.enum(['person', 'ai', 'system']), label: hubText(AGENT_CATALOG_LIMITS.nameMaxBytes) }).readonly(),
    sourceRevision: hubText(AGENT_CATALOG_LIMITS.sourceRefMaxBytes) }).readonly(),
  compat: z.strictObject({ packageSchema: z.literal(1), catalogSchema: z.strictObject({ agent: z.literal(1), skill: z.literal(2) }).readonly() }).readonly(),
  publishedAtMs: hubTimeSchema }).refine(row => {
    const ids = row.items.map(item => item.kind === 'skill' ? `skill/${item.skillId}` : `agent/${item.agentId}`);
    const names = row.items.filter(item => item.kind === 'skill').map(item => item.name);
    return new Set(ids).size === ids.length && new Set(names).size === names.length
      && (row.kind === 'set' || row.items.every(item => item.kind === row.kind));
  }).readonly();
export type HubPackage = z.infer<typeof hubPackageSchema>;
export type HubSkillItem = z.infer<typeof hubSkillItemSchema>;
export type HubAgentItem = z.infer<typeof hubAgentItemSchema>;
export type HubDependency = z.infer<typeof hubDependencySchema>;
