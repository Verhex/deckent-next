import type { ConfigLoadOptions } from '#platform/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { TerminalLaunchContext } from '#surfaces/core/cli-terminal/index.js';
import type { DecisionPrepareInput, DecisionPrepareResult, DecisionAskCommand, DecisionAskResult, DecisionQuery, DecisionInspection,
  DecisionRecordCommand, DecisionRecordResult, DecisionOutcomeCommand, DecisionOutcomeResult, DecisionListQuery, DecisionList } from '#engine/index.js';

/** Surfaces delegate each decision transition to its one application owner. */
export interface DecisionCommandContext extends CliBaseContext, Pick<TerminalLaunchContext, 'configChoiceSources'> {
  prepareDecision?: (root: string, input: DecisionPrepareInput, options: ConfigLoadOptions) => Promise<DecisionPrepareResult>;
  askDecision?: (root: string, input: DecisionAskCommand, options: ConfigLoadOptions, signal?: AbortSignal) => Promise<DecisionAskResult>;
  inspectDecision?: (root: string, input: DecisionQuery, options: ConfigLoadOptions) => Promise<DecisionInspection>;
  recordDecision?: (root: string, input: DecisionRecordCommand, options: ConfigLoadOptions) => Promise<DecisionRecordResult>;
  /** C-APPROVE: the scope's recent decisions, newest first (read). */
  listDecisions?: (root: string, input: DecisionListQuery, options: ConfigLoadOptions) => Promise<DecisionList>;
  outcomeDecision?: (root: string, input: DecisionOutcomeCommand, options: ConfigLoadOptions) => Promise<DecisionOutcomeResult>;
}
