export { taskDependencySchema, dependencyTaskId, taskDependencyIds, blockingDependencyIds, isConflictEdge, taskResourceSchema, TASK_GRAPH_RESOURCE_SCHEMA_VERSION, taskInputNameSchema, TASK_GRAPH_SCHEMA_VERSION, taskDefinitionSchema, taskEligibilitySchema, taskGraphSchema, taskProgressSchema,
  readinessInputSchema, TaskGraphError, TASK_NOT_ACCEPTED_REASONS } from './internal/contract.js';
export type { TaskDependency, TaskDefinition, TaskEligibility, TaskGraph, TaskProgress, ReadinessInput, TaskGraphErrorCode, TaskNotAcceptedReason } from './internal/contract.js';
export { validateTaskGraph } from './internal/graph.js';
export { measureTaskGraph, summarizeTaskGraph, taskGraphShapeSchema, taskGraphSummarySchema } from './internal/shape.js';
export type { TaskGraphShape, TaskGraphSummary } from './internal/shape.js';
export { WORK_INPUT_SCHEMA_VERSION, WORK_INPUT_TEXT_MAX_BYTES, workInputSchema } from './internal/work-input.js';
export type { WorkInput } from './internal/work-input.js';
export { inspectTaskReadiness } from './internal/readiness.js';
export { conflictKeys, resourcePathsIntersect, resourceKeysIntersect, withConflictEdges, hasConflictEdges, excludeConflicting } from './internal/conflict.js';
export type { ResourceKey } from './internal/conflict.js';
export type { TaskReadiness } from './internal/readiness.js';
export { criterionDefinitionSchema } from './internal/criteria.js';
export type { CriterionDefinition } from './internal/criteria.js';
export { CRITERION_TEXT_LIMITS } from './internal/criteria.js';
export { CRITERION_ENCODING_VERSION, encodeCriterionDefinition, encodeDeckentJson } from './internal/criterion-encoding.js';

export { branchInputSchema, branchDecisionSchema, resolveAdmissionBranch, assertAdmissionBranch } from './internal/branch.js';
export type { BranchDecision } from './internal/branch.js';
