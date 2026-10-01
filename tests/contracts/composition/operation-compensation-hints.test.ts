import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { describeConfiguredOperationTools } from '#composition/core/operations/index.js';
import { createConfiguredRuntimeClient } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { conditionalRecordServer } from '../support/conditional-record-server.js';
import { startTestRuntimeService, stopTestRuntimeService } from '../support/runtime-service.js';

// Astra 2137/2139 R2 (reviewer repro astra-2137-compensation.test.ts.txt): a settled effect pins its descriptor, including the
// compensation it names. The compensating command's operation is resolved from the current catalog, the pairing from the pinned
// descriptor — so after the original leaves the live catalog its compensation is still reachable. A fresh MCP server built from the
// current catalog must not advertise `compensate_operation` as read-only / closed-world while it performs a real external write.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); clearConfigCache(); });
const ref = (id: string) => ({ id, version: 1 });
const descriptor = (id: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, operation: ref(id), targetKind: 'records',
  effectClass: 'write', approval: 'policy', precondition: 'record-version', compensation: null, inputMaxBytes: 4096, ...extra });
const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];

async function fixture() {
  const server = await conditionalRecordServer(); cleanup.push(server.close);
  const root = await mkdtemp(join(tmpdir(), 'dn-compensation-hints-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const env = { HOME: join(root, 'home') };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') },
    service: { inputMaxBytes: 65536, responseMaxBytes: 65536, maxConnections: 8, maxConcurrentRequests: 4,
      maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 },
    operations: { catalog: [descriptor('post-order', { compensation: ref('cancel-order') }), descriptor('cancel-order')],
      targets: [{ adapter: 'http-conditional', options: { kind: 'records', baseUrl: server.baseUrl, timeoutMs: 2000, responseMaxBytes: 65536, idempotencyLookup: true } }] } }));
  registerProviderConfig(); // as every composed entry does before loading configuration
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'ops-allow', restrictions: [], grants: [
    { id: 'operations', effect: 'allow', actions: ['execute', 'compensate', 'inspect'], scopes: ['s'], principals, resource: { kind: 'operation', ids: 'all' } },
    { id: 'approvals', effect: 'allow', actions: 'all', scopes: ['s'], principals, resource: { kind: 'approval', ids: 'all' } }] }), { mode: 0o600 });
  server.records.set('PO-1', 1);
  const command = (commandId: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1 as const, commandId, scopeId: 's', operation: ref('post-order'),
    target: { kind: 'records', id: 'PO-1' }, idempotencyKey: `key-${commandId}`, input: { amount: 10 },
    expectedVersion: server.etag(server.records.get('PO-1') ?? 0), ...extra });
  const service = await startTestRuntimeService(project, env);
  cleanup.push(() => stopTestRuntimeService(service));
  return { server, project, env, command, client: createConfiguredRuntimeClient(project, { env }) };
}

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] Astra 2137/2139 R2: compensation hints cover the pinned historical descriptor, even after the original leaves the live catalog', async () => {
  const f = await fixture();
  expect(await f.client.executeOperation(f.command('original'))).toMatchObject({ status: 'settled' });
  // The original operation leaves the catalog; its compensation (a write) stays. A fresh MCP server reads the current catalog.
  const path = join(f.project, '.deckent/config.json');
  const config = JSON.parse(await readFile(path, 'utf8')) as { operations: { catalog: unknown[] } };
  config.operations.catalog = [descriptor('cancel-order')];
  await writeFile(path, JSON.stringify(config));
  clearConfigCache();
  const catalog = await describeConfiguredOperationTools(f.project, { env: f.env });
  expect(catalog.map(entry => entry.operation.id)).toEqual(['cancel-order']);
  const mcp = createMcpServer({ ...f.client, operationCatalog: catalog } as never, { maxConcurrentCalls: 1, responseMaxBytes: 65536 }, 'en');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(b);
  const client = new Client({ name: 'compensation-hints', version: '1' });
  await client.connect(a);
  cleanup.push(async () => { await client.close(); await mcp.close(); });
  const tool = (await client.listTools()).tools.find(entry => entry.name === 'compensate_operation');
  // The advertised hints are the conservative ones: the tool can change an external target.
  expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  // ...and it really does: the historical compensation settles with a second external write.
  const result = await client.callTool({ name: 'compensate_operation', arguments: { ...f.command('undo'), operation: ref('cancel-order'), compensates: 'original' } });
  const value = result.structuredContent ?? JSON.parse((result.content as { text: string }[])[0]!.text);
  expect(result.isError).not.toBe(true);
  expect(value).toMatchObject({ status: 'settled', compensates: 'original' });
  expect(f.server.operations).toHaveLength(2);
}, 30_000);
