import type { ConfigLoadOptions } from '#platform/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { TerminalLaunchContext } from '#surfaces/core/cli-terminal/index.js';
import type { AgentCatalogMutation, AgentDefineCommand, AgentInspectQuery, AgentInspection, AgentListQuery, AgentListing, SignerAddCommand, SignerEnrolCommand, SignerListQuery,
  SignerListing, SignerMutation, SignerRepairCommand, SignerRevokeCommand, SkillDefineCommand, SkillImportCommand, SkillInspectQuery, SkillInspection, SkillListQuery, SkillListing, AgentStatsQuery, AgentStatsView,
  CatalogDraft, CatalogSuggestionInspection, CatalogSuggestionListing, CatalogSuggestionState, CatalogSuggestionView, StandingBulkCommand, StandingChangeCommand, SuggestionDismissCommand, SuggestionInspectQuery,
  SuggestionListQuery } from '#engine/index.js';
import type { AgentDefinition, AgentStanding, SkillDefinition } from '#domain/index.js';

/** S7 agent/skill catalog: reads use the application's `inspect` authorization; define and define-skill run only from a person's terminal card. */
export interface AgentsCommandContext extends CliBaseContext, Pick<TerminalLaunchContext, 'configChoiceSources'> {
  inspectCatalogMonitor?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<readonly string[]>;
  listAgents?: (root: string, input: AgentListQuery, options: ConfigLoadOptions) => Promise<AgentListing>;
  inspectAgent?: (root: string, input: AgentInspectQuery, options: ConfigLoadOptions) => Promise<AgentInspection>;
  listSkills?: (root: string, input: SkillListQuery, options: ConfigLoadOptions) => Promise<SkillListing>;
  inspectSkill?: (root: string, input: SkillInspectQuery, options: ConfigLoadOptions) => Promise<SkillInspection>;
  /** S8-2 statistics read (the same `inspect` authorization). */
  inspectAgentStats?: (root: string, input: AgentStatsQuery, options: ConfigLoadOptions) => Promise<AgentStatsView>;
  defineAgent?: (root: string, input: AgentDefineCommand, options: ConfigLoadOptions) => Promise<AgentCatalogMutation<AgentDefinition>>;
  defineSkill?: (root: string, input: SkillDefineCommand, options: ConfigLoadOptions) => Promise<AgentCatalogMutation<SkillDefinition>>;
  /** S8-5 signer keys and signed import (each write a person's card). */
  importSkill?: (root: string, input: SkillImportCommand, options: ConfigLoadOptions) => Promise<AgentCatalogMutation<SkillDefinition>>;
  listSigners?: (root: string, input: SignerListQuery, options: ConfigLoadOptions) => Promise<SignerListing>;
  enrolSigner?: (root: string, input: SignerEnrolCommand, options: ConfigLoadOptions) => Promise<SignerMutation>;
  addSigner?: (root: string, input: SignerAddCommand, options: ConfigLoadOptions) => Promise<SignerMutation>;
  revokeSigner?: (root: string, input: SignerRevokeCommand, options: ConfigLoadOptions) => Promise<SignerMutation>;
  repairSigners?: (root: string, input: SignerRepairCommand, options: ConfigLoadOptions) => Promise<{ readonly schemaVersion: 1; readonly entries: number; readonly revoked: number }>;
  /** S8-3/S8-4 suggestions (reads), standing and suggestion cards, the draft card at card time and a revoked key's promotions (each write a person's card). */
  listSuggestions?: (root: string, input: SuggestionListQuery, options: ConfigLoadOptions) => Promise<CatalogSuggestionListing>;
  inspectSuggestion?: (root: string, input: SuggestionInspectQuery, options: ConfigLoadOptions) => Promise<CatalogSuggestionInspection>;
  changeStanding?: (root: string, input: StandingChangeCommand, options: ConfigLoadOptions) => Promise<{ readonly replayed: boolean; readonly standings: readonly AgentStanding[] }>;
  dismissSuggestion?: (root: string, input: SuggestionDismissCommand, options: ConfigLoadOptions) => Promise<{ readonly replayed: boolean; readonly state: CatalogSuggestionState }>;
  bulkStanding?: (root: string, input: StandingBulkCommand, options: ConfigLoadOptions) => Promise<{ readonly replayed: boolean; readonly standings: readonly AgentStanding[] }>;
  listRevokedPromotions?: (root: string, input: { readonly schemaVersion: 1; readonly scopeId: string; readonly keyId?: string }, options: ConfigLoadOptions)
    => Promise<readonly Readonly<{ keyId: string; standing: AgentStanding }>[]>;
  draftSuggestion?: (root: string, input: SuggestionInspectQuery, options: ConfigLoadOptions) => Promise<Readonly<{ suggestion: CatalogSuggestionView; draft: CatalogDraft; digest: string;
    readable: number; withheld: number; aiDerived: boolean }>>;
  defineFromSuggestion?: (root: string, input: { readonly schemaVersion: 1; readonly scopeId: string; readonly suggestionId: string; readonly id: string; readonly expectedRevision: number | null;
    readonly draftDigest: string; readonly commandId: string }, options: ConfigLoadOptions) => Promise<AgentCatalogMutation<AgentDefinition | SkillDefinition>>;
}
