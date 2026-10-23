import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import limits from './limits.json' with { type: 'json' };

/**
 * S7 agent/skill catalog core (owner ORG; AJAN-ORG 2026-10-16 S1, S2, S4, S6; A4; ASS1). Agent and skill definitions are versioned ledger rows of
 * exactly one scope. An agent carries requirements only (persona, WorkClass bindings, skills pinned by digest, an optional manager in the org tree);
 * the system assignment picks the model (S2, ASS1). The tier opens empty and grants nothing (A4). Every field is plain JSON (storage-neutral).
 */
export const AGENT_CATALOG_SCHEMA_VERSION = 1;
/** Bounds are protocol data (`limits.json`), never configurable policy and never literals in code. */
export const AGENT_CATALOG_LIMITS = Object.freeze({ ...limits });
/** The same identifier shape as a native prompt part (`persona`/`skill` ids), so a catalog row can become a prompt part unchanged. */
export const catalogIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const bytes = (value: string) => new TextEncoder().encode(value).length;
const text = (max: number) => z.string().min(1).refine(value => value.trim() === value && !value.includes('\0') && bytes(value) <= max);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const authorSchema = z.object({ issuer: identitySchema, subject: identitySchema, ai: z.boolean() }).strict().readonly();
const provenanceSchema = z.object({ author: authorSchema, commandId: identitySchema, definedAtMs: counterSchema }).strict().readonly();

/** One exact skill revision an agent uses; `digest` is that revision's content digest (the pin). */
export const skillRefSchema = z.object({ skillId: catalogIdSchema, revision: counterSchema.positive(), digest }).strict().readonly();
export const agentContentSchema = z.object({ name: text(limits.nameMaxBytes), persona: text(limits.personaMaxBytes),
  workClasses: z.array(identitySchema).min(1).max(limits.workClassesPerAgentMax).refine(unique).readonly(),
  skills: z.array(skillRefSchema).max(limits.skillsPerAgentMax).refine(rows => unique(rows.map(row => row.skillId))).readonly(),
  parentAgentId: catalogIdSchema.nullable() }).strict().readonly();
export const agentDefinitionSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, agentId: catalogIdSchema, revision: counterSchema.positive(),
  content: agentContentSchema, personaDigest: digest, skillSetDigest: digest,
  /** A4: always empty in v1; a later schema version carries owner-set values from ledger evidence. */
  tier: z.null(), provenance: provenanceSchema }).strict().refine(row => row.content.parentAgentId !== row.agentId).readonly();

export const skillContentSchema = z.object({ name: text(limits.nameMaxBytes), text: text(limits.skillTextMaxBytes) }).strict().readonly();
const signatureValue = z.string().min(1).max(limits.signatureMaxBytes).regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const skillSignatureSchema = z.object({ algorithm: z.literal('ed25519'), keyId: identitySchema, value: signatureValue }).strict().readonly();
/** Where an imported skill came from (a hub or file reference; shown to people, never fetched by Core). */
export const skillSourceRefSchema = text(limits.sourceRefMaxBytes);
export const skillSourceSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('local') }).strict(),
  z.object({ kind: z.literal('import'), ref: skillSourceRefSchema }).strict()]).readonly();
const signatureStatusSchema = z.discriminatedUnion('status', [z.object({ status: z.literal('unsigned') }).strict(),
  z.object({ status: z.literal('verified'), algorithm: z.literal('ed25519'), keyId: identitySchema, value: signatureValue }).strict()]).readonly();
/** Floor (d) as a row invariant: an imported row exists only with a verified signature; a local row is a person's own text, pinned by its digest. */
export const skillDefinitionSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, skillId: catalogIdSchema, revision: counterSchema.positive(),
  content: skillContentSchema, contentDigest: digest, source: skillSourceSchema, signature: signatureStatusSchema, provenance: provenanceSchema }).strict()
  .refine(row => (row.source.kind === 'import') === (row.signature.status === 'verified')).readonly();

export type SkillRef = z.infer<typeof skillRefSchema>;
export type AgentContent = z.infer<typeof agentContentSchema>;
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type SkillContent = z.infer<typeof skillContentSchema>;
export type SkillSignature = z.infer<typeof skillSignatureSchema>;
export type SkillSource = z.infer<typeof skillSourceSchema>;
export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;
/** What a signature check answered; anything but `valid` refuses the import (no verifier wired is `unavailable`). */
export type SkillSignatureVerdict = 'valid' | 'invalid' | 'unknown-key' | 'unavailable';
export type AgentCatalogErrorCode = 'AGENT_DEFINITION_INVALID' | 'SKILL_DEFINITION_INVALID' | 'AGENT_ORG_CYCLE' | 'AGENT_ORG_DEPTH' | 'AGENT_PARENT_NOT_FOUND'
  | 'AGENT_SKILL_NOT_PINNED' | 'AGENT_WORK_CLASS_UNKNOWN' | 'SKILL_IMPORT_UNPINNED' | 'SKILL_IMPORT_PIN_MISMATCH' | 'SKILL_IMPORT_UNSIGNED' | 'SKILL_IMPORT_SIGNATURE_UNVERIFIED';
export class AgentCatalogError extends Error {
  constructor(readonly code: AgentCatalogErrorCode) { super(code); this.name = 'AgentCatalogError'; }
}
