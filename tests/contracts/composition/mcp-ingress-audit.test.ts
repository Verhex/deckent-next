import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { mcpApplications } from '#composition/core/mcp/index.js';
// Directly exercise the composition-owned audit port wired by the production MCP entry, without starting stdio/live.
// eslint-disable-next-line no-restricted-imports
import { recordConfiguredMcpIngress } from '#composition/core/mcp/internal/ingress.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { AuditApplication, projectModelIngressField, verifyAuditRecord } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteAuditStore } from '#adapters/index.js';
import { productResourcePath } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(process.platform === 'win32')('native-worker MCP refusal persists sealed digest-only audit under the MCP principal and actual policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-ingress-audit-')); roots.push(root);
  await applyPolicyTemplateInstallation(root, 's');
  const config = await loadComposedConfig(root, { heal: false }), policyPath = productResourcePath(config.productLayout, 'policy');
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const actor = { issuer: `${hostname()}/mcp`, subject: String(userInfo().uid) };
  policy.grants.push({ id: 'mcp-scope-read', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [actor], resource: { kind: 'scope', ids: ['s'] } });
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  const effective = await mcpApplications({ load: () => loadConfiguredScopeContext(root, 's', { heal: false }, 'read') }).load();
  let entered = 0;
  const applications = mcpApplications({ async inspectRun() { entered++; return {}; }, async inspectInventory() { return {}; },
    recordModelIngress: (notice: ReturnType<typeof projectModelIngressField>, input: unknown) => recordConfiguredMcpIngress(root, notice, input) });
  const server = createMcpServer(applications, { maxConcurrentCalls: 1, responseMaxBytes: 4096 }, 'en');
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
  const client = new Client({ name: 'native-worker', version: '1' }); await client.connect(ct);
  try {
    const raw = 'private\u{e0070}\u{e0077}\u{e006e}';
    const result = await client.callTool({ name: 'inspect_run', arguments: { schemaVersion: 1, scopeId: 's', runId: raw } });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('MCP_INPUT_INVALID'); expect(entered).toBe(0);
    const store = await openSqliteAuditStore(productResourcePath(config.productLayout, 'ledger'), config.storage.sqlite, 'forbid');
    try {
      const integrity = await openLocalIntegrityAuthority(config.productLayout, config.approvals.keyFile);
      const records = new AuditApplication(store, integrity).list('s', 0, 100);
      const record = records.find(row => row.event.subject.kind === 'model-ingress');
      expect(record).toBeDefined();
      expect(record!.event).toMatchObject({ principal: actor, policyRevision: effective.document.revision, scopeId: 's', subject: {
        kind: 'model-ingress', disposition: 'quarantine', codePoints: 3, fieldDigest: projectModelIngressField(raw).fieldDigest,
        decodedDigest: projectModelIngressField(raw).decodedDigest } });
      expect(verifyAuditRecord(record!, integrity)).toEqual(record);
      expect(JSON.stringify(records)).not.toContain('private'); expect(JSON.stringify(records)).not.toContain('pwn');
      const count = records.length;
      expect((await client.callTool({ name: 'inspect_run', arguments: { schemaVersion: 1, scopeId: 's', runId: 'clean' } })).isError).not.toBe(true);
      expect(entered).toBe(1); expect(new AuditApplication(store, integrity).list('s', 0, 100)).toHaveLength(count);
    } finally { store.close(); }
    // No scope admission means no claimed audit receipt, but the invalid call still never reaches its application.
    expect((await client.callTool({ name: 'inspect_run', arguments: { schemaVersion: 1, scopeId: 'foreign', runId: raw } })).isError).toBe(true);
    expect(entered).toBe(1);
  } finally { await client.close(); await server.close(); }
});
