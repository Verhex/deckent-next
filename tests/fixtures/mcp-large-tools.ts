/** Synthetic GitHub-style catalog, not a captured vendor response: 128 tools with 20 described filters each. */
export function largeMcpTools(fields = 20) {
  return Array.from({ length: 128 }, (_, i) => ({ name: `repository_tool_${i}`, description: 'Repository operation with pagination and filters',
    inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: fields }, (_, j) => [`field_${j}`,
      { type: 'string', description: 'Repository filter or pagination parameter' }])), required: ['field_0'], additionalProperties: false }, annotations: { readOnlyHint: true } }));
}
