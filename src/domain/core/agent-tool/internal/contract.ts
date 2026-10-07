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

/**
 * What the host shell call could verify about processes it left behind in its process group (Astra 2124): `clean` — nothing
 * left; `group-ended` — surviving members were ended and the group was then observed empty; `unverified` — the group could not
 * be observed empty, or its pipes were released while still held (a descendant that left the group, e.g. `setsid`, is never
 * seen). Only the host shell tool's outcome ever carries this; every other tool leaves it undefined.
 */
export const agentToolCleanupSchema = z.enum(['clean', 'group-ended', 'unverified']);
export type AgentToolCleanup = z.infer<typeof agentToolCleanupSchema>;

/**
 * Where a workspace path failed (B4 diagnosis, owner terminal test 2026-10-07): the step (`realpath`, `open:<segment>`, `verify:<segment>`,
 * `stat`) and the system error code when one was raised. Short and secret-free: no path, no content. Optional everywhere it travels.
 */
export const agentToolDiagnosticSchema = z.object({
  step: z.string().regex(/^[a-z]+(?::\d{1,3})?$/u).max(16),
  errno: z.string().regex(/^E[A-Z0-9]{1,15}$/u).optional(),
}).strict().readonly();
export type AgentToolDiagnostic = z.infer<typeof agentToolDiagnosticSchema>;

/** What a tool returns to the loop: model-facing text (bounded by the tool) and whether it succeeded. */
export const agentToolOutcomeSchema = z.object({
  status: z.enum(['ok', 'error']),
  text: z.string(),
  cleanup: agentToolCleanupSchema.optional(),
  diagnostic: agentToolDiagnosticSchema.optional(),
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
