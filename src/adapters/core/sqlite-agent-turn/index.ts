import type { SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import type { AgentTurnStore } from '#engine/index.js';

/** Durable agent turns (ledger v37); node:sqlite is loaded only when a store is opened. */
export async function openSqliteAgentTurnStore(path: string, options: SqliteLedgerOptions,
  migrationMode: 'allow' | 'forbid' = 'allow'): Promise<AgentTurnStore & { close(): void }> {
  const implementation = await import('./internal/open.js');
  return implementation.openSqliteAgentTurnStore(path, options, migrationMode);
}
