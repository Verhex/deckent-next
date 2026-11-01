import { ErrorRegistry, terminalSafeText } from '#platform/index.js';

/** `--schema` on a JSON-input command: the caller asked for the input contract instead of running the command. */
export function schemaRequested(argv: readonly string[]): boolean {
  return argv.includes('--schema');
}

/**
 * Prints a command's input contract as JSON Schema (machine output, never translated). The schema arrives already projected from the
 * same zod schema the application validates, with the MCP tool list's projection (native `z.toJSONSchema`, inline references), so CLI,
 * MCP and SDK describe one contract. The projection is `projectInputSchema` (`#engine/core/config`, the shared native projection owner;
 * J1 option B), so this unit needs no zod dependency.
 */
export function renderInputSchema(jsonSchema: unknown): string {
  if (jsonSchema === null || typeof jsonSchema !== 'object' || Array.isArray(jsonSchema)) throw new TypeError('CLI_INPUT_SCHEMA_OBJECT_REQUIRED');
  return JSON.stringify(jsonSchema, null, 2);
}

type Issue = Readonly<{ code: string; path: readonly PropertyKey[]; keys?: readonly string[]; received?: unknown; unionErrors?: readonly { issues: readonly Issue[] }[]; errors?: readonly (readonly Issue[])[] }>;
/** The application's own input schema (zod), seen only through `safeParse`: the surface owns no second contract. */
export type InputSchema = Readonly<{ safeParse(input: unknown): { success: boolean; error?: { issues: readonly Issue[] } | undefined } }>;

/** The first concrete problem: a union names its first member's issue (the plain decision is the first member of every union used here). */
function firstIssue(issues: readonly Issue[]): Issue | undefined {
  const issue = issues[0];
  const branch = issue?.errors?.[0] ?? issue?.unionErrors?.[0]?.issues;
  return issue?.code === 'invalid_union' && branch ? firstIssue(branch) ?? issue : issue;
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
  // Missing = the named field is absent from the input (whatever check failed first: type, literal, union).
  const unknown = issue?.code === 'unrecognized_keys', at = issue?.path ?? [];
  const missing = !unknown && at.length > 0 && at.reduce<unknown>((value, key) => value !== null && typeof value === 'object' ? (value as Record<PropertyKey, unknown>)[key] : undefined, input) === undefined;
  const path = [...at, ...(unknown ? issue?.keys?.slice(0, 1) ?? [] : [])].map(String).join('.');
  throw ErrorRegistry.createError('CLI_INPUT_FIELD_INVALID', { params: { command: terminalSafeText(command), field: terminalSafeText(path || '-'),
    problem: unknown ? 'unknown' : missing ? 'missing' : 'invalid', example } });
}
