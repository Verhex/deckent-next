import { projectInputSchema } from '#engine/index.js';
import { renderInputSchema, type InputSchema } from '#surfaces/core/cli-human/index.js';
export { assertInputFields, type InputSchema } from '#surfaces/core/cli-human/index.js';

/** `--schema`: the input contract as JSON Schema, projected from the application's zod schema exactly as the MCP tool list projects it. */
export const inputSchemaText = (schema: InputSchema) => renderInputSchema(projectInputSchema(schema as never));
