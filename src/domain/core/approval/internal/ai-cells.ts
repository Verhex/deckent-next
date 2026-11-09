/** KG3 F2 (S1-D2): the card cells no AI principal allows, by card answer or by tool call (write floor, authority files, the pinned MCP floor).
 * Its own set, never merged with `HARD_FLOOR_CARD_CELLS`: a hard-floor cell outside it (`shell-destructive`) stays an AI-answerable card. */
export const AI_NON_DELEGABLE_CARD_CELLS = Object.freeze(['edit-floor', 'edit-authority', 'mcp-floor'] as const);
