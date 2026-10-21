import { deckDeclaration, type DeckDeclaration, type DeckDeclarations, type SecretVault } from './deck.js';
import { findSecretGrant, type SecretGrantFile } from './project.js';

/** One project as the inventory sees it: names only (never a value), its grants and, for the caller's own project, its `.deck`. */
export interface SecretInventoryProject {
  /** Display name of the project (its last known root). */
  readonly project: string;
  /** The project vault's names; null when its vault could not be listed (shown as unverified, never guessed). */
  readonly names: readonly string[] | null;
  readonly grants: SecretGrantFile | null;
  /** The caller's own project only; other projects' `.deck` files are not read (`--all` is metadata of the vaults). */
  readonly deck: DeckDeclarations | null;
  readonly current: boolean;
}
export interface SecretInventoryInput {
  /** The main vault's names; null when the backend cannot enumerate (the environment backend). */
  readonly mainNames: readonly string[] | null;
  /** Who uses which name in the caller's project: a provider profile id/version, a config field, the backup. */
  readonly references: readonly { readonly name: string; readonly usedBy: string }[];
  readonly projects: readonly SecretInventoryProject[];
}
export type SecretGrantState = { readonly state: 'granted'; readonly by: { readonly issuer: string; readonly subject: string }; readonly atMs: number }
  | { readonly state: 'none' } | { readonly state: 'not-applicable' };
export interface SecretInventoryRow {
  readonly name: string;
  readonly vault: SecretVault;
  /** The project the row is about (main rows: the project the grant column speaks for; null: no project context). */
  readonly project: string | null;
  readonly usedBy: readonly string[];
  /** What the project's `.deck` says (null: not read, another project's row). */
  readonly deck: DeckDeclaration | null;
  readonly grant: SecretGrantState;
  readonly presence: 'stored' | 'missing' | 'unverified';
}
/** Sync findings the admin acts on: a project key `.deck` does not declare, a declared name that is missing, a main key used without a grant. */
export type SecretInventoryFinding = { readonly kind: 'undeclared-project-key' | 'declared-missing' | 'grant-required'; readonly name: string; readonly project: string };
export interface SecretInventory { readonly rows: readonly SecretInventoryRow[]; readonly findings: readonly SecretInventoryFinding[] }

const grantState = (grants: SecretGrantFile | null, name: string): SecretGrantState => {
  const grant = grants ? findSecretGrant(grants, name) : null;
  return grant ? { state: 'granted', by: grant.by, atMs: grant.atMs } : { state: 'none' };
};
const presence = (names: readonly string[] | null, name: string) => names === null ? 'unverified' as const : names.includes(name) ? 'stored' as const : 'missing' as const;

/**
 * The one inventory (PRE-8 v2 §1.6): which name is in which vault, which project uses it, what `.deck` says, whether it is granted, whether it is
 * stored — names and metadata only. `secret list`, `secret list --all` and the terminal provider panel render this same result.
 */
export function buildSecretInventory(input: SecretInventoryInput): SecretInventory {
  const rows: SecretInventoryRow[] = [], findings: SecretInventoryFinding[] = [];
  const current = input.projects.find(project => project.current) ?? null;
  const users = (name: string) => [...new Set(input.references.filter(reference => reference.name === name).map(reference => reference.usedBy))].sort();
  const referenced = [...new Set(input.references.map(reference => reference.name))];
  const mainNames = new Set([...(input.mainNames ?? []), ...(current ? referenced.filter(name => deckDeclaration(current.deck, name) !== 'project') : [])]);
  for (const name of [...mainNames].sort()) {
    const deck = current ? deckDeclaration(current.deck, name) : null, ownKey = current?.names?.includes(name) === true;
    const grant = current ? grantState(current.grants, name) : { state: 'not-applicable' as const };
    rows.push({ name, vault: 'main', project: current?.project ?? null, usedBy: current ? users(name) : [], deck, grant, presence: presence(input.mainNames, name) });
    if (current && users(name).length > 0 && grant.state === 'none' && !(deck === 'undeclared' && ownKey)) findings.push({ kind: 'grant-required', name, project: current.project });
  }
  for (const project of input.projects) {
    const declared = project.current && project.deck ? [...project.deck].filter(([, vault]) => vault === 'project').map(([name]) => name) : [];
    const own = new Set([...(project.names ?? []), ...declared]);
    for (const name of [...own].sort()) {
      const deck = project.current ? deckDeclaration(project.deck, name) : null;
      rows.push({ name, vault: 'project', project: project.project, usedBy: project.current ? users(name) : [], deck, grant: { state: 'not-applicable' }, presence: presence(project.names, name) });
      if (deck === 'undeclared') findings.push({ kind: 'undeclared-project-key', name, project: project.project });
      if (deck === 'project' && project.names !== null && !project.names.includes(name)) findings.push({ kind: 'declared-missing', name, project: project.project });
    }
    if (project.current) continue;
    // Another project's grants: which main key is lent to it (the admin's "who has what").
    for (const grant of project.grants?.grants ?? []) {
      rows.push({ name: grant.name, vault: 'main', project: project.project, usedBy: [], deck: null,
        grant: { state: 'granted', by: grant.by, atMs: grant.atMs }, presence: presence(input.mainNames, grant.name) });
    }
  }
  if (current?.deck) for (const [name, vault] of current.deck) {
    if (vault === 'main' && input.mainNames !== null && !input.mainNames.includes(name)) findings.push({ kind: 'declared-missing', name, project: current.project });
  }
  return Object.freeze({ rows: Object.freeze(rows), findings: Object.freeze(findings) });
}
