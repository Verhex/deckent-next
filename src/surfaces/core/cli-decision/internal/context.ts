import type { ConfigLoadOptions } from '#platform/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { DecisionPrepareInput, DecisionPrepareResult, DecisionAskCommand, DecisionAskResult, DecisionQuery, DecisionInspection,
  DecisionRecordCommand, DecisionRecordResult, DecisionOutcomeCommand, DecisionOutcomeResult } from '#engine/index.js';

/** Surfaces delegate each decision transition to its one application owner. */
export interface DecisionCommandContext extends CliBaseContext {
  prepareDecision?: (root: string, input: DecisionPrepareInput, options: ConfigLoadOptions) => Promise<DecisionPrepareResult>;
  askDecision?: (root: string, input: DecisionAskCommand, options: ConfigLoadOptions, signal?: AbortSignal) => Promise<DecisionAskResult>;
  inspectDecision?: (root: string, input: DecisionQuery, options: ConfigLoadOptions) => Promise<DecisionInspection>;
  recordDecision?: (root: string, input: DecisionRecordCommand, options: ConfigLoadOptions) => Promise<DecisionRecordResult>;
  outcomeDecision?: (root: string, input: DecisionOutcomeCommand, options: ConfigLoadOptions) => Promise<DecisionOutcomeResult>;
}
