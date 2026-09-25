import { z } from 'zod';

/**
 * Agent tool contract (terminal tool loop, T-L1). A tool is data the model can call; it never grants authority — every
 * call is authorized for the principal and scope by policy before it runs. The class drives the default permission tier:
 * `read` needs no extra approval when policy permits, `edit`/`shell` follow the permission mode, `deckent` and `mcp` tools
 * reuse the authority of the operation they reach.
 */
export const agentToolClassSchema = z.enum(['read', 'edit', 'shell', 'deckent', 'mcp']);
export type AgentToolClass = z.infer<typeof agentToolClassSchema>;

/** A JSON Schema object subset as sent to the model; validated as plain data here, interpreted by the tool. */
const jsonSchemaObject = z.object({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()).optional() }).passthrough();

export const agentToolSpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  version: z.number().int().positive().safe(),
  toolClass: agentToolClassSchema,
  description: z.string().min(1).max(2000),
  inputSchema: jsonSchemaObject,
}).strict().readonly();
export type AgentToolSpec = z.infer<typeof agentToolSpecSchema>;

/** What a tool returns to the loop: model-facing text (bounded by the tool) and whether it succeeded. */
export const agentToolOutcomeSchema = z.object({
  status: z.enum(['ok', 'error']),
  text: z.string(),
}).strict().readonly();
export type AgentToolOutcome = z.infer<typeof agentToolOutcomeSchema>;

/**
 * Provider-neutral tool call as the loop sees it (T-L2): the provider's correlation id, the declared tool name and the raw
 * arguments text. Native details (OpenAI tool_call_id shapes, Anthropic block ids/signatures) stay in the adapter's native
 * result. Invalid JSON arguments are answered with a typed tool error; a call from an interrupted response is never executed.
 */
export const agentToolCallSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  argumentsJson: z.string(),
}).strict().readonly();
export type AgentToolCall = z.infer<typeof agentToolCallSchema>;
