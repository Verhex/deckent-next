import type { ConfigLoadOptions } from '#platform/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { TerminalLaunchContext } from '#surfaces/core/cli-terminal/index.js';
import type { AgentCatalogMutation, AgentDefineCommand, AgentInspectQuery, AgentInspection, AgentListQuery, AgentListing, SignerAddCommand, SignerEnrolCommand, SignerListQuery,
  SignerListing, SignerMutation, SignerRepairCommand, SignerRevokeCommand, SkillDefineCommand, SkillImportCommand, SkillInspectQuery, SkillInspection, SkillListQuery, SkillListing } from '#engine/index.js';
import type { AgentDefinition, SkillDefinition } from '#domain/index.js';

/** S7 agent/skill catalog: reads use the application's `inspect` authorization; define and define-skill run only from a person's terminal card. */
export interface AgentsCommandContext extends CliBaseContext, Pick<TerminalLaunchContext, 'configChoiceSources'> {
  listAgents?: (root: string, input: AgentListQuery, options: ConfigLoadOptions) => Promise<AgentListing>;
  inspectAgent?: (root: string, input: AgentInspectQuery, options: ConfigLoadOptions) => Promise<AgentInspection>;
  listSkills?: (root: string, input: SkillListQuery, options: ConfigLoadOptions) => Promise<SkillListing>;
  inspectSkill?: (root: string, input: SkillInspectQuery, options: ConfigLoadOptions) => Promise<SkillInspection>;
  defineAgent?: (root: string, input: AgentDefineCommand, options: ConfigLoadOptions) => Promise<AgentCatalogMutation<AgentDefinition>>;
  defineSkill?: (root: string, input: SkillDefineCommand, options: ConfigLoadOptions) => Promise<AgentCatalogMutation<SkillDefinition>>;
  /** S8-5 signer keys and signed import (each write a person's card). */
  importSkill?: (root: string, input: SkillImportCommand, options: ConfigLoadOptions) => Promise<AgentCatalogMutation<SkillDefinition>>;
  listSigners?: (root: string, input: SignerListQuery, options: ConfigLoadOptions) => Promise<SignerListing>;
  enrolSigner?: (root: string, input: SignerEnrolCommand, options: ConfigLoadOptions) => Promise<SignerMutation>;
  addSigner?: (root: string, input: SignerAddCommand, options: ConfigLoadOptions) => Promise<SignerMutation>;
  revokeSigner?: (root: string, input: SignerRevokeCommand, options: ConfigLoadOptions) => Promise<SignerMutation>;
  repairSigners?: (root: string, input: SignerRepairCommand, options: ConfigLoadOptions) => Promise<{ readonly schemaVersion: 1; readonly entries: number; readonly revoked: number }>;
}
