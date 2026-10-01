import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { DeckentJsonSchemaValidator } from '#platform/core/validate/index.js';
import { createMcpServer, type McpApplications } from '#surfaces/core/mcp/index.js';

// FASTURI-OUT (owner 2026-09-29): the published package replaces the MCP SDK's default (ajv + fast-uri) validator with a stub that throws
// when built, so every Deckent path must hand the SDK a validator. MCP-SCHEMA-VALIDATOR (owner 2026-09-29): that validator is Deckent's own
// (`#platform/core/validate`); the SDK's @cfworker/json-schema provider is not used either. The dev/test tree still installs the SDK with ajv
// and cf-worker inside; these checks keep Deckent code off them (the client's compile path is spied in tests/contracts/adapters/mcp-client.test.ts).
const SRC = join(import.meta.dirname, '../../../src');
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
const SDK_DEFAULT_VALIDATOR = /^@modelcontextprotocol\/[^/]+\/(?:_shims|validators\/(?:ajv|cf-worker))$/u;
const SDK_CONSTRUCTED = new Set(['Client', 'Server', 'McpServer']);

/** Every SDK default-validator specifier, every SDK Client/Server construction without `jsonSchemaValidator`, and every one-argument
 * `fromJsonSchema` call (it builds the default lazily) in src, plus the constructions seen (positive control). */
function scan() {
  const violations: string[] = [], constructions: string[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('@modelcontextprotocol/')) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), at = (node: ts.Node) => `${relative(SRC, file).replaceAll('\\', '/')}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && SDK_DEFAULT_VALIDATOR.test(node.text)) violations.push(`${at(node)} names ${node.text}`);
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && SDK_CONSTRUCTED.has(node.expression.text)) {
        constructions.push(at(node));
        const options = node.arguments?.[1];
        const passes = options !== undefined && ts.isObjectLiteralExpression(options) && options.properties.some(property => property.name !== undefined
          && ts.isIdentifier(property.name) && property.name.text === 'jsonSchemaValidator');
        if (!passes) violations.push(`${at(node)} new ${node.expression.text}(...) without jsonSchemaValidator`);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fromJsonSchema' && node.arguments.length < 2) {
        violations.push(`${at(node)} fromJsonSchema(...) without a validator`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { violations, constructions };
}

describe('MCP SDK default validator (ajv/fast-uri) is never used by Deckent code', () => {
  it('src names no default-validator module and every SDK Client/Server carries jsonSchemaValidator', () => {
    const { violations, constructions } = scan();
    expect(violations).toEqual([]);
    // Positive control: the pool's Client and the MCP surface's Server are both seen, so an empty violation list means something.
    expect(constructions.map(site => site.replace(/:\d+$/u, '')).sort()).toEqual(['adapters/core/mcp-client/internal/pool.ts', 'surfaces/core/mcp/internal/server.ts']);
  });

  it('the Server Deckent builds validates with Deckent\'s own validator, not the SDK default or cf-worker', async () => {
    const server = createMcpServer({}, { maxConcurrentCalls: 1, responseMaxBytes: 1000 }, 'en');
    try {
      // Private SDK field (no public accessor): read only here, as the runtime counterpart of the static check above.
      expect((server as unknown as { _jsonSchemaValidator: unknown })._jsonSchemaValidator).toBeInstanceOf(DeckentJsonSchemaValidator);
    } finally { await server.close(); }
  });

  it('every tool Deckent\'s MCP server lists has an inputSchema its own validator compiles (draft-07 from zod-to-json-schema)', async () => {
    // Every optional application present (the operation catalog is data, not a handler), so every tool is listed.
    const applications = new Proxy({}, { get: (_target, key) => key === 'operationCatalog' ? [] : async () => ({}) }) as McpApplications;
    const server = createMcpServer(applications, { maxConcurrentCalls: 1, responseMaxBytes: 1000 }, 'en');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' }, { jsonSchemaValidator: new DeckentJsonSchemaValidator() });
    await server.connect(serverSide); await client.connect(clientSide);
    try {
      const tools = (await client.listTools()).tools, validator = new DeckentJsonSchemaValidator(), refused: string[] = [];
      for (const tool of tools) try { validator.getValidator(tool.inputSchema); } catch (error) { refused.push(`${tool.name}: ${(error as Error).message}`); }
      expect(refused).toEqual([]);
      expect(tools.length).toBeGreaterThan(20);
    } finally { await client.close(); await server.close(); }
  });
});
