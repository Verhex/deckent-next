import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { auditCheckpointFixture } from '../support/audit-checkpoint.js';
import { verifyAudit, type AuditVerifyQuery } from '../../../src/index.js';
import { checkpointConfiguredAudit } from '#composition/core/audit/index.js';
import { mcpApplications } from '#composition/core/mcp/index.js';
import { clearConfigCache } from '#platform/index.js';
import { main, runKernelCommand } from '#surfaces/core/cli/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(process.platform === 'win32')('real SDK, CLI, MCP and doctor share read-only verification/export; policy rewrite is visible on every surface', async () => {
  const f = await auditCheckpointFixture(); roots.push(f.root); const query: AuditVerifyQuery = { schemaVersion: 1, scopeId: 's' };
  expect((await checkpointConfiguredAudit(f.root, f.installationId, f.options))[0]?.status).toBe('match');
  const inspect = (root: string, input: AuditVerifyQuery) => verifyAudit(root, input, f.options);
  const before = await readdir(f.data), policyBefore = await readFile(f.policyPath, 'utf8');
  const sdk = await inspect(f.root, query); expect(sdk.status).toBe('match');
  for (const lang of ['en', 'tr']) {
    let output = '';
    expect(await main(['audit', 'verify', '--scope', 's', '--lang', lang], { root: f.root, env: f.options.env, verifyAudit: inspect,
      stdout: { write: value => { output += value; } } })).toBe(0);
    expect(output).toContain(lang === 'tr' ? 'eşleşiyor' : 'match');
  }
  let json = '';
  expect(await main(['audit', 'verify', '--scope', 's', '--export-checkpoint'], { root: f.root, env: f.options.env, verifyAudit: inspect,
    stdout: { write: value => { json += value; } } })).toBe(0);
  expect(JSON.parse(json)).toEqual(sdk.checkpoint);
  const witnessPath = join(f.root, 'witness.json'); await writeFile(witnessPath, json);
  json = '';
  expect(await main(['audit', 'verify', '--scope', 's', '--checkpoint', witnessPath, '--json'], { root: f.root, env: f.options.env, verifyAudit: inspect,
    stdout: { write: value => { json += value; } } })).toBe(0); expect(JSON.parse(json)).toEqual(sdk);
  await writeFile(witnessPath, 'null');
  expect(await main(['audit', 'verify', '--scope', 's', '--checkpoint', witnessPath], { root: f.root, env: f.options.env, verifyAudit: inspect,
    stdout: { write() {} }, stderr: { write() {} } })).toBe(2);
  const server = createMcpServer(mcpApplications({ inspectRun: async () => null, inspectInventory: async () => null,
    verifyAudit: (input: AuditVerifyQuery) => inspect(f.root, input) }), { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
  const [ct, st] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'audit-proof', version: '1' });
  try {
    await server.connect(st); await client.connect(ct);
    expect((await client.listTools()).tools.find(tool => tool.name === 'verify_audit')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect((await client.callTool({ name: 'verify_audit', arguments: query })).structuredContent).toEqual(sdk);
    await expect(inspect(f.root, { ...query, scopeId: 'foreign' })).rejects.toBeDefined();
    expect(await readdir(f.data)).toEqual(before); expect(await readFile(f.policyPath, 'utf8')).toBe(policyBefore);
    await writeFile(f.policyPath, JSON.stringify({ ...f.document, grants: [...f.document.grants, { id: 'new-grant', effect: 'allow', actions: ['inspect'],
      scopes: ['s'], principals: f.document.grants[0]!.principals, resource: { kind: 'approval', ids: ['new'] } }] }));
    const drift = await inspect(f.root, query); expect(drift.status).toBe('policy-changed');
    let failed = '';
    expect(await main(['audit', 'verify', '--scope', 's'], { root: f.root, env: f.options.env, verifyAudit: inspect,
      stdout: { write: value => { failed += value; } } })).toBe(1); expect(failed).toContain('policy changed');
    expect((await client.callTool({ name: 'verify_audit', arguments: query })).structuredContent).toEqual(drift);
    json = ''; await runKernelCommand(['doctor', '--json'], { root: f.root, env: f.options.env, verifyAudit: inspect, stdout: { write: value => { json += value; } } });
    expect(JSON.parse(json)).toMatchObject({ status: 'degraded', auditIntegrity: { status: 'policy-changed' } });
    expect((await checkpointConfiguredAudit(f.root, f.installationId, f.options))[0]?.status).toBe('policy-changed');
    expect((await inspect(f.root, query)).checkpoint).toEqual(sdk.checkpoint);
    await writeFile(f.policyPath, JSON.stringify({ ...f.document, grants: [f.document.grants[1]] }));
    await expect(inspect(f.root, query)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    expect((await client.callTool({ name: 'verify_audit', arguments: query })).isError).toBe(true);
    json = ''; await runKernelCommand(['doctor', '--json'], { root: f.root, env: f.options.env, verifyAudit: inspect, stdout: { write: value => { json += value; } } });
    expect(JSON.parse(json)).toMatchObject({ status: 'degraded', auditIntegrity: { status: 'unknown', reason: 'unavailable' } });
    expect(await main(['audit', 'verify', '--scope', 's', '--json'], { root: f.root, env: f.options.env,
      verifyAudit: async () => ({ schemaVersion: 1, scopeId: 's', status: 'unknown', reason: 'unavailable', head: null, checkpoint: null }),
      stdout: { write() {} } })).toBe(1);
  } finally { await client.close(); await server.close(); }
});

it.skipIf(process.platform !== 'win32')('unsupported Windows policy custody refuses before ledger/key/identity access rather than silently downgrading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-audit-unsupported-')); roots.push(root);
  const data = join(root, 'data'); await mkdir(data); await mkdir(join(root, '.deckent'));
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, terminal: { scopeId: 's' } }));
  await expect(verifyAudit(root, { schemaVersion: 1, scopeId: 's' }, { env: { DECKENT_GLOBAL_HOME: join(root, 'home') } }))
    .rejects.toMatchObject({ code: 'POLICY_UNAVAILABLE' });
  expect(await readdir(data)).toEqual([]);
});
