import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { terminalSecretGrantOffer } from '#composition/core/terminal-chat/index.js';
import { clearConfigCache, resolveGlobalConfigPaths } from '#platform/index.js';

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
