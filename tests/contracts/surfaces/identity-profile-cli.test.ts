import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { main } from '#surfaces/core/cli/index.js';
import { listIdentityProfiles } from '#composition/core/identity-profile/index.js';
import { IdentityProfileApplication, IdentityProfileRegistry } from '#engine/index.js';
import { encodeIdentityProfile, resolvePolicyBindings } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
const ref = { id: 'core:custom', version: 1 };
it('lists custom namespace/version/digest packages from bounded stdin in both locales, without policy access', async () => {
  const definition = { ...new IdentityProfileRegistry().resolve(ref).definition, id: 'acme:local', labelKey: 'acme.local' };
  const packages = [{ schemaVersion: 1, namespace: 'acme', source: 'local-package', definition, digest: sha256(encodeIdentityProfile(definition)), labels: { en: 'Local profile', tr: 'Yerel profil' } }];
  for (const language of ['en', 'tr']) {
    let output = '';
    expect(await main(['identity', 'profiles', '--registry', '-', '--lang', language], { stdin: Readable.from([JSON.stringify(packages)]), listIdentityProfiles,
      stdout: { write: text => { output += text; } } })).toBe(0);
    expect(output).toContain(language === 'en' ? 'Local profile' : 'Yerel profil'); expect(output).toContain('acme:local@1'); expect(output).toContain(packages[0]!.digest);
  }
});
it('renders the same structured preview in EN/TR JSON and preserves typed namespace errors', async () => {
  const principal = { id: 'a', issuer: 'local', subject: '1', assurance: 'os-user' as const, scopeIds: ['s'] };
  const policy = resolvePolicyBindings({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [{ id: 'inspect', effect: 'allow', principals: 'all', scopes: ['s'], actions: ['inspect'], resource: { kind: 'scope', ids: ['s'] } }] }, null);
  const app = new IdentityProfileApplication(new IdentityProfileRegistry(), { async load() { return { companyId: 'default', principal, policy, projectScopeIds: ['s'] }; } });
  const results: unknown[] = [];
  for (const language of ['en', 'tr']) {
    let output = '';
    expect(await main(['identity', 'preview', '--profile', ref.id, '--scope', 's', '--json', '--lang', language], {
      previewIdentityProfile: async (_root, input) => app.preview(input), stdout: { write: text => { output += text; } },
    })).toBe(0); results.push(JSON.parse(output));
  }
  expect(results[0]).toEqual(results[1]);
  let error = '';
  expect(await main(['identity', 'profiles', '--registry', '-', '--json', '--lang', 'tr'], { listIdentityProfiles,
    stdin: Readable.from([JSON.stringify([{ schemaVersion: 999 }])]), stderr: { write: text => { error += text; } } })).toBe(2);
  expect(JSON.parse(error).code).toBe('IDENTITY_PROFILE_INVALID');
});
it('rejects duplicate flags, missing values, double stdin and malformed input instead of silently defaulting', async () => {
  for (const flags of [['--profile-version', '2'], ['--profile', 'core:solo', '--profile', 'core:team'], ['--profile', 'core:solo', '--scope'], ['--registry', '-', '--input', '-']]) {
    expect(await main(['identity', 'preview', '--scope', 's', ...flags], { stderr: { write() {} } })).toBe(2);
  }
});
