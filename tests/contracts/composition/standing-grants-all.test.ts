import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { listConfiguredAllStandingGrants } from '#composition/core/approvals/index.js';
import { clearConfigCache, resolveProductLayout } from '#platform/index.js';
import { openLocalIntegrityAuthority } from '#adapters/index.js';
import { getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID, mcpPrincipalRef } from '#domain/index.js';

// CA-1 through the configured path (real config, policy files and ledger; the local OS person): allowed only with `policy inspect-standing-grants`,
// refused with POLICY_DENIED otherwise; the ledger is opened read-only and only after the decision; the MCP surface gains no tool.
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const me = { issuer: hostname(), subject: String(userInfo().uid) };
const colleague = { issuer: 'idp.example', subject: 'colleague' };
const standing = (id: string, who: { issuer: string; subject: string }, key: string) => ({ id, effect: 'allow', actions: ['invoke'], scopes: ['proj'], principals: [who], resource: { kind: 'agent-tool-call', ids: [key] } });
const inspect = { id: 'first-run-standing-grants-all', effect: 'allow', actions: ['inspect-standing-grants'], scopes: ['proj'], principals: [me], resource: { kind: 'policy', ids: 'all' } };

async function fixture(rules: readonly unknown[], owner: boolean) {
  const project = await mkdtemp(join(tmpdir(), 'deckent-standing-all-')); roots.push(project);
  const data = join(project, 'data'); await mkdir(join(project, '.deckent'), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { HOME: join(project, 'home'), PATH: process.env.PATH ?? '/usr/bin:/bin' };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, inspection: { maxPageSize: 4, policyMaxBytes: 65536 } }));
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  const db = new DatabaseSync(opened.path);
  try { db.exec("INSERT OR IGNORE INTO companies(company_id) VALUES('default'); INSERT INTO scope_registry(scope_id,company_id,origin) VALUES('proj','default','start');"); }
  finally { db.close(); }
  await openLocalIntegrityAuthority(resolveProductLayout({ projectRoot: project, root: data }), 'authority.key', true);
  const kinds = getPolicyVocabulary().resources.filter(resource => owner || resource.kind !== 'policy').map(resource => resource.kind);
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 2, revision: 'p1', separationOfDuties: [], restrictions: [],
    roles: [{ id: INSTALLATION_OWNER_ROLE_ID, permissions: installationOwnerPermissions(kinds) }],
    grants: [...rules, standing('standing-mine', me, 'v1:run_shell:command:npm test'), standing('standing-theirs', colleague, 'v1:run_shell:command:make')] }), { mode: 0o600 });
  await writeFile(join(data, 'bindings.json'), JSON.stringify({ schemaVersion: 2, revision: 'b1', modes: [],
    bindings: [{ id: 'root', principals: [me], roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' }] }), { mode: 0o600 });
  return { project, env };
}

describe.skipIf(process.platform !== 'linux')('listConfiguredAllStandingGrants (CA-1)', () => {
  it('[requires Linux live OS session /proc identity] the person holding the grant sees both people\'s grants; without it POLICY_DENIED', async () => {
    const allowed = await fixture([inspect], false);
    const page = await listConfiguredAllStandingGrants(allowed.project, { scopeId: 'proj' }, { env: allowed.env });
    const key = (who: { issuer: string; subject: string }) => `${who.issuer}\0${who.subject}`;
    const expected = [['standing-theirs', colleague], ['standing-mine', me]] as const;
    expect(page.rows.map(row => [row.id, row.principals[0]])).toEqual([...expected].sort((a, b) => key(a[1]) < key(b[1]) ? -1 : 1));
    // Hand-written grants: no audited change made them, the sealed history was read and is complete.
    expect(page.since).toBe('complete'); expect(page.rows.every(row => row.sinceMs === null)).toBe(true);
    // The grant revoked (owner role without the `policy` kind, no explicit rule): refused, typed.
    const refused = await fixture([], false);
    await expect(listConfiguredAllStandingGrants(refused.project, { scopeId: 'proj' }, { env: refused.env })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // A forged cursor is an input error, not a permission answer.
    await expect(listConfiguredAllStandingGrants(allowed.project, { scopeId: 'proj', after: '!!' }, { env: allowed.env })).rejects.toMatchObject({ code: 'INVENTORY_QUERY_INVALID' });
  });

  it('the template grants no AI actor this read, and the MCP surface offers no tool for it', async () => {
    expect(mcpPrincipalRef(me).issuer).not.toBe(me.issuer);
    const { createMcpServer } = await import('#surfaces/core/mcp/index.js');
    const { Client } = await import('@modelcontextprotocol/client'), { InMemoryTransport } = await import('@modelcontextprotocol/server');
    const server = createMcpServer({} as never, { maxConcurrentCalls: 1, responseMaxBytes: 65536 }, 'en');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'no-standing-read', version: '1' });
    await server.connect(serverTransport); await client.connect(clientTransport);
    try { expect((await client.listTools()).tools.map(tool => tool.name).filter(name => /standing|grants/u.test(name))).toEqual([]); }
    finally { await client.close(); await server.close(); }
  });
});
