import { AgentCatalogStoreError, selectTaskAgentsFrom } from '#engine/index.js';
import { openSqliteAgentCatalogStore } from '#adapters/index.js';
import { identitySchema, counterSchema, taskAgentSealSchema, type TaskAgentSelection, type TaskGraph } from '#domain/index.js';
import type { ConfigLoadOptions, IntegrityAuthority } from '#platform/index.js';
import { z } from 'zod';
import { inspectConfiguredAgent } from './application.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** K8 consumer: locale-free context bound to one scope/task, not a grant or a model choice. */
export const taskAgentUseSchema = taskAgentSealSchema.unwrap().pick({ agentId: true, revision: true, personaDigest: true, skillSetDigest: true, skills: true })
  .extend({ schemaVersion: z.literal(1), scopeId: identitySchema, taskId: identitySchema }).readonly();
export type TaskAgentUse = z.infer<typeof taskAgentUseSchema>;
const requestSchema = taskAgentUseSchema.unwrap().pick({ schemaVersion: true, scopeId: true, taskId: true, agentId: true }).extend({ expectedRevision: counterSchema.positive() });
/** Read-only preview for “use for this work”. Define/revise/import/revoke retain their existing witnessed owners. */
export async function prepareConfiguredAgentUse(root: string, input: unknown, options: ConfigLoadOptions = {}): Promise<TaskAgentUse> {
  try {
    const request = requestSchema.parse(input), inspected = await inspectConfiguredAgent(root, { schemaVersion: 1, scopeId: request.scopeId, agentId: request.agentId }, options);
    if (inspected.status !== 'ok') throw new AgentCatalogStoreError('AGENT_CATALOG_NOT_FOUND');
    const agent = inspected.item;
    if (agent.revision !== request.expectedRevision) throw new AgentCatalogStoreError('AGENT_CATALOG_REVISION_CONFLICT');
    return taskAgentUseSchema.parse({ schemaVersion: 1, scopeId: request.scopeId, taskId: request.taskId, agentId: agent.agentId, revision: agent.revision,
      personaDigest: agent.personaDigest, skillSetDigest: agent.skillSetDigest, skills: agent.content.skills });
  } catch (error) { throw queryFailure(error); }
}
/** S8-1b: the system agent selection over the scope ledger's catalog (read-only; sealed rows checked with the installation key), the same for the
 * proposal record and every admission. K5 can pass explicit uses through this existing port; no registry may silently drop them. */
export const configuredAgentSelection = (path: () => Promise<string>, sqlite: Parameters<typeof openSqliteAgentCatalogStore>[1], integrity: IntegrityAuthority,
  uses: readonly TaskAgentUse[] = []) => {
  const captured = uses.map(use => taskAgentUseSchema.parse(use));
  return async (graph: TaskGraph, registry: unknown, scopeId: string): Promise<ReadonlyMap<string, TaskAgentSelection>> => {
    const pins = new Map(captured.map(use => [use.taskId, use]));
    if (pins.size !== captured.length || captured.some(use => use.scopeId !== scopeId)) throw new AgentCatalogStoreError('AGENT_CATALOG_REVISION_CONFLICT');
    if (registry === undefined || registry === null) {
      if (pins.size) throw new AgentCatalogStoreError('AGENT_CATALOG_UNAVAILABLE');
      return new Map();
    }
    return selectTaskAgentsFrom(async () => openSqliteAgentCatalogStore(await path(), sqlite, integrity, 'read'), graph, registry, scopeId, pins);
  };
};
