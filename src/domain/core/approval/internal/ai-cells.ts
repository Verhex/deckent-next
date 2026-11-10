import { approvalFacts, approvalSubject, type ApprovalFacts, type ApprovalRequest, type ApprovalSubject } from './contract.js';
import { AI_PROPOSAL_REGISTRY } from '#domain/core/agent-tool/index.js';
/** KG3 F2 (S1-D2): the card cells no AI principal allows, by card answer or by tool call (write floor, authority files, the pinned MCP floor).
 * Its own set, never merged with `HARD_FLOOR_CARD_CELLS`: a hard-floor cell outside it (`shell-destructive`) stays an AI-answerable card. */
export const AI_NON_DELEGABLE_CARD_CELLS = Object.freeze(['edit-floor', 'edit-authority', 'mcp-floor'] as const);
/** Owner S4–S6: an AI proposal needs the person's decision, regardless of delegated approval grants. */
export function requiresPersonProposalDecision(request: ApprovalRequest): boolean {
  const subject = approvalSubject(request), risk = approvalFacts(request)?.risk;
  return subject.kind === 'agent-tool-call' ? [AI_PROPOSAL_REGISTRY.tools.mcp, AI_PROPOSAL_REGISTRY.tools.work, AI_PROPOSAL_REGISTRY.tools.setting].some(tool => tool === subject.tool)
    : (subject.kind === 'config-change' || subject.kind === 'run-create') && risk?.source === 'effect-class' && risk.authority;
}
/** KG4 F4: the cards neither an AI principal nor an unwitnessed decider allows: no facts (a legacy card cannot prove its risk), a cell above, an
 * authority effect class, or a tool call whose risk is undeclared. */
export function aiMayNotAllow(facts: ApprovalFacts | null, subject: ApprovalSubject): boolean {
  const risk = facts?.risk ?? null;
  return facts === null || risk?.source === 'cell' && AI_NON_DELEGABLE_CARD_CELLS.some(cell => cell === risk.cell)
    || risk?.source === 'effect-class' && risk.authority || subject.kind === 'agent-tool-call' && risk === null;
}
