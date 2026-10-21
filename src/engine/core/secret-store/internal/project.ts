import { createHash } from 'node:crypto';
import { z } from 'zod';
import { counterSchema, identitySchema, installationIdSchema, projectIdSchema } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import type { DeckDeclaration } from './deck.js';
import { SECRET_NAME_PATTERN } from './port.js';
import REGISTRY from './project-vault.json' with { type: 'json' };

/** Project vault and grant record names and bounds, versioned registry data (law 6). */
export const PROJECT_VAULT = Object.freeze({ ...REGISTRY.vault });

/** A directory's identity: canonical path, device and inode (the installation identity binding's location shape). */
const locationSchema = z.object({ canonicalRoot: z.string().min(1).max(4096), device: z.string().regex(/^\d+$/u),
  inode: z.string().regex(/^[1-9]\d*$/u) }).strict().readonly();
export type ProjectVaultLocation = z.infer<typeof locationSchema>;
/**
 * The project a vault belongs to (PRE-8 v2, owner decision 5 and law audit BLOCKER): the installation and project identity of its anchor data
 * root, that data root's location (`binding`) and, in a Git repository, the repository's common directory (`repository`). Linked worktrees of
 * one repository resolve to the same anchor (the repository's main working tree), so they are one project; a copied folder carries the
 * same identities but another data root location, so it is refused (`SECRET_PROJECT_VAULT_CLAIMED`) until an explicit handover.
 */
export const projectVaultAnchorSchema = z.object({ installationId: installationIdSchema, projectId: projectIdSchema, binding: locationSchema,
  repository: locationSchema.nullable(), projectRoot: z.string().min(1).max(4096) }).strict().readonly();
export type ProjectVaultAnchor = z.infer<typeof projectVaultAnchorSchema>;
/** `project.json` v1 beside the vault: who owns it (the anchor it was first opened for) and since when. Never a secret. */
export const projectVaultRecordSchema = z.object({ schemaVersion: z.literal(1), anchor: projectVaultAnchorSchema, firstSeenAtMs: counterSchema,
  handedOverAtMs: counterSchema.nullable() }).strict().readonly();
export type ProjectVaultRecord = z.infer<typeof projectVaultRecordSchema>;

/** The vault directory name: a versioned salt over the anchor's installation and project identities (never a path). */
export function projectVaultKey(anchor: Pick<ProjectVaultAnchor, 'installationId' | 'projectId'>): string {
  return createHash('sha256').update(`${PROJECT_VAULT.keySalt}\0${anchor.installationId}\0${anchor.projectId}`).digest('hex');
}
const sameLocation = (a: ProjectVaultLocation | null, b: ProjectVaultLocation | null) => a === null || b === null
  ? a === b : a.canonicalRoot === b.canonicalRoot && a.device === b.device && a.inode === b.inode;
/**
 * Pure ownership check of an existing vault record against the anchor that asks now: `match` only for the same identities, data root
 * location and repository; anything else is `claimed` — a copy (`cp -r`, then `init identity --keep`) or a move that was not handed over.
 */
export function assessProjectVaultOwnership(recorded: ProjectVaultRecord, current: ProjectVaultAnchor): 'match' | 'claimed' {
  const owner = recorded.anchor;
  return owner.installationId === current.installationId && owner.projectId === current.projectId && sameLocation(owner.binding, current.binding)
    && sameLocation(owner.repository, current.repository) ? 'match' : 'claimed';
}
/**
 * Explicit handover after a move: allowed only when the recorded owner's data root no longer exists with its recorded identity (the project
 * was moved, not copied). While the original still holds it the vault stays with it and a copy gets its own identity (`init identity --new`).
 */
export function projectVaultHandover(recorded: ProjectVaultRecord, current: ProjectVaultAnchor, recordedOwnerPresent: boolean, atMs: number): ProjectVaultRecord {
  if (recordedOwnerPresent || recorded.anchor.installationId !== current.installationId || recorded.anchor.projectId !== current.projectId) {
    throw projectVaultClaimed(current);
  }
  return projectVaultRecordSchema.parse({ schemaVersion: 1, anchor: current, firstSeenAtMs: recorded.firstSeenAtMs, handedOverAtMs: atMs });
}
export const projectVaultClaimed = (current: Pick<ProjectVaultAnchor, 'projectRoot'>) =>
  ErrorRegistry.createError('SECRET_PROJECT_VAULT_CLAIMED', { params: { project: current.projectRoot } });

const principalSchema = z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly();
/**
 * One grant: main-vault key NAME may be used in this project. It exists only with the id of the sealed `authority-decision` event that decided
 * it on the `secret`/`set` cell (recorded before this file is written); a grant without that id does not parse, so it grants nothing.
 */
export const secretGrantSchema = z.object({ name: z.string().regex(SECRET_NAME_PATTERN), scopeId: identitySchema, by: principalSchema,
  atMs: counterSchema, source: z.enum(['card', 'admin']), decisionEventId: identitySchema }).strict().readonly();
export type SecretGrant = z.infer<typeof secretGrantSchema>;
/** `grants.json` v1 beside the project vault (the main-vault owner's custody, outside every project and worker tree). */
export const secretGrantFileSchema = z.object({ schemaVersion: z.literal(1), installationId: installationIdSchema, projectId: projectIdSchema,
  revision: counterSchema, grants: z.array(secretGrantSchema).max(PROJECT_VAULT.grantsMaxEntries) }).strict().readonly()
  .refine(file => new Set(file.grants.map(grant => grant.name)).size === file.grants.length);
export type SecretGrantFile = z.infer<typeof secretGrantFileSchema>;
export const emptySecretGrantFile = (anchor: Pick<ProjectVaultAnchor, 'installationId' | 'projectId'>): SecretGrantFile =>
  secretGrantFileSchema.parse({ schemaVersion: 1, installationId: anchor.installationId, projectId: anchor.projectId, revision: 0, grants: [] });
export const findSecretGrant = (file: SecretGrantFile, name: string): SecretGrant | null => file.grants.find(grant => grant.name === name) ?? null;

/** Refusals of one provider credential resolution, each before any value is read or sent. */
export type CredentialSourceRefusal = 'SECRET_PROJECT_IDENTITY_REQUIRED' | 'SECRET_PROJECT_MISSING' | 'DECK_DECLARATION_REQUIRED' | 'SECRET_GRANT_REQUIRED';
export type CredentialSource = { readonly source: 'project' } | { readonly source: 'main' } | { readonly source: 'refused'; readonly code: CredentialSourceRefusal };
export interface CredentialSourceInput {
  /** The project's anchor resolved (installation and project identity present, vault ownership matched). */
  readonly identified: boolean;
  readonly declaration: DeckDeclaration;
  /** The project vault holds NAME (names only, never a value). Consulted for `project` and for the shadowing check of an undeclared name. */
  readonly projectHas: boolean;
  /** A valid grant for NAME exists in this project's grant record. */
  readonly granted: boolean;
}
/**
 * The one decision of where a provider credential comes from (owner decisions 2026-10-21 2 and 5, law audit MAJOR 1):
 * 1. no project identity → `SECRET_PROJECT_IDENTITY_REQUIRED` (no fallback);
 * 2. declared `project` → the project vault; absent there → `SECRET_PROJECT_MISSING` (never the main vault);
 * 3. undeclared but present in the project vault → `DECK_DECLARATION_REQUIRED` (a project key is read only when declared: no shadowing);
 * 4. declared `main` or undeclared → the main vault, only with a grant, else `SECRET_GRANT_REQUIRED`.
 * Installation-level secrets (backup passphrase, `$DECK:` in global config, MCP server secrets) never come here.
 */
export function decideCredentialSource(input: CredentialSourceInput): CredentialSource {
  const refused = (code: CredentialSourceRefusal) => Object.freeze({ source: 'refused' as const, code });
  if (!input.identified) return refused('SECRET_PROJECT_IDENTITY_REQUIRED');
  if (input.declaration === 'project') return input.projectHas ? Object.freeze({ source: 'project' as const }) : refused('SECRET_PROJECT_MISSING');
  if (input.declaration === 'undeclared' && input.projectHas) return refused('DECK_DECLARATION_REQUIRED');
  return input.granted ? Object.freeze({ source: 'main' as const }) : refused('SECRET_GRANT_REQUIRED');
}
/** The typed error of a refusal, naming only the secret, the project and the scope the exact next command uses. */
export function credentialSourceError(code: CredentialSourceRefusal, params: { readonly name: string; readonly project: string; readonly scopeId: string }) {
  return ErrorRegistry.createError(code, { params: { name: params.name, project: params.project, scope: params.scopeId } });
}

/**
 * The one provider credential entry point (composition implements it over the verified scope context): `.deck` → ownership → project vault
 * or main vault through a grant → typed refusal. `check` decides without reading a value (pre-send preflight: invocable-now, the terminal turn,
 * headless and Brain calls get the typed refusal instead of a transport error); `resolve` reads the value only after the same decision.
 */
export interface ProjectCredentialResolver {
  check(name: string): Promise<CredentialSource>;
  resolve(name: string, signal?: AbortSignal): Promise<string | undefined>;
}
