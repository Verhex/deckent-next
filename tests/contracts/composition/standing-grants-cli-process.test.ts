import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache } from '#platform/index.js';
import { getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID } from '#domain/index.js';
import { cliChildEnv } from '../support/child-env.js';

// PERSISTENT-APPROVALS G6 on the shipped CLI (built binary, real config, ledger, policy files): `policy grants --mine` shows only the caller's own
// standing grants; `policy revoke <id> --yes` removes one through `policy.administer@1` — audited, archived, the other person's grant untouched.
const exec = promisify(execFile); const roots: string[] = [];
const binary = resolve('dist/composition/core/cli/internal/entry.js');
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const me = { issuer: hostname(), subject: String(userInfo().uid) };
const colleague = { issuer: 'idp.example', subject: 'colleague' };
const KEY = 'v1:run_shell:command:npm test';
const standing = (id: string, who: { issuer: string; subject: string }, key: string) => ({ id, effect: 'allow', actions: ['invoke'], scopes: ['proj'], principals: [who], resource: { kind: 'agent-tool-call', ids: [key] } });

async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'deckent-standing-cli-')); roots.push(project);
  const data = join(project, 'data'); await mkdir(join(project, '.deckent'), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = cliChildEnv({ HOME: join(project, 'home'), DECKENT_LANGUAGE: 'en', NO_COLOR: '1' }); delete env.DECKENT_HOME;
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, inspection: { maxPageSize: 4, policyMaxBytes: 65536 } }));
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  const db = new DatabaseSync(opened.path);
  try { db.exec("INSERT OR IGNORE INTO companies(company_id) VALUES('default'); INSERT INTO scope_registry(scope_id,company_id,origin) VALUES('proj','default','start');"); }
  finally { db.close(); }
  const kinds = getPolicyVocabulary().resources.map(resource => resource.kind);
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 2, revision: 'p1', separationOfDuties: [], restrictions: [],
    roles: [{ id: INSTALLATION_OWNER_ROLE_ID, permissions: installationOwnerPermissions(kinds) }],
    grants: [standing('standing-mine', me, KEY), standing('standing-theirs', colleague, 'v1:run_shell:command:make')] }), { mode: 0o600 });
  await writeFile(join(data, 'bindings.json'), JSON.stringify({ schemaVersion: 2, revision: 'b1', modes: [],
    bindings: [{ id: 'root', principals: [me], roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' }] }), { mode: 0o600 });
  return { project, data, env, ledger: opened.path };
}
async function cli(f: { project: string; env: NodeJS.ProcessEnv }, args: readonly string[]) {
  try { return { exit: 0, value: JSON.parse((await exec(process.execPath, [binary, ...args, '--json'], { cwd: f.project, env: f.env })).stdout) }; }
  catch (error) { const failure = error as { code: number; stderr: string }; return { exit: failure.code, stderr: failure.stderr }; }
}

describe.skipIf(process.platform === 'win32')('deckent policy grants / revoke (G6)', () => {
  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] lists only the caller\'s own standing grants and revokes one through the governed operation: audited, archived, the colleague\'s grant untouched', async () => {
    const f = await fixture();
    const listed = await cli(f, ['policy', 'grants', '--mine', '--scope', 'proj']);
    expect(listed).toEqual({ exit: 0, value: [{ id: 'standing-mine', key: KEY, tool: 'run_shell', kind: 'command', text: 'npm test' }] });
    // Without --yes and without a terminal the person is not asked: the grant is kept.
    const kept = await cli(f, ['policy', 'revoke', 'standing-mine', '--scope', 'proj']);
    expect(kept.value).toMatchObject({ revoked: false, grant: { id: 'standing-mine' } });
    expect(JSON.parse(await readFile(join(f.data, 'policy.json'), 'utf8')).grants).toHaveLength(2);
    // Someone else's grant is not the caller's to revoke.
    expect((await cli(f, ['policy', 'revoke', 'standing-theirs', '--scope', 'proj', '--yes'])).value).toEqual({ revoked: false, grant: null });
    const revoked = await cli(f, ['policy', 'revoke', 'standing-mine', '--scope', 'proj', '--yes']);
    expect(revoked.value).toMatchObject({ revoked: true, grant: { id: 'standing-mine' } });
    const after = JSON.parse(await readFile(join(f.data, 'policy.json'), 'utf8'));
    expect(after.grants.map((grant: { id: string }) => grant.id)).toEqual(['standing-theirs']);
    expect((await cli(f, ['policy', 'grants', '--mine', '--scope', 'proj'])).value).toEqual([]);
    const db = new DatabaseSync(f.ledger, { readOnly: true });
    try {
      const events = db.prepare('SELECT record FROM audit_events ORDER BY sequence').all().map(row => (JSON.parse(String(row['record'])) as { event: { subject: { kind: string; counts?: unknown } } }).event.subject);
      expect(events).toEqual([expect.objectContaining({ kind: 'authority-change', counts: expect.objectContaining({ grantsRemoved: 1 }) })]);
    } finally { db.close(); }
    expect((await readdir(join(f.data, 'audit', 'authority-revisions'))).filter(name => name.startsWith('k-'))).toHaveLength(1);
  });
});
