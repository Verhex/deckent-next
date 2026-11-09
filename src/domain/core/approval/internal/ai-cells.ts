import type { ApprovalFacts, ApprovalSubject } from './contract.js';
/** KG3 F2 (S1-D2): the card cells no AI principal allows, by card answer or by tool call (write floor, authority files, the pinned MCP floor).
 * Its own set, never merged with `HARD_FLOOR_CARD_CELLS`: a hard-floor cell outside it (`shell-destructive`) stays an AI-answerable card. */
export const AI_NON_DELEGABLE_CARD_CELLS = Object.freeze(['edit-floor', 'edit-authority', 'mcp-floor'] as const);
/** KG4 F4: the cards neither an AI principal nor an unwitnessed decider allows: no facts (a legacy card cannot prove its risk), a cell above, an
 * authority effect class, or a tool call whose risk is undeclared. */
export function aiMayNotAllow(facts: ApprovalFacts | null, subject: ApprovalSubject): boolean {
  const risk = facts?.risk ?? null;
  return facts === null || risk?.source === 'cell' && AI_NON_DELEGABLE_CARD_CELLS.some(cell => cell === risk.cell)
    || risk?.source === 'effect-class' && risk.authority || subject.kind === 'agent-tool-call' && risk === null;
}
