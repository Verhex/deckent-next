import { z } from 'zod';
import { skillDefinitionSchema } from '#domain/core/agent-catalog/index.js';
import { HUB_LIMITS } from './registry.js';
import { hubFilesSchema, hubSkillDescriptionSchema, hubSkillNameSchema, hubText } from './fields.js';

export const hubSkillContentSchema = z.strictObject({ name: hubSkillNameSchema, description: hubSkillDescriptionSchema,
  text: hubText(HUB_LIMITS.skillReadMaxBytes), files: hubFilesSchema }).readonly();
/** Additive reader only. H2 owns migration, persistence, materialisation and application wiring. Retains v1 import/provenance floors. */
export const hubSkillDefinitionSchema = z.strictObject(skillDefinitionSchema.unwrap().shape).extend({ schemaVersion: z.literal(2), content: hubSkillContentSchema }).strict()
  .refine(row => (row.source.kind === 'import') === (row.signature.status === 'verified')).readonly();
export const readableSkillDefinitionSchema = z.union([skillDefinitionSchema, hubSkillDefinitionSchema]);
export type HubSkillContent = z.infer<typeof hubSkillContentSchema>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type HubSkillDefinition = z.infer<typeof hubSkillDefinitionSchema>;

export type ReadableSkillDefinition = z.infer<typeof readableSkillDefinitionSchema>;
