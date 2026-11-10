export { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ taskDependencySchema, dependencyTaskId, taskDependencyIds, blockingDependencyIds, isConflictEdge, taskResourceSchema, TASK_GRAPH_RESOURCE_SCHEMA_VERSION, taskInputNameSchema, TASK_GRAPH_SCHEMA_VERSION, taskDefinitionSchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ taskEligibilitySchema, taskGraphSchema, taskProgressSchema,
  readinessInputSchema, TaskGraphError, TASK_NOT_ACCEPTED_REASONS } from './internal/contract.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ TaskDependency, TaskDefinition, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ TaskEligibility, TaskGraph, TaskProgress, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ReadinessInput, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ TaskGraphErrorCode, TaskNotAcceptedReason } from './internal/contract.js';
export { validateTaskGraph } from './internal/graph.js';
export { measureTaskGraph, summarizeTaskGraph, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ taskGraphShapeSchema, taskGraphSummarySchema } from './internal/shape.js';
export type { TaskGraphShape, TaskGraphSummary } from './internal/shape.js';
export { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WORK_INPUT_SCHEMA_VERSION, WORK_INPUT_ASSIGNED_SCHEMA_VERSION, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WORK_INPUT_TEXT_MAX_BYTES, workInputSchema } from './internal/work-input.js';
export type { WorkInput } from './internal/work-input.js';
export { inspectTaskReadiness } from './internal/readiness.js';
export { conflictKeys, resourcePathsIntersect, resourceKeysIntersect, withConflictEdges, hasConflictEdges, excludeConflicting } from './internal/conflict.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ResourceKey } from './internal/conflict.js';
export type { TaskReadiness } from './internal/readiness.js';
export { criterionDefinitionSchema } from './internal/criteria.js';
export type { CriterionDefinition } from './internal/criteria.js';
export { CRITERION_TEXT_LIMITS } from './internal/criteria.js';
export { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ CRITERION_ENCODING_VERSION, encodeCriterionDefinition, encodeDeckentJson } from './internal/criterion-encoding.js';

export { branchInputSchema, branchDecisionSchema, resolveAdmissionBranch, assertAdmissionBranch } from './internal/branch.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ BranchDecision } from './internal/branch.js';
