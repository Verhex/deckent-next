import type { ConfigLoadOptions } from '#platform/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { TerminalLaunchContext } from '#surfaces/core/cli-terminal/index.js';
import type { MemoryInspectQuery, MemoryInspection, MemoryListQuery, MemoryListing, MemorySearchQuery, MemorySearchResult, MemoryProposeCommand, MemoryVerifyCommand,
  MemoryRetireCommand, MemoryMutationResult, MemoryReviewQuery, MemoryReview, MemorySourceQuery, MemorySourceEntries, MemoryPurgeCommand, MemoryPurgeResult,
  MemoryContestResolveCommand, MemoryContestResolveResult } from '#engine/index.js';
import type { memoryEvaluatorView, MemoryHeld, MemoryRolloutStatus } from '#engine/index.js';

/** S4 memory journal v1: reads use the application's `inspect` authorization; propose/verify/retire run only from a person's terminal card. */
export interface MemoryCommandContext extends CliBaseContext, Pick<TerminalLaunchContext, 'configChoiceSources'> {
  listMemory?: (root: string, input: MemoryListQuery, options: ConfigLoadOptions) => Promise<MemoryListing>;
  searchMemory?: (root: string, input: MemorySearchQuery, options: ConfigLoadOptions) => Promise<MemorySearchResult>;
  inspectMemory?: (root: string, input: MemoryInspectQuery, options: ConfigLoadOptions) => Promise<MemoryInspection>;
  proposeMemory?: (root: string, input: MemoryProposeCommand, options: ConfigLoadOptions) => Promise<MemoryMutationResult>;
  verifyMemory?: (root: string, input: MemoryVerifyCommand, options: ConfigLoadOptions) => Promise<MemoryMutationResult>;
  retireMemory?: (root: string, input: MemoryRetireCommand, options: ConfigLoadOptions) => Promise<MemoryMutationResult>;
  /** S4B-3: the read-only line under the list — which evaluator would serve the scope and what it may cost. */
  inspectMemoryEvaluators?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<ReturnType<typeof memoryEvaluatorView>>;
  /** S4B-4: the review card's page, the entries of one source, a person's purge and contest resolution (all through the same journal application). */
  reviewMemory?: (root: string, input: MemoryReviewQuery, options: ConfigLoadOptions) => Promise<MemoryReview>;
  listMemorySource?: (root: string, input: MemorySourceQuery, options: ConfigLoadOptions) => Promise<MemorySourceEntries>;
  purgeMemory?: (root: string, input: MemoryPurgeCommand, options: ConfigLoadOptions) => Promise<MemoryPurgeResult>;
  resolveMemoryContest?: (root: string, input: MemoryContestResolveCommand, options: ConfigLoadOptions) => Promise<MemoryContestResolveResult>;
  /** S4B-7: the read-only rollout status of a scope (phase, exit criteria with numbers, provisional retention). */
  inspectMemoryRollout?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<MemoryRolloutStatus | MemoryHeld>;
}
