export { AGENT_TURN_MECHANICAL_COMPACTION_NOTE, AGENT_TURN_NO_PROGRESS_NOTE, agentTurnNoProgressNote, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ agentTurnTruncatedCallResult, agentTurnTruncatedCallsNote, runAgentTurn,
  agentToolArgumentsDigest } from './internal/loop.js';
export { projectModelIngressField } from './internal/model-ingress-project.js';
export { checkModelIngressArguments, projectModelIngressSchema } from './internal/model-ingress-json.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelIngressRecorder, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelIngressArgumentsResult } from './internal/model-ingress-json.js';
export { agentTurnApproverNote, type AgentToolOwnerAnswer } from './internal/approver-note.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelIngressDisposition, ModelIngressProjection } from './internal/model-ingress-project.js';
export type { AgentRoundOutcome, AgentTurnPorts, AgentTurnInput, AgentTurnResult } from './internal/loop.js';
export { runDurableAgentTurn } from './internal/durable.js';
export { AgentTurnStoreError, agentTurnOutcome, agentTurnResultDigest, agentTurnInterruptedNote, AGENT_TURN_ANSWER_MAX_BYTES, AGENT_TURN_INTERRUPTED_NOTE, agentTurnSteerRecordSchema } from './internal/store.js';
export type { AgentTurnStore, AgentTurnClaim, AgentTurnOutcome, AgentTurnToolCallRecord, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AgentTurnStoreErrorCode } from './internal/store.js';
export { AGENT_COMPACTION_HIGH_WATER, agentCompactionInstruction, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AGENT_COMPACTION_KEEP_MESSAGES, agentCompactionSummarySchema,
  agentCompactionTranscript, parseAgentCompactionSummary, planAgentCompaction, renderAgentCompaction } from './internal/compaction.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AgentCompactionPlan, AgentCompactionSummary } from './internal/compaction.js';
export { AGENT_CONTEXT_CARRY_VERSION, AGENT_CONTEXT_RENDER_VERSION } from './internal/carry.js';
export { agentTurnAdmission, type AgentTurnAdmission } from './internal/admission.js';
export { prepareApprovalPreview, APPROVAL_PREVIEW_MAX_BYTES, boundApprovalPreview, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ boundApprovalPreviewFacts, agentToolApprovalSummary, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ApprovalPreviewCut } from './internal/approval-preview.js';
export { AGENT_TURN_REPLY_LANGUAGES, AGENT_TURN_SYSTEM_PROMPT_VERSION, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ agentTurnReplyLanguageRule, renderAgentTurnSystemPrompt, withAgentTurnSystemPrompt, type AgentTurnReplyLanguage,
  type AgentTurnShellPosture } from './internal/system-prompt.js';
export { canonicalTurnRequest, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ TURN_NOTE_MAX_CHARS, fitChatTurnResult, chatTurnRoundFailureState, classifyProviderRejection, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ PROVIDER_REJECTION_KINDS } from './internal/metadata.js';
export type { ProviderRejectionKind } from './internal/metadata.js';
export { agentCompactionExpected, agentContextFailureNote, agentHistoryBytes, createAgentCompactionGuard, type AgentContextFailure } from './internal/pressure.js';
export { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AGENT_SESSION_CONTEXT_VERSION, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AGENT_SESSION_RULES, AGENT_SESSION_SURFACES, SESSION_STATE_TOOL_SPEC, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ agentSessionCells, agentSessionSnapshot, agentSessionStateText,
  renderAgentSessionContext, type AgentSessionCell, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type AgentSessionDecision, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type AgentSessionShellInput, type AgentSessionSnapshot } from './internal/session-context.js';
export { createInlineReasoningRouter, splitInlineReasoning } from './internal/inline-reasoning.js';
export { AI_PROPOSAL_TOOL_SPECS, aiProposalToolDecision, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ LIST_SETTING_CHOICES_TOOL_SPEC, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ PROPOSE_SETTING_TOOL_SPEC, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ PROPOSE_WORK_TOOL_SPEC, planAiProposal, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type AiProposalArgs } from './internal/proposals.js';
