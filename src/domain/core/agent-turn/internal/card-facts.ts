import { z } from 'zod';

/**
 * REVERSIBILITY (owner 2026-10-07, Jev 8cc5e230): what an approval card may honestly say about undoing a tool call, by what the call is. Never
 * "reversible" without evidence: no Core tool keeps the previous content of a file it writes (the effect journal keeps digests only), so an
 * edit is `unverified`; a shell command `may-change` the system, a destructive one (the classifier's destructive table) is `irreversible`;
 * a fetch and a read tool change nothing here (`no-change`); an MCP tool says what its server declares in the pinned definition's
 * `ToolAnnotations` (`readOnlyHint`, `destructiveHint` — hints only, per the MCP schema read 2026-10-07), `server-silent` when it declares neither. A catalog
 * operation keeps its own sealed facts (compensation / none / irreversible).
 */
export const AGENT_TOOL_UNDO = Object.freeze(['unverified', 'may-change', 'irreversible', 'no-change', 'server-read-only', 'server-additive', 'server-destructive',
  'server-silent'] as const);
export type AgentToolUndo = typeof AGENT_TOOL_UNDO[number];
export const agentToolUndoSchema = z.enum(AGENT_TOOL_UNDO);
/** The kinds of call an approval card can describe (the producer knows which of its tools a call is). */
export type AgentToolUndoKind = 'read' | 'edit' | 'shell' | 'fetch' | 'mcp';
/** An MCP server's own declaration (pinned): only the two hints that speak about change. */
export interface McpToolChangeHints { readonly readOnly?: boolean | undefined; readonly destructive?: boolean | undefined }

/**
 * POSTURE (L1 D2/D4): where a shell call on an approval card runs, as structured facts the surface words in its own language (the engine's
 * English sentence stays in the preview for the model and the line surface). `realm` is the realm's own id (open vocabulary: an Enterprise
 * realm adds its id without editing Core; a surface without a name for it shows the id). `project`/`git` mirror the realm's write view;
 * `network` says whether the call can reach a network; `passedOver` names preferred realms that could not be used.
 */
export const agentShellPostureSchema = z.object({ realm: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/), containment: z.enum(['sandbox', 'degraded', 'host']),
  project: z.enum(['writable', 'writable-except-floor', 'read-only', 'write-set']), git: z.enum(['writable', 'read-only']), network: z.enum(['reachable', 'closed']),
  passedOver: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/)).max(8).readonly() }).strict().readonly();
export type AgentShellPosture = z.infer<typeof agentShellPostureSchema>;
