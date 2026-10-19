import { ErrorRegistry, terminalSafeText } from '#platform/index.js';
import { projectInputSchema } from '#engine/index.js';
import { renderInputSchema } from '#surfaces/core/cli-human/index.js';

type Issue = Readonly<{ code: string; path: readonly (string | number)[]; keys?: readonly string[]; received?: unknown; unionErrors?: readonly { issues: readonly Issue[] }[] }>;
/** The application's own input schema (zod), seen only through `safeParse`: the surface owns no second contract. */
export type InputSchema = Readonly<{ safeParse(input: unknown): { success: boolean; error?: { issues: readonly Issue[] } } }>;

/** The first concrete problem: a union names its first member's issue (the plain decision is the first member of every union used here). */
function firstIssue(issues: readonly Issue[]): Issue | undefined {
  const issue = issues[0];
  return issue?.code === 'invalid_union' && issue.unionErrors?.[0] ? firstIssue(issue.unionErrors[0].issues) ?? issue : issue;
}

/**
 * Checks AI/JSON input against the same schema the application validates before anything is sent, so the refusal names the field
 * (CLI review "Hata doğruluğu": no `INVENTORY_QUERY_INVALID` / "model call" text for an approval or decision input). The application
 * still validates what it receives; this only words the first problem. `CLI_INPUT_FIELD_INVALID` is a usage error (exit 2).
 */
export function assertInputFields(command: string, schema: InputSchema, input: unknown, example: string): void {
  const result = schema.safeParse(input);
  if (result.success) return;
  const issue = firstIssue(result.error?.issues ?? []);
  const unknown = issue?.code === 'unrecognized_keys', missing = issue?.code === 'invalid_type' && issue.received === 'undefined';
  const path = [...(issue?.path ?? []), ...(unknown ? issue?.keys?.slice(0, 1) ?? [] : [])].map(String).join('.');
  throw ErrorRegistry.createError('CLI_INPUT_FIELD_INVALID', { params: { command: terminalSafeText(command), field: terminalSafeText(path || '-'),
    problem: unknown ? 'unknown' : missing ? 'missing' : 'invalid', example } });
}

/** `--schema`: the input contract as JSON Schema, projected from the application's zod schema exactly as the MCP tool list projects it. */
export const inputSchemaText = (schema: InputSchema) => renderInputSchema(projectInputSchema(schema as never));
