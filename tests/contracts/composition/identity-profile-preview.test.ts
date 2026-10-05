import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { readLocalOsIdentity } from '#adapters/index.js';
import { clearConfigCache } from '#platform/index.js';
import { previewConfiguredIdentityProfile, listIdentityProfiles } from '#composition/core/identity-profile/index.js';
import { main } from '#surfaces/core/cli/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(existingLedger = false) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-identity-preview-')); roots.push(root);
  const data = join(root, 'data'), home = join(root, 'home');
  await mkdir(join(root, '.deckent'), { mode: 0o700 }); await mkdir(data, { mode: 0o700 }); await mkdir(home);
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH, NO_COLOR: '1', DECKENT_LANG: 'en' };
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { sqlite: { journalMode: 'delete' } } }));
  if (existingLedger) { const opened = await openConfiguredAttemptStore(root, { env }); opened.store.close(); }
  const actor = readLocalOsIdentity();
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 2, revision: 'policy-before', roles: [], restrictions: [], separationOfDuties: [],
    grants: [{ id: 'scope-inspect', effect: 'allow', scopes: ['scope'], actions: ['inspect'], principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind: 'scope', ids: ['scope'] } }] }), { mode: 0o600 });
  await writeFile(join(data, 'bindings.json'), JSON.stringify({ schemaVersion: 3, revision: 'bindings-before', bindings: [], modes: [] }), { mode: 0o600 });
  return { root, data, env };
}
async function tree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(dir: string, prefix: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`, path = join(dir, entry.name);
      if (entry.isDirectory()) { files[`${relative}/`] = ''; await walk(path, `${relative}/`); }
      else files[relative] = (await readFile(path)).toString('base64');
    }
  }
  await walk(root, ''); return files;
}
const body = { members: [{ id: 'teammate', label: 'Teammate', kind: 'human', principal: { issuer: 'test-idp', subject: 'member' } }], organization: [],
  assignments: [{ id: 'draft-binding', memberId: 'teammate', roleId: 'profile-reader', scopeIds: ['scope'] }], removeBindingIds: [], includeFutureProjects: true };
const input = { schemaVersion: 1, profile: { id: 'core:team', version: 1 }, scopeId: 'scope', ...body };
it.each([false, true])('real producer → CLI EN/TR/JSON leaves the entire installation byte-identical (existing ledger %s)', async existingLedger => {
  const f = await fixture(existingLedger), before = await tree(f.root);
  for (const language of ['en', 'tr']) {
    let output = '', error = '';
    const code = await main(['identity', 'preview', '--profile', 'core:team', '--scope', 'scope', '--input', '-', '--lang', language], {
      ...f, stdin: Readable.from([JSON.stringify(body)]), stdout: { write: text => { output += text; } }, stderr: { write: text => { error += text; } },
      previewIdentityProfile: previewConfiguredIdentityProfile, listIdentityProfiles,
    });
    expect({ code, error }).toEqual({ code: 0, error: '' });
    expect(output).toContain(language === 'en' ? 'Grants no authority' : 'Yetki vermez');
    expect(output).toContain(language === 'en' ? 'Gain' : 'Kazanım');
    expect(output).toContain(language === 'en' ? 'NOT applied' : 'UYGULANMADI');
  }
  let output = '';
  expect(await main(['identity', 'preview', '--profile', 'core:team', '--scope', 'scope', '--input', '-', '--json'], { ...f,
    stdin: Readable.from([JSON.stringify(body)]), stdout: { write: text => { output += text; } }, previewIdentityProfile: previewConfiguredIdentityProfile })).toBe(0);
  const result = JSON.parse(output);
  expect(result.pins).toMatchObject({ policyRevision: 'policy-before', bindingsRevision: 'bindings-before' });
  expect(result.draft).toMatchObject({ grantsAuthority: false, canApply: false, futureProjects: { requested: true, applied: false } });
  expect(await tree(f.root)).toEqual(before);
});
it('invalid namespace, stale version, foreign scopes and absent authority never create policy, identity, bindings or ledger', async () => {
  const f = await fixture(), before = await tree(f.root);
  for (const [profile, code] of [[{ id: 'absent:team', version: 1 }, 'IDENTITY_PROFILE_NAMESPACE_UNKNOWN'], [{ id: 'core:team', version: 10 }, 'IDENTITY_PROFILE_VERSION_UNKNOWN']] as const) {
    await expect(previewConfiguredIdentityProfile(f.root, { ...input, profile }, [], { env: f.env })).rejects.toMatchObject({ code });
  }
  await expect(previewConfiguredIdentityProfile(f.root, { ...input, projectScopeIds: ['scope', 'foreign'] }, [], { env: f.env })).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_SCOPE_DENIED' });
  expect(await tree(f.root)).toEqual(before);
  await rm(join(f.data, 'policy.json')); const missing = await tree(f.root);
  await expect(previewConfiguredIdentityProfile(f.root, input, [], { env: f.env })).rejects.toBeDefined();
  expect(await tree(f.root)).toEqual(missing);
});
it('lists metadata without loading policy or bootstrapping an installation and keeps help inert', async () => {
  const f = await fixture(); await rm(join(f.data, 'policy.json')); const before = await tree(f.root);
  for (const language of ['en', 'tr']) {
    let output = '';
    expect(await main(['identity', 'profiles', '--lang', language], { ...f, listIdentityProfiles, stdout: { write: text => { output += text; } } })).toBe(0);
    expect(output).toContain('core:solo'); expect(output).toContain(language === 'en' ? 'Team' : 'Ekip');
    expect(await main(['identity', 'preview', '--help', '--lang', language], { ...f, initialize: () => { throw new Error('help initialized'); }, stdout: { write() {} } })).toBe(0);
  }
  expect(await tree(f.root)).toEqual(before);
});
it('rejects extra authority fields and deployment flags at the CLI without invoking the application', async () => {
  let calls = 0;
  const context = { stdin: Readable.from([JSON.stringify({ ...body, policy: { grants: 'all' } })]), stderr: { write() {} },
    previewIdentityProfile: async () => { calls++; throw new Error('must not run'); } };
  expect(await main(['identity', 'preview', '--profile', 'core:team', '--scope', 'scope', '--input', '-', '--json'], context)).toBe(2);
  expect(await main(['identity', 'preview', '--profile', 'core:team', '--scope', 'scope', '--apply'], context)).toBe(2);
  expect(calls).toBe(0);
});
it('consumes installation profile selection, refuses project overrides and leaves custom selections as unapplied data', async () => {
  const f = await fixture(), global = join(f.root, 'global'); await mkdir(global);
  const env = { ...f.env, DECKENT_GLOBAL_HOME: global };
  await writeFile(join(global, 'config.json'), JSON.stringify({ identity: { profile: { id: 'core:team', version: 1 } } }));
  const before = await tree(f.root); let output = '';
  expect(await main(['identity', 'preview', '--scope', 'scope', '--input', '-', '--json'], { ...f, env,
    stdin: Readable.from([JSON.stringify(body)]), stdout: { write: text => { output += text; } }, previewIdentityProfile: previewConfiguredIdentityProfile })).toBe(0);
  expect(JSON.parse(output).draft.profile).toMatchObject({ id: 'core:team', version: 1 });
  expect(await tree(f.root)).toEqual(before);
  await writeFile(join(f.root, '.deckent/config.json'), JSON.stringify({ layout: { root: f.data }, identity: { profile: { id: 'core:solo', version: 1 } } }));
  await expect(previewConfiguredIdentityProfile(f.root, input, [], { env })).rejects.toMatchObject({ code: 'CONFIG_VALIDATION' });
});
