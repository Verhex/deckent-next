import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { terminalSecretGrantOffer } from '#composition/core/terminal-chat/index.js';
import { connectProvider, type ProviderSecretHost } from '#composition/core/model-connect/index.js';
import { clearConfigCache, ErrorRegistry, resolveGlobalConfigPaths } from '#platform/index.js';

// PRE-8 first-use card (owner decisions 2026-10-21): only a solo installation's attested human terminal is offered the card; a team or
// enterprise selection, or a process without its own controlling terminal (a pipe, an agent's shell), gets the refusal and its command only.
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function installation(identity?: { id: string; version: number }) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-grant-offer-')); roots.push(root);
  const home = join(root, 'home'), projectRoot = join(root, 'project');
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') };
  const global = resolveGlobalConfigPaths(env).platformPath;
  await Promise.all([mkdir(dirname(global), { recursive: true }), mkdir(join(projectRoot, '.deckent'), { recursive: true })]);
  if (identity) await writeFile(global, JSON.stringify({ identity: { profile: identity } }));
  return { projectRoot, options: { env } };
}
const human = async () => true, notHuman = async () => false;

describe('terminalSecretGrantOffer', () => {
  it('offers the card on a solo installation (selected or none selected) only at an attested human terminal', async () => {
    const solo = await installation({ id: 'core:solo', version: 1 });
    expect(await terminalSecretGrantOffer(solo.projectRoot, solo.options, human)).toBe(true);
    expect(await terminalSecretGrantOffer(solo.projectRoot, solo.options, notHuman)).toBe(false);
    const unselected = await installation();
    expect(await terminalSecretGrantOffer(unselected.projectRoot, unselected.options, human)).toBe(true);
  });
  it('never offers it on a team or enterprise selection: the admin grants there', async () => {
    for (const id of ['core:team', 'core:enterprise']) {
      const team = await installation({ id, version: 1 });
      expect(await terminalSecretGrantOffer(team.projectRoot, team.options, human)).toBe(false);
    }
  });
  it('this test process has no controlling terminal of its own: the real attestation refuses (pipe or agent shell)', async () => {
    const solo = await installation({ id: 'core:solo', version: 1 });
    expect(await terminalSecretGrantOffer(solo.projectRoot, solo.options)).toBe(false);
  });
});

it('U1 custody → key → card grant: refusal never advances; a failed/closed grant keeps the stored key', async () => {
  const solo = await installation({ id: 'core:solo', version: 1 }), team = await installation({ id: 'core:team', version: 1 });
  const calls: string[] = [], name = 'SYNTHETIC_PROVIDER_KEY', value = 'synthetic-only-never-returned', backend = 'core.secret-store.encrypted-file@1';
  let custody = false, set = true, grant = false, root = solo;
  const host: ProviderSecretHost = {
    prepare: async () => { calls.push('custody'); return custody ? { state: 'ready', backend } : { state: 'refused', backend: null, code: 'SECRET_STORE_UNSAFE' }; },
    set: async () => { calls.push('set'); if (!set) throw ErrorRegistry.createError('SECRET_STORE_READ_ONLY'); return { backend }; },
    offer: async () => { calls.push('offer'); return terminalSecretGrantOffer(root.projectRoot, root.options, human); },
    grant: async () => { calls.push('grant'); if (!grant) throw ErrorRegistry.createError('SECRET_CHANGE_DENIED'); },
  };
  const run = () => connectProvider(root.projectRoot, { scopeId: 'scope', name, value, grant: true }, root.options, host);
  expect(await run()).toMatchObject({ custody: { state: 'refused', code: 'SECRET_STORE_UNSAFE' }, key: { state: 'skipped' }, grant: { state: 'skipped' } });
  expect(calls.splice(0)).toEqual(['custody']);
  custody = true; set = false;
  expect(await run()).toMatchObject({ key: { state: 'refused', code: 'SECRET_STORE_READ_ONLY' }, grant: { state: 'skipped' } });
  expect(calls.splice(0)).toEqual(['custody', 'set']);
  set = true;
  expect(await run()).toMatchObject({ key: { state: 'stored' }, grant: { state: 'refused', code: 'SECRET_CHANGE_DENIED' } });
  expect(calls.splice(0)).toEqual(['custody', 'set', 'offer', 'grant']);
  root = team;
  expect(await run()).toMatchObject({ key: { state: 'stored' }, grant: { state: 'admin', code: 'SECRET_GRANT_REQUIRED' } });
  expect(calls.splice(0)).toEqual(['custody', 'set', 'offer']);
  root = solo; grant = true;
  const connected = await run();
  expect(connected).toMatchObject({ key: { state: 'stored' }, grant: { state: 'granted' } });
  expect(calls).toEqual(['custody', 'set', 'offer', 'grant']);
  expect(JSON.stringify(connected)).not.toContain(value);
});
