export { agentToolCallSchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ agentToolClassSchema, agentToolSpecSchema, agentToolOutcomeSchema, agentToolCleanupSchema, agentToolDiagnosticSchema } from './internal/contract.js';
export type { AgentToolCall, AgentToolClass, AgentToolSpec, AgentToolOutcome, AgentToolCleanup, AgentToolDiagnostic } from './internal/contract.js';
export type { ShellRealm, ShellRealmContainment, ShellRealmMode, ShellRealmRequest, ShellRealmResult } from './internal/shell-realm.js';
export { modelTextBoundary, modelTextPrefix, wellFormedModelJson, wellFormedModelText } from './internal/text.js';
export { AI_PROPOSAL_REGISTRY, aiSettingResourceIds, isAiSettingKey, type AiSettingKey } from './internal/ai-proposals.js';
