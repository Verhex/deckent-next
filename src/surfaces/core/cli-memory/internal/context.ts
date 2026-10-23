import type { ConfigLoadOptions } from '#platform/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { TerminalLaunchContext } from '#surfaces/core/cli-terminal/index.js';
import type { MemoryInspectQuery, MemoryInspection, MemoryListQuery, MemoryListing, MemorySearchQuery, MemorySearchResult } from '#engine/index.js';

/** S4 memory journal v1: the CLI only reads; each read is the memory application's `inspect` authorization. */
export interface MemoryCommandContext extends CliBaseContext, Pick<TerminalLaunchContext, 'configChoiceSources'> {
  listMemory?: (root: string, input: MemoryListQuery, options: ConfigLoadOptions) => Promise<MemoryListing>;
  searchMemory?: (root: string, input: MemorySearchQuery, options: ConfigLoadOptions) => Promise<MemorySearchResult>;
  inspectMemory?: (root: string, input: MemoryInspectQuery, options: ConfigLoadOptions) => Promise<MemoryInspection>;
}
