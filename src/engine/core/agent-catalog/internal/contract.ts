import { z } from 'zod';
import { agentContentSchema, catalogIdSchema, clientCommandIdSchema, counterSchema, identitySchema, skillContentSchema, skillSignatureSchema, skillSourceRefSchema,
  AGENT_CATALOG_LIMITS, type AgentDefinition, type AgentStanding, type AuditEvent, type SkillDefinition, type SkillSignature, type VerifiedPrincipal } from '#domain/index.js';
import type { PrincipalVerifier } from '#engine/core/authentication/index.js';

const scoped = { schemaVersion: z.literal(1), scopeId: identitySchema };
const limit = z.number().int().min(1).max(AGENT_CATALOG_LIMITS.pageMax);
/** null creates the id; a number revises exactly that current revision (compare-and-set). */
const expectedRevision = counterSchema.positive().nullable();
export const agentDefineCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, agentId: catalogIdSchema, expectedRevision, content: agentContentSchema }).strict();
export const skillDefineCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, skillId: catalogIdSchema, expectedRevision, content: skillContentSchema }).strict();
/** An import bundle: the bytes, the publisher's pin and signature. Nullable pin and signature reach the floor, which refuses them with their own code. */
export const skillImportCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, skillId: catalogIdSchema, expectedRevision, content: skillContentSchema,
  source: z.object({ ref: skillSourceRefSchema }).strict(), pin: z.string().regex(/^[a-f0-9]{64}$/).nullable(), signature: skillSignatureSchema.nullable() }).strict();
export const agentListQuerySchema = z.object({ ...scoped, limit }).strict();
export const agentInspectQuerySchema = z.object({ ...scoped, agentId: catalogIdSchema }).strict();
export const skillListQuerySchema = z.object({ ...scoped, limit }).strict();
export const skillInspectQuerySchema = z.object({ ...scoped, skillId: catalogIdSchema }).strict();
/** A person's definition file (CLI and later surfaces): the agent's requirements, each skill by id and optionally a revision (default: the current one);
 * the surface resolves every skill to its exact pin before it builds the define command. A skill file is its id plus its content. */
export const agentDefinitionFileSchema = agentContentSchema.unwrap().omit({ skills: true, parentAgentId: true }).extend({ agentId: catalogIdSchema,
  skills: z.array(z.object({ skillId: catalogIdSchema, revision: counterSchema.positive().optional() }).strict()).max(AGENT_CATALOG_LIMITS.skillsPerAgentMax).default([]),
  parentAgentId: catalogIdSchema.nullable().default(null) }).strict();
export const skillDefinitionFileSchema = skillContentSchema.unwrap().extend({ skillId: catalogIdSchema }).strict();
export type AgentDefineCommand = z.infer<typeof agentDefineCommandSchema>;
export type SkillDefineCommand = z.infer<typeof skillDefineCommandSchema>;
export type SkillImportCommand = z.infer<typeof skillImportCommandSchema>;
export type AgentListQuery = z.infer<typeof agentListQuerySchema>;
export type AgentInspectQuery = z.infer<typeof agentInspectQuerySchema>;
export type SkillListQuery = z.infer<typeof skillListQuerySchema>;
export type SkillInspectQuery = z.infer<typeof skillInspectQuerySchema>;

type Inspection<T> = { readonly schemaVersion: 1; readonly status: 'ok'; readonly item: T; readonly history: readonly T[] } | { readonly schemaVersion: 1; readonly status: 'not-found'; readonly id: string };
/** S8-1a: an agent's inspection also names the current revision's standing per bound WorkClass (what the system may select it for). */
export type AgentInspection = (Extract<Inspection<AgentDefinition>, { status: 'ok' }> & { readonly standings: readonly AgentStanding[] }) | Extract<Inspection<AgentDefinition>, { status: 'not-found' }>;
export type SkillInspection = Inspection<SkillDefinition>;
export interface AgentListing { readonly schemaVersion: 1; readonly scopeId: string; readonly items: readonly AgentDefinition[] }
export interface SkillListing { readonly schemaVersion: 1; readonly scopeId: string; readonly items: readonly SkillDefinition[] }
export interface AgentCatalogMutation<T> { readonly schemaVersion: 1; readonly replayed: boolean; readonly item: T }

/** Idempotency record of one command: the fingerprint of (command, principal) and the row revision it produced. */
export interface AgentCatalogReceipt { readonly scopeId: string; readonly commandId: string; readonly kind: 'agent' | 'skill'; readonly itemId: string; readonly revision: number; readonly digest: string }
/** One transition, applied atomically by the store: receipt replay (same digest) or conflict; compare-and-set on `previous`; for an agent, the scope's
 * agent bound and the org tree over the rows held at commit; then the new current row, its kept revision, the receipt and the audit event. */
export type AgentCatalogChange = { readonly kind: 'agent'; readonly previous: AgentDefinition | null; readonly next: AgentDefinition; readonly receipt: AgentCatalogReceipt; readonly event: AuditEvent;
    /** S8-1a: the new revision's opening standing per bound WorkClass, written in the same transaction (rows of earlier revisions stay as they are). */
    readonly standings: readonly AgentStanding[] }
  | { readonly kind: 'skill'; readonly previous: SkillDefinition | null; readonly next: SkillDefinition; readonly receipt: AgentCatalogReceipt; readonly event: AuditEvent };
/**
 * DB-neutral catalog port (Core SQLite; Enterprise may store it elsewhere). Values are domain JSON; no SQL or driver type crosses it. `revision`
 * absent reads the current row. Reads throw `AgentCatalogStoreError('AGENT_CATALOG_CORRUPT')` on any integrity failure, never a partial row.
 */
export interface AgentCatalogStore {
  loadAgent(scopeId: string, agentId: string, revision?: number): Promise<AgentDefinition | null>;
  agentHistory(scopeId: string, agentId: string, limit: number): Promise<readonly AgentDefinition[]>;
  /** Current agents of the scope, most recently changed first, at most `limit`. */
  listAgents(scopeId: string, limit: number): Promise<readonly AgentDefinition[]>;
  loadSkill(scopeId: string, skillId: string, revision?: number): Promise<SkillDefinition | null>;
  skillHistory(scopeId: string, skillId: string, limit: number): Promise<readonly SkillDefinition[]>;
  listSkills(scopeId: string, limit: number): Promise<readonly SkillDefinition[]>;
  receipt(scopeId: string, commandId: string): Promise<AgentCatalogReceipt | null>;
  /** S8-1a: the standings of one agent revision, ordered by WorkClass id. */
  standings(scopeId: string, agentId: string, revision: number): Promise<readonly AgentStanding[]>;
  /** S8-1b: the scope's agents whose CURRENT revision holds an `active` or `candidate` standing for `workClass`, ordered by agent id, at most `limit`. */
  eligibleAgents(scopeId: string, workClass: string, limit: number): Promise<readonly Readonly<{ agent: AgentDefinition; standing: AgentStanding }>[]>;
  commit(change: AgentCatalogChange): Promise<{ readonly replayed: boolean; readonly item: AgentDefinition | SkillDefinition }>;
  close(): void;
}
export type AgentCatalogAction = 'inspect' | 'define' | 'import';
export interface AgentCatalogDependencies {
  readonly verifier: PrincipalVerifier;
  readonly authorize: (action: AgentCatalogAction, scopeId: string, principal: VerifiedPrincipal) => Promise<{ revision: string; ruleId: string }>;
  readonly openStore: (access: 'read' | 'write') => Promise<AgentCatalogStore>;
  /** The WorkClass ids the scope's registry names; absent: ids are checked only for shape. */
  readonly workClassIds?: (scopeId: string) => Promise<readonly string[]>;
  /** Checks a skill signature over the exact message bytes against the adapter's trust anchors. Absent (Core v1): every import fails closed. */
  readonly verifySkillSignature?: (signature: SkillSignature, message: string) => Promise<'valid' | 'invalid' | 'unknown-key'>;
  /** S8-1a: the worker prompt composition bound (the native adapter's data); persona + pinned skills may use it minus the reserved task budget. */
  readonly promptCompositionMaxBytes?: number;
  readonly now: () => number;
  readonly eventId: () => string;
}
export type AgentCatalogStoreErrorCode = 'AGENT_CATALOG_UNAVAILABLE' | 'AGENT_CATALOG_CORRUPT' | 'AGENT_CATALOG_COMMAND_CONFLICT' | 'AGENT_CATALOG_REVISION_CONFLICT'
  | 'AGENT_CATALOG_NOT_FOUND' | 'AGENT_CATALOG_EXISTS' | 'AGENT_CATALOG_OUTCOME_UNKNOWN' | 'AGENT_CATALOG_LIMIT';
export class AgentCatalogStoreError extends Error {
  constructor(readonly code: AgentCatalogStoreErrorCode) { super(code); this.name = 'AgentCatalogStoreError'; }
}
