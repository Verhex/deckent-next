import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearConfigCache, resolveGlobalConfigPaths } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { listIdentityProfiles } from '#composition/core/identity-profile/index.js';
import { main } from '#surfaces/index.js';
import { identityCommand } from '#surfaces/core/cli-identity/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

registerProviderConfig(); // the `terminal` and `identity` sections are registered by the composed entry

/*
 * C-MODELS (alpha.48, owner CLI review 2026-10-19 `identity`): the status in words (profile — or how to choose one —, people, roles), one
 * line per profile with its meaning (digests only with --verbose), a labelled choices table, "no profile selected" instead of
 * IDENTITY_PROFILE_INVALID, and arrow-key selection with a preview card before a distribution is applied. A card is simulated here.
 */
const card = vi.hoisted(() => ({ interactive: false, answers: [] as (string | null)[], asked: [] as CliCardRequest[] }));
vi.mock('#surfaces/core/cli-human/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('#surfaces/core/cli-human/index.js')>();
  return { ...real,
    cliMode: (context: Parameters<typeof real.cliMode>[0], json?: boolean) => card.interactive && !json ? { mode: 'interactive' as const, reason: 'tty' as const } : real.cliMode(context, json),
    askCliCard: async (request: CliCardRequest, io: Parameters<typeof real.askCliCard>[1]) => {
      if (!card.interactive) return real.askCliCard(request, io);
      card.asked.push(request); return card.answers.length ? card.answers.shift()! : null;
    } };
});
const roots: string[] = [];
beforeEach(() => { card.interactive = false; card.answers = []; card.asked = []; });
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function project(config: Record<string, unknown> = { terminal: { scopeId: 'live' } }, language = 'en') {
  const base = await mkdtemp(join(tmpdir(), 'deckent-cli-identity-')); roots.push(base);
  const home = join(base, 'home'), root = join(base, 'project');
  await mkdir(join(root, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(root, '.deckent', 'config.json'), JSON.stringify(config), { mode: 0o600 });
  return { root, env: { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', DECKENT_LANGUAGE: language, NO_COLOR: '1' } };
}
const capture = () => { const lines: string[] = []; return { text: () => lines.join(''), sink: { write: (text: string) => { lines.push(String(text)); return true; } } }; };
const listing = listIdentityProfiles([]);
const person = { id: 'os-1234', label: 'alperen@host', kind: 'human' as const, principal: { issuer: 'os', subject: '1000' } };
const choices = { schemaVersion: 1 as const, profiles: listing.profiles, principals: [person], scopeIds: ['live'],
  bindings: [{ id: 'owner', principals: [{ issuer: 'os', subject: '1000' }], roles: ['admin', 'operator'], scopes: { values: ['live'] } }] };
function host(f: Awaited<ReturnType<typeof project>>, calls: { kind: string; value: unknown }[] = []) {
  const out = capture(), err = capture();
  const context = { root: f.root, env: f.env, stdin: Object.assign(Readable.from([]), { isTTY: false }), stdout: out.sink, stderr: err.sink,
    configChoiceSources: () => ({ list: async () => [{ value: 'live' }] }),
    listIdentityProfiles: () => listing,
    listIdentityDistributionChoices: async (_root: string, scopeId: string) => { calls.push({ kind: 'choices', value: scopeId }); return choices; },
    previewIdentityProfile: async () => { calls.push({ kind: 'preview', value: null }); throw new Error('not reached'); },
    previewIdentityDistribution: async (_root: string, selection: unknown) => { calls.push({ kind: 'distribution-preview', value: selection });
      return { schemaVersion: 1, digest: 'e'.repeat(64), submission: { selection }, preview: { digest: 'f'.repeat(64), unaffectedBindings: 1, differences: [],
        pins: { policyRevision: 'p1', bindingsRevision: 'b1', registryVersion: 1 },
        draft: { profile: { id: 'core:team', version: 1 }, projectScopeIds: ['live'], addedBindings: [{}], removedBindings: [], addedRoles: [{}], currentSeparationOfDuties: [],
          futureProjects: { requested: false }, unresolvedRequirements: [], unsupportedHierarchyNodeIds: [] } } }; },
    applyIdentityDistribution: async (_root: string, submission: unknown, expect: string) => { calls.push({ kind: 'apply', value: { submission, expect } });
      return { schemaVersion: 1, profile: { id: 'core:team', version: 1 }, digest: expect, outcome: { status: 'committed' } }; } };
  return { out, err, calls, context: context as never };
}

it('profiles: one line per profile with its meaning, the selected profile (or how to choose one) first; digests only with --verbose (EN, TR)', async () => {
  const f = await project(), h = host(f);
  expect(await main(['identity', 'profiles'], h.context)).toBe(0);
  const text = h.out.text();
  expect(text).toMatch(/No identity profile is selected.*deckent config set identity\.profile/u);
  expect(text).toMatch(/Solo.*one person/u); expect(text).toMatch(/Team.*small team/u); expect(text).toMatch(/Enterprise/u); expect(text).toMatch(/Custom/u);
  expect(text).not.toMatch(/[0-9a-f]{64}/u);
  const verbose = host(f);
  expect(await main(['identity', 'profiles', '--verbose'], verbose.context)).toBe(0);
  expect(verbose.out.text()).toMatch(/[0-9a-f]{64}/u);
  const tr = host(await project(undefined, 'tr'));
  expect(await main(['identity', 'profiles'], tr.context)).toBe(0);
  expect(tr.out.text()).toMatch(/Kimlik profili seçilmemiş/u); expect(tr.out.text()).toMatch(/Bireysel.*tek kişi/u);
});

it('bare identity is a status: profile, people and roles in words; a selected profile is named', async () => {
  // The selection lives in the installation layer (the `identity` section refuses the project layer).
  const f = await project(), installation = resolveGlobalConfigPaths(f.env).platformPath;
  await mkdir(dirname(installation), { recursive: true }); await writeFile(installation, JSON.stringify({ identity: { profile: { id: 'core:team', version: 1 } } }), { mode: 0o600 });
  const h = host(f);
  await identityCommand(['identity'], h.context);
  const text = h.out.text();
  expect(text).toContain('scope: live (default)');
  expect(text).toMatch(/Profile: Team/u);
  expect(text).toMatch(/alperen@host/u);
  expect(text).toMatch(/admin, operator/u);
  expect(h.calls).toEqual([{ kind: 'choices', value: 'live' }]);
});

it('choices: a labelled table of profiles with their roles, people and scopes, never bare ids on unlabeled lines', async () => {
  const f = await project(), h = host(f);
  expect(await main(['identity', 'choices', '--scope', 'live'], h.context)).toBe(0);
  const text = h.out.text();
  expect(text).toMatch(/Profile\s+Roles/u); expect(text).toMatch(/Team\s+profile-reader, profile-contributor/u);
  expect(text).toMatch(/People/u); expect(text).toContain('alperen@host');
  expect(text).toMatch(/Scopes/u);
  expect(text).not.toMatch(/^core:team@1: /mu);
});

it('preview without a selected profile says so and how to select one (not IDENTITY_PROFILE_INVALID); nothing is previewed', async () => {
  const f = await project(), h = host(f);
  expect(await main(['identity', 'preview', '--scope', 'live'], h.context)).toBe(2);
  expect(h.err.text()).toContain('IDENTITY_PROFILE_NOT_SELECTED');
  expect(h.err.text()).toContain('deckent config set identity.profile');
  expect(h.err.text()).not.toContain('IDENTITY_PROFILE_INVALID');
  expect(h.calls).toEqual([]);
});

it('distribute on a terminal: arrow-key picks (profile, person, role, project), a preview card, then apply; cancel applies nothing', async () => {
  card.interactive = true; card.answers = ['core:team@1', 'os-1234', 'profile-contributor', 'live', 'apply'];
  const f = await project(), h = host(f);
  expect(await main(['identity', 'distribute', '--scope', 'live', '--apply'], h.context)).toBe(0);
  expect(card.asked).toHaveLength(5);
  expect(card.asked[4]!.body?.join('\n')).toMatch(/Proposed bindings/u);
  expect(h.calls.find(call => call.kind === 'distribution-preview')!.value).toMatchObject({ profile: { id: 'core:team', version: 1 }, scopeId: 'live',
    assignments: [{ principalId: 'os-1234', roleId: 'profile-contributor', scopeIds: ['live'] }] });
  expect(h.calls.find(call => call.kind === 'apply')!.value).toMatchObject({ expect: 'e'.repeat(64) });
  card.answers = ['core:team@1', 'os-1234', 'profile-contributor', 'live', 'cancel'];
  const cancelled = host(f);
  await main(['identity', 'distribute', '--scope', 'live', '--apply'], cancelled.context);
  expect(cancelled.calls.some(call => call.kind === 'apply')).toBe(false);
});
