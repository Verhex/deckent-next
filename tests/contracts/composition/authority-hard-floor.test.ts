import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createShellPathContext, createWorkspaceReadTools, createWorkspaceScope, projectEditArea } from '#adapters/index.js';
import { classifyReadOnlyShellCommand, decideAgentToolCall } from '#engine/index.js';
import { getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID, resolvePolicyBindings } from '#domain/index.js';
import { agentWorkspaceDeny } from '#composition/core/agent-turn/index.js';
import { resolveProductLayout } from '#platform/index.js';

// POLICY-ADMIN (owner F2): the hard floor — policy, bindings, approval records and key, ledger, credentials, `.git` internals — is never
// opened to the agent tools by any grant or mode. Here the person holds the owner root (every vocabulary kind, 'all') and full-auto: the
// floor is path-level code that consults no policy, so the maximal policy changes nothing.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const DATA = '.deckent/live-data';
const FLOOR = [`${DATA}/policy.json`, `${DATA}/bindings.json`, `${DATA}/approvals/authority.key`, `${DATA}/state/ledger.db`, `${DATA}/state/ledger.db-wal`,
  `${DATA}/audit/authority-revisions/k-1.json`, '.git/config', '.git/hooks/pre-commit', '.env', 'keys/server.pem'];
const principal = { id: 'os:1000', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: ['s'] };
const kinds = getPolicyVocabulary().resources.map(resource => resource.kind);
const maximal = resolvePolicyBindings({ schemaVersion: 2, revision: 'p1', grants: [], restrictions: [], separationOfDuties: [],
  roles: [{ id: INSTALLATION_OWNER_ROLE_ID, permissions: installationOwnerPermissions(kinds).map(permission => ({ ...permission, effect: 'require-approval', modeEligible: true })) }] },
{ schemaVersion: 2, revision: 'b1', bindings: [{ id: 'root', principals: [{ issuer: 'host', subject: '1000' }], roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' }],
  modes: [{ id: 'fa', principal: { issuer: 'host', subject: '1000' }, scopes: ['s'], mode: 'full-auto' }] });

describe('authority hard floor under the owner root and full-auto', () => {
  it('refuses every hard-floor path to read, write planning and shell classification; the write floor still asks in full-auto', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dn-hard-floor-')); roots.push(base);
    const root = join(base, 'project');
    for (const path of [...FLOOR, 'src/a.ts']) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), `FLOOR ${path}\n`); }
    const layout = resolveProductLayout({ projectRoot: root, root: join(root, ...DATA.split('/')) });
    const scope = await createWorkspaceScope(root, agentWorkspaceDeny(root, layout));
    const tools = await createWorkspaceReadTools(root, { deny: agentWorkspaceDeny(root, layout) });
    const edits = projectEditArea(scope);
    for (const path of FLOOR) {
      expect((await tools.execute('read_file', { path })).text, path).toContain('error=path-denied');
      expect(await edits.plan('write_file', { path, content: 'x' }), path).toMatchObject({ ok: false });
      expect(await classifyReadOnlyShellCommand(`cat ${path}`, createShellPathContext(scope)), path).toMatchObject({ readOnly: false, reasonCode: 'PATH_PROTECTED' });
    }
    expect(await edits.plan('write_file', { path: 'src/a.ts', content: 'x' })).toMatchObject({ ok: true });
    // The maximal policy lowers an ordinary edit in full-auto, but never the write floor (`.deckent/config.json`, CI, manifests).
    const decide = (cell: 'edit' | 'edit-floor') => decideAgentToolCall(maximal, { principal, scopeId: 's', tool: { name: 'write_file' }, operation: { id: 'workspace.file.write' }, cell });
    expect(decide('edit')).toMatchObject({ decision: 'allow', relaxation: { mode: 'full-auto' } });
    expect(decide('edit-floor')).toMatchObject({ decision: 'require-approval', relaxation: null });
  });
});
