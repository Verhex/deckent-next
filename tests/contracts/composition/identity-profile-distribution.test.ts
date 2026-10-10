import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { readLocalOsIdentity } from '#adapters/index.js';
import { getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID } from '#domain/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { listConfiguredIdentityDistributionChoices, previewConfiguredIdentityDistribution, applyConfiguredIdentityDistribution } from '#composition/core/identity-profile/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { ensureConfiguredTerminalIdentity } from '#composition/core/scoped-request/index.js';
import { main } from '#surfaces/core/cli/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-identity-composed-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { mode: 0o700 });
  const env = { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), PATH: process.env.PATH, NO_COLOR: '1' };
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, storage: { sqlite: { journalMode: 'delete' } } }));
  const opened = await openConfiguredAttemptStore(root, { env }); opened.store.close();
  const identity = readLocalOsIdentity(), actor = { issuer: identity.issuer, subject: identity.subject };
  const policy = productResourcePath(opened.layout, 'policy'), bindings = productResourcePath(opened.layout, 'bindings');
  await writeFile(policy, JSON.stringify({ schemaVersion: 2, revision: 'p1', restrictions: [], separationOfDuties: [],
    roles: [{ id: INSTALLATION_OWNER_ROLE_ID, permissions: installationOwnerPermissions(getPolicyVocabulary().resources.map(item => item.kind)) }],
    grants: [{ id: 'observe-scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [actor], resource: { kind: 'scope', ids: ['s'] } }] }), { mode: 0o600 });
  await writeFile(bindings, JSON.stringify({ schemaVersion: 3, revision: 'b1', modes: [], bindings: [{ id: 'root', principals: [actor], roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' }] }), { mode: 0o600 });
  await ensureConfiguredTerminalIdentity(root, 's', { env });
  const host = { listIdentityDistributionChoices: listConfiguredIdentityDistributionChoices, previewIdentityDistribution: previewConfiguredIdentityDistribution,
    applyIdentityDistribution: applyConfiguredIdentityDistribution };
  const choices = await listConfiguredIdentityDistributionChoices(root, 's', { env });
  const selection = { schemaVersion: 1, profile: { id: 'core:team', version: 1 }, scopeId: 's',
    assignments: [{ principalId: choices.principals[0]!.id, roleId: 'profile-reader', scopeIds: ['s'] }], removeBindingIds: [] };
  const files = async () => ({ policy: await readFile(policy, 'utf8'), bindings: await readFile(bindings, 'utf8') });
  return { root, env, host, choices, selection, files, policy };
}
it.skipIf(process.platform !== 'linux')('real composition → CLI choices and EN/TR/JSON preview expose the same exact selection envelope without authority writes', async () => {
  const f = await fixture(), before = await f.files();
  expect(f.choices.principals).toHaveLength(1); expect(f.choices.principals[0]?.kind).toBe('human');
  const prepared = await previewConfiguredIdentityDistribution(f.root, f.selection, { env: f.env });
  for (const language of ['en', 'tr']) {
    let output = '', error = '';
    expect(await main(['identity', 'distribute', '--input', '-', '--json', '--lang', language], { root: f.root, env: f.env, ...f.host,
      stdin: Readable.from([JSON.stringify(f.selection)]), stdout: { write: text => { output += text; } }, stderr: { write: text => { error += text; } } })).toBe(0);
    expect(error).toBe(''); expect(JSON.parse(output)).toEqual(prepared);
    output = '';
    expect(await main(['identity', 'distribute', '--input', '-', '--lang', language], { root: f.root, env: f.env, ...f.host,
      stdin: Readable.from([JSON.stringify(f.selection)]), stdout: { write: text => { output += text; } } })).toBe(0);
    expect(output).toContain(language === 'en' ? 'Grants no authority' : 'Yetki vermez'); expect(output).toContain(prepared.digest);
  }
  let output = '';
  expect(await main(['identity', 'choices', '--scope', 's', '--json'], { root: f.root, env: f.env, ...f.host,
    stdout: { write: text => { output += text; } } })).toBe(0);
  expect(JSON.parse(output)).toEqual(f.choices); expect(await f.files()).toEqual(before);
});
it.skipIf(process.platform !== 'linux')('stale expect fails at read-only preflight; non-interactive apply cannot decide a profile approval', async () => {
  const f = await fixture(), prepared = await previewConfiguredIdentityDistribution(f.root, f.selection, { env: f.env }), before = await f.files();
  await expect(applyConfiguredIdentityDistribution(f.root, prepared.submission, '0'.repeat(64), { env: f.env })).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_CONFLICT' });
  await expect(applyConfiguredIdentityDistribution(f.root, prepared.submission, prepared.digest, { env: f.env })).rejects.toMatchObject({ code: 'APPROVAL_INTERACTIVE_REQUIRED' });
  expect(await f.files()).toEqual(before);
});
it('CLI rejects missing expect, handwritten fields and non-TTY text fallback before any writer call', async () => {
  let writes = 0;
  const host = { previewIdentityDistribution: async () => { throw new Error('must not preview'); },
    applyIdentityDistribution: async () => { writes++; throw new Error('must not apply'); } };
  for (const argv of [['identity', 'distribute', '--apply', '--input', '-'], ['identity', 'distribute', '--scope', 's'],
    ['identity', 'distribute', '--principal', 'owner'], ['identity', 'distribute', '--input', '-', '--expect', 'digest']]) {
    expect(await main(argv, { ...host, stdin: Readable.from([]), stderr: { write: () => undefined } })).not.toBe(0);
  }
  expect(writes).toBe(0);
});
