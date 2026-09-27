import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { openLocalIntegrityAuthority, openSqliteApprovalStore } from '#adapters/index.js';
import { requestTaskApproval } from '#engine/index.js';
import { clearConfigCache, loadConfig } from '#platform/index.js';
import { cliChildEnv } from '../support/child-env.js';
import { startTestRuntimeService } from '../support/runtime-service.js';

// H34 S2 on shipped surfaces: a v2 role reached only through the bindings resource authorizes a CLI and an SDK operation, and the
// policy's four-eyes rule refuses the requester's own approval on the SDK and on the CLI (runtime) decision path.
const exec = promisify(execFile); const roots: string[] = [];
const binary = resolve('dist/composition/core/cli/internal/entry.js'); const sdk = pathToFileURL(resolve('dist/index.js')).href;
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const actor = { issuer: hostname(), subject: String(userInfo().uid) };
const policy = { schemaVersion: 2, revision: 'p1', grants: [], restrictions: [],
  separationOfDuties: [{ id: 'four-eyes', rule: 'requester-cannot-approve', scopes: 'all' }],
  roles: [{ id: 'operator', permissions: [
    { id: 'inspect-scope', effect: 'allow', actions: ['inspect'], resource: { kind: 'scope', ids: 'all' } },
    { id: 'approvals', effect: 'allow', actions: ['inspect', 'decide'], resource: { kind: 'approval', ids: 'all' } }] }] };
const bindings = (principals = [actor]) => ({ schemaVersion: 1, revision: 'b1', bindings: [{ id: 'operators', principals, roles: ['operator'], scopes: ['proj'] }] });

async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'deckent-role-bindings-')); roots.push(project);
  const data = join(project, 'data'); await mkdir(join(project, '.deckent'), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = cliChildEnv({ HOME: join(project, 'home'), DECKENT_LANGUAGE: 'en', NO_COLOR: '1' }); delete env.DECKENT_HOME;
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, inspection: { maxPageSize: 4, policyMaxBytes: 65536 } }));
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  // `proj` is registered to the default company (as an admin declaration would); bindings never declare scopes.
  const db = new DatabaseSync(opened.path);
  try { db.exec("INSERT OR IGNORE INTO companies(company_id) VALUES('default'); INSERT INTO scope_registry(scope_id,company_id,origin) VALUES('proj','default','start');"); }
  finally { db.close(); }
  await writeFile(join(data, 'policy.json'), JSON.stringify(policy), { mode: 0o600 });
  await writeFile(join(data, 'bindings.json'), JSON.stringify(bindings()), { mode: 0o600 });
  const config = await loadConfig(project, { env });
  const integrity = await openLocalIntegrityAuthority(config.productLayout, config.approvals.keyFile, true);
  const journal = openSqliteApprovalStore(opened.path, config.storage.sqlite);
  const request = (requester: { id: string; issuer: string; subject: string }, digest: string) => requestTaskApproval(journal.store, integrity, {
    scopeId: 'proj', runId: 'run', taskId: 'task', requester, actionDigest: digest.repeat(64), policyRevision: 'p1+b1', summary: 'Execute task',
    createdAt: Date.now(), expiresAt: Date.now() + 600_000 }).request.approvalId;
  const own = request({ id: 'me', ...actor }, 'a'), colleague = request({ id: 'colleague', issuer: 'idp.example', subject: 'colleague' }, 'b');
  journal.close();
  return { project, data, env, own, colleague };
}
async function cli(f: { project: string; env: NodeJS.ProcessEnv }, args: readonly string[]) {
  try { return { exit: 0, value: JSON.parse((await exec(process.execPath, [binary, ...args, '--json'], { cwd: f.project, env: f.env })).stdout) }; }
  catch (error) { const failure = error as { code: number; stderr: string }; return { exit: failure.code, code: JSON.parse(failure.stderr).code }; }
}
async function library(f: { project: string; env: NodeJS.ProcessEnv }, body: string) {
  const out = await exec(process.execPath, ['--input-type=module', '-e', `import * as sdk from ${JSON.stringify(sdk)};
    try { console.log(JSON.stringify(await (async () => { ${body} })())); } catch (error) { console.log(JSON.stringify({ code: error.code ?? error.message })); }`],
  { cwd: f.project, env: f.env });
  return JSON.parse(out.stdout.trim());
}
const decide = (approvalId: string, commandId: string) => ({ schemaVersion: 1, scopeId: 'proj', approvalId, commandId, expectedRevision: 0, decision: 'allow', reason: 'four-eyes' });

describe.skipIf(process.platform === 'win32')('policy v2 roles and bindings on shipped surfaces', () => {
  it('a role reached only through bindings authorizes CLI and SDK; four-eyes refuses self-approval on SDK and CLI', async () => {
    const f = await fixture();
    await startTestRuntimeService(f.project, f.env);
    // Authorized operation through the binding (CLI via the runtime socket, SDK in process).
    const inventory = await cli(f, ['inventory', '--scope', 'proj']);
    expect(inventory.exit).toBe(0); expect(inventory.value).toMatchObject({ schemaVersion: 1 });
    expect(await library(f, "return (await sdk.inspectInventory(process.cwd(), { schemaVersion: 1, scopeId: 'proj' })).schemaVersion;")).toBe(1);
    // Four-eyes: the requester's own approval is a typed refusal on both surfaces and stays pending.
    expect(await library(f, `return sdk.configuredApproval(process.cwd(), 'decide', ${JSON.stringify(decide(f.own, 'sdk-self'))});`)).toEqual({ code: 'APPROVAL_DENIED' });
    const commandPath = join(f.project, 'self.json'); await writeFile(commandPath, JSON.stringify(decide(f.own, 'cli-self')));
    expect(await cli(f, ['approval', 'decide', '--input', commandPath])).toEqual({ exit: 1, code: 'APPROVAL_DENIED' });
    const pending = await library(f, `return (await sdk.configuredApproval(process.cwd(), 'inspect', { schemaVersion: 1, scopeId: 'proj', approvalId: ${JSON.stringify(f.own)} })).status;`);
    expect(pending).toBe('pending');
    // Another principal's request is approved by this bound principal.
    const other = await library(f, `return sdk.configuredApproval(process.cwd(), 'decide', ${JSON.stringify(decide(f.colleague, 'sdk-colleague'))});`);
    expect(other).toMatchObject({ status: 'decided', decision: { decision: 'allow', actor: actor } });
  });
  it('without a binding, with a missing bindings file or an unknown role, the same operations fail closed', async () => {
    const f = await fixture();
    await startTestRuntimeService(f.project, f.env);
    await writeFile(join(f.data, 'bindings.json'), JSON.stringify(bindings([{ issuer: actor.issuer, subject: 'someone-else' }])), { mode: 0o600 });
    expect(await cli(f, ['inventory', '--scope', 'proj'])).toEqual({ exit: 1, code: 'POLICY_DENIED' });
    expect(await library(f, "return sdk.inspectInventory(process.cwd(), { schemaVersion: 1, scopeId: 'proj' });")).toEqual({ code: 'POLICY_DENIED' });
    await rm(join(f.data, 'bindings.json'));
    expect(await cli(f, ['inventory', '--scope', 'proj'])).toEqual({ exit: 1, code: 'POLICY_UNAVAILABLE' });
    await writeFile(join(f.data, 'bindings.json'), JSON.stringify({ ...bindings(), bindings: [{ id: 'operators', principals: [actor], roles: ['admin'], scopes: ['proj'] }] }), { mode: 0o600 });
    expect(await library(f, `return sdk.configuredApproval(process.cwd(), 'decide', ${JSON.stringify(decide(f.colleague, 'unknown-role'))});`)).toEqual({ code: 'POLICY_UNAVAILABLE' });
  });
});
