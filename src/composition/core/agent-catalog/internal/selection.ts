import { selectTaskAgentsFrom } from '#engine/index.js';
import { openSqliteAgentCatalogStore } from '#adapters/index.js';
import type { TaskAgentSelection, TaskGraph } from '#domain/index.js';
import type { IntegrityAuthority } from '#platform/index.js';
/** S8-1b: the system agent selection over the scope ledger's catalog (read-only; sealed rows checked with the installation key), the same for the
 * proposal record and every admission. No admission registry = no WorkClasses = no agent. */
export const configuredAgentSelection = (path: () => Promise<string>, sqlite: Parameters<typeof openSqliteAgentCatalogStore>[1], integrity: IntegrityAuthority) =>
  async (graph: TaskGraph, registry: unknown, scopeId: string): Promise<ReadonlyMap<string, TaskAgentSelection>> => registry === undefined || registry === null ? new Map()
    : selectTaskAgentsFrom(async () => openSqliteAgentCatalogStore(await path(), sqlite, integrity, 'read'), graph, registry, scopeId);
