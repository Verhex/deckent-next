import { z } from 'zod';
import { agentContentSchema, catalogIdSchema, catalogSignatureSchema, clientCommandIdSchema, counterSchema, identitySchema, signerPublicKeySchema, skillContentSchema, skillSignatureSchema,
  skillSourceRefSchema, SIGNER_PURPOSES, AGENT_CATALOG_LIMITS, type AgentDefinition, type AgentStanding, type AuditEvent, type CatalogAction, type SignerKey, type SkillDefinition,
  type VerifiedPrincipal } from '#domain/index.js';
import type { PrincipalVerifier } from '#engine/core/authentication/index.js';

const scoped = { schemaVersion: z.literal(1), scopeId: identitySchema };
const limit = z.number().int().min(1).max(AGENT_CATALOG_LIMITS.pageMax);
/** null creates the id; a number revises exactly that current revision (compare-and-set). */
const expectedRevision = counterSchema.positive().nullable();
/** S8-5 `signed`: an externally held AI/system key's signature over the `catalog-action:1` bytes (host-custody principals are signed by the signer service). */
const signed = catalogSignatureSchema.optional();
export const agentDefineCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, agentId: catalogIdSchema, expectedRevision, content: agentContentSchema, signed }).strict();
export const skillDefineCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, skillId: catalogIdSchema, expectedRevision, content: skillContentSchema, signed }).strict();
/** An import bundle: the bytes, the publisher's pin and signature. Nullable pin and signature reach the floor, which refuses them with their own code. */
export const skillImportCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, skillId: catalogIdSchema, expectedRevision, content: skillContentSchema,
  source: z.object({ ref: skillSourceRefSchema }).strict(), pin: z.string().regex(/^[a-f0-9]{64}$/).nullable(), signature: skillSignatureSchema.nullable(), signed }).strict();
const principalRef = z.object({ issuer: identitySchema, subject: identitySchema }).strict();
const signerLabel = z.string().min(1).max(AGENT_CATALOG_LIMITS.nameMaxBytes);
/** S8-5 signer cards (a person's terminal act): enrol generates a host-custody action key for an AI/system principal; add registers an external public key. */
export const signerEnrolCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, principal: principalRef, label: signerLabel }).strict();
export const signerAddCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, purpose: z.enum(SIGNER_PURPOSES), publicKey: signerPublicKeySchema,
  principal: principalRef.nullable(), label: signerLabel }).strict();
export const signerRevokeCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, keyId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const signerRepairCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema }).strict();
export const signerListQuerySchema = z.object({ ...scoped }).strict();
export type SignerEnrolCommand = z.infer<typeof signerEnrolCommandSchema>;
export type SignerAddCommand = z.infer<typeof signerAddCommandSchema>;
export type SignerRevokeCommand = z.infer<typeof signerRevokeCommandSchema>;
export type SignerRepairCommand = z.infer<typeof signerRepairCommandSchema>;
export type SignerListQuery = z.infer<typeof signerListQuerySchema>;
/** A signer row as people see it, with how many committed catalog rows it signed (kept on revoke and marked "signer revoked", owner Q-S13). */
export interface SignerListing { readonly schemaVersion: 1; readonly scopeId: string; readonly items: readonly (SignerKey & { readonly signedRows: number })[]; readonly log: 'ok' | 'broken' }
export interface SignerMutation { readonly schemaVersion: 1; readonly replayed: boolean; readonly item: SignerKey; readonly signedRows?: number; readonly logged?: boolean }
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

/** `signers`: the state of each key that signed a shown revision (an unknown key reads as revoked). */
type Inspection<T> = { readonly schemaVersion: 1; readonly status: 'ok'; readonly item: T; readonly history: readonly T[]; readonly signers: Readonly<Record<string, 'active' | 'revoked'>> } | { readonly schemaVersion: 1; readonly status: 'not-found'; readonly id: string };
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
/** S8-5: an AI/system write's signature, verified by the store inside the catalog write transaction before any row is written: the key is active, of
 * purpose `action` and bound to the event's principal, and the Ed25519 signature covers exactly `catalog-action:1` of this change. (An import row's
 * skill signature is verified there too, against an active `import` key.) */
export interface SignedCatalogAction { readonly action: CatalogAction; readonly keyId: string; readonly signature: string }
export type AgentCatalogChange = { readonly kind: 'agent'; readonly previous: AgentDefinition | null; readonly next: AgentDefinition; readonly receipt: AgentCatalogReceipt; readonly event: AuditEvent;
    /** S8-1a: the new revision's opening standing per bound WorkClass, written in the same transaction (rows of earlier revisions stay as they are). */
    readonly standings: readonly AgentStanding[]; readonly signed?: SignedCatalogAction }
  | { readonly kind: 'skill'; readonly previous: SkillDefinition | null; readonly next: SkillDefinition; readonly receipt: AgentCatalogReceipt; readonly event: AuditEvent; readonly signed?: SignedCatalogAction };
/** One signer-row change (add or revoke), applied atomically: receipt replay or conflict, compare-and-set on `previous`, the row, its revision, the audit event. */
export interface SignerChange { readonly previous: SignerKey | null; readonly next: SignerKey; readonly event: AuditEvent;
  readonly receipt: { readonly scopeId: string; readonly commandId: string; readonly keyId: string; readonly revision: number; readonly digest: string } }
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
  /** S8-5: the scope's signer rows (oldest first, at most `limit`), one row, a command receipt, and the committed catalog revisions a key signed. */
  signers(scopeId: string, limit: number): Promise<readonly SignerKey[]>;
  signer(scopeId: string, keyId: string): Promise<SignerKey | null>;
  signerReceipt(scopeId: string, commandId: string): Promise<SignerChange['receipt'] | null>;
  signedRows(scopeId: string, keyId: string): Promise<number>;
  commitSigner(change: SignerChange): Promise<{ readonly replayed: boolean; readonly item: SignerKey }>;
  close(): void;
}
/** One entry of the append-only, HMAC-chained revocation log beside the ledger (never backed up, never restored over): a person's revoke. */
export interface SignerRevocation { readonly scopeId: string; readonly keyId: string; readonly by: { readonly issuer: string; readonly subject: string }; readonly atMs: number; readonly commandId: string }
/** S8-5 port: `list` throws `SIGNER_REVOCATION_LOG_BROKEN` on any altered, reordered or unreadable line; `repair` keeps the broken file aside and starts a
 * new chain holding every entry it could still read (a revocation is only ever added) plus `add`. */
export interface SignerRevocationLog {
  list(): Promise<readonly SignerRevocation[]>;
  append(entry: SignerRevocation): Promise<void>;
  repair(add: readonly SignerRevocation[]): Promise<readonly SignerRevocation[]>;
}
/** S8-5 host custody: the private key of one enrolled row is used only inside `use`, never returned; `create` writes a new PKCS#8 file and returns only the public part. */
export interface SignerKeyCustody {
  create(): Promise<{ readonly keyId: string; readonly publicKey: string }>;
  /** Signs only the `catalog-action:1` bytes of `action` (never arbitrary bytes) with the key file of `keyId`; refuses a file whose key is not that id. */
  signAction(keyId: string, action: CatalogAction): Promise<string>;
}
export type AgentCatalogAction = 'inspect' | 'define' | 'import';
export type SignerAction = 'inspect' | 'enrol' | 'add' | 'revoke' | 'repair';
export interface AgentCatalogDependencies {
  readonly verifier: PrincipalVerifier;
  readonly authorize: (action: AgentCatalogAction, scopeId: string, principal: VerifiedPrincipal) => Promise<{ revision: string; ruleId: string }>;
  /** S8-5: `skill-signer`/<action> on the scope (absent: signer cards are unavailable). */
  readonly authorizeSigner?: (action: SignerAction, scopeId: string, principal: VerifiedPrincipal) => Promise<{ revision: string; ruleId: string }>;
  /** S8-5: host-custody keys and the revocation log (absent: no AI/system principal can sign — every unsigned AI write is refused). */
  readonly custody?: SignerKeyCustody;
  readonly revocations?: SignerRevocationLog;
  readonly openStore: (access: 'read' | 'write') => Promise<AgentCatalogStore>;
  /** The WorkClass ids the scope's registry names; absent: ids are checked only for shape. */
  readonly workClassIds?: (scopeId: string) => Promise<readonly string[]>;
  /** S8-1a: the worker prompt composition bound (the native adapter's data); persona + pinned skills may use it minus the reserved task budget. */
  readonly promptCompositionMaxBytes?: number;
  readonly now: () => number;
  readonly eventId: () => string;
}
export type AgentCatalogStoreErrorCode = 'AGENT_CATALOG_UNAVAILABLE' | 'AGENT_CATALOG_CORRUPT' | 'AGENT_CATALOG_COMMAND_CONFLICT' | 'AGENT_CATALOG_REVISION_CONFLICT'
  | 'AGENT_CATALOG_NOT_FOUND' | 'AGENT_CATALOG_EXISTS' | 'AGENT_CATALOG_OUTCOME_UNKNOWN' | 'AGENT_CATALOG_LIMIT' | 'SIGNER_REVOCATION_LOG_BROKEN' | 'SIGNER_KEY_UNAVAILABLE';
export class AgentCatalogStoreError extends Error {
  constructor(readonly code: AgentCatalogStoreErrorCode) { super(code); this.name = 'AgentCatalogStoreError'; }
}
