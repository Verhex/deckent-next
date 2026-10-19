/** `--schema` on a JSON-input command: the caller asked for the input contract instead of running the command. */
export function schemaRequested(argv: readonly string[]): boolean {
  return argv.includes('--schema');
}

/**
 * Prints a command's input contract as JSON Schema (machine output, never translated). The schema arrives already projected from the
 * same zod schema the application validates, with the MCP tool list's projection (`zodToJsonSchema`, `$refStrategy: 'none'`), so CLI,
 * MCP and SDK describe one contract. The projection is `projectInputSchema` (`#engine/core/config`, an existing zod-to-json-schema owner;
 * J1 option B), so this unit needs no zod dependency.
 */
export function renderInputSchema(jsonSchema: unknown): string {
  if (jsonSchema === null || typeof jsonSchema !== 'object' || Array.isArray(jsonSchema)) throw new TypeError('CLI_INPUT_SCHEMA_OBJECT_REQUIRED');
  return JSON.stringify(jsonSchema, null, 2);
}
