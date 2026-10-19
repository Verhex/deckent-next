import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { clearConfigCache, ConfigValidationError, loadConfig, registerConfigSection, resolveGlobalConfigPaths, writeConfig } from '../../../src/platform/index.js';

// SEC-3 (Claude Security F33): a project `.deckent/config.json` is someone else's commit; it must never pull an installation secret
// with `$DECK:NAME`. Every case keeps the risky input and asserts the typed refusal before any resolver read.
const roots: string[] = [];
const FAKE_SECRET = 'ghp_fake-installation-secret-value';
const docker = { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}`, memoryBytes: 1, pids: 1, cpus: 1, logMaxSizeKiB: 1, logMaxFiles: 1,
  tmpBytes: 1, deadlineMs: 1, controlTimeoutMs: 1, outputBytes: 1 };
const execution = (authorName: string) => ({ docker, git: { gitExecutable: 'git', timeoutMs: 1,
  deliveryIdentity: { authorName, authorEmail: 'delivery@example.invalid' } } });
registerConfigSection('project_layer_allowed_probe', z.object({ token: z.string(), rows: z.array(z.object({ value: z.string() }).strict()).default([]) }).strict(),
  { metadata: { descriptionKey: 'config.section', tier: 'core', since: '1.0.0-alpha.1', binding: { state: 'bound', consumers: ['src/platform/core/config'] }, apply: 'live' }, optional: true });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-sec3-')); roots.push(root);
  const home = join(root, 'home'), project = join(root, 'project');
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') };
  const globalPath = resolveGlobalConfigPaths(env).platformPath, projectPath = join(project, '.deckent', 'config.json');
  await Promise.all([mkdir(dirname(globalPath), { recursive: true }), mkdir(dirname(projectPath), { recursive: true })]);
  let calls = 0;
  const secretResolver = async () => { calls++; return FAKE_SECRET; };
  return { env, globalPath, project, projectPath, secretResolver, calls: () => calls };
}
async function refusal(load: Promise<unknown>): Promise<ConfigValidationError> {
  try { await load; } catch (error) { expect(error).toBeInstanceOf(ConfigValidationError); return error as ConfigValidationError; }
  return expect.fail('the secret reference must be refused');
}
function expectContentFree(error: ConfigValidationError, ...names: string[]) {
  const text = `${error.message} ${JSON.stringify(error.issues)}`;
  for (const hidden of ['$DECK:', FAKE_SECRET, ...names]) expect(text).not.toContain(hidden);
}
afterEach(async () => {
  clearConfigCache();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('project config layer secret references (SEC-3, F33)', () => {
  it('refuses a project delivery identity that pulls an installation secret, before any resolver read', async () => {
    const f = await fixture();
    await writeFile(f.projectPath, JSON.stringify({ execution: execution('$DECK:GITHUB_TOKEN') }));
    const error = await refusal(loadConfig(f.project, { env: f.env, heal: false, secretResolver: f.secretResolver }));
    expect(error.issues).toEqual([{ path: 'execution', reason: 'SECRET_REFERENCE_PROJECT_LAYER' }]);
    expect(error.message).toContain('SECRET_REFERENCE_PROJECT_LAYER');
    expectContentFree(error, 'GITHUB_TOKEN');
    expect(f.calls()).toBe(0);
  });

  it('refuses a reference in any project field, nested in arrays and in sections that allow installation references', async () => {
    for (const authored of [{ projectName: '$DECK:PROJECT_NAME_SECRET' },
      { project_layer_allowed_probe: { token: 'clean', rows: [{ value: 'clean' }, { value: '$DECK:NESTED_SECRET' }] } }]) {
      const f = await fixture();
      await writeFile(f.projectPath, JSON.stringify(authored));
      const error = await refusal(loadConfig(f.project, { env: f.env, heal: false, secretResolver: f.secretResolver }));
      expect(error.issues).toEqual([{ path: Object.keys(authored)[0], reason: 'SECRET_REFERENCE_PROJECT_LAYER' }]);
      expectContentFree(error, 'PROJECT_NAME_SECRET', 'NESTED_SECRET');
      expect(f.calls()).toBe(0);
    }
  });

  it('refuses the project reference even when the installation layer sets the same field', async () => {
    const f = await fixture();
    await writeFile(f.globalPath, JSON.stringify({ projectName: 'installation-name' }));
    await writeFile(f.projectPath, JSON.stringify({ projectName: '$DECK:PROJECT_SECRET' }));
    const error = await refusal(loadConfig(f.project, { env: f.env, heal: false, secretResolver: f.secretResolver }));
    expect(error.issues).toEqual([{ path: 'projectName', reason: 'SECRET_REFERENCE_PROJECT_LAYER' }]);
    expect(f.calls()).toBe(0);
  });

  it('refuses a delivery identity reference in the installation layer too: the commit author leaves the host', async () => {
    const f = await fixture();
    await writeFile(f.globalPath, JSON.stringify({ execution: execution('$DECK:GITHUB_TOKEN') }));
    const error = await refusal(loadConfig(f.project, { env: f.env, heal: false, secretResolver: f.secretResolver }));
    expect(error.issues).toEqual([{ path: 'execution.git.deliveryIdentity', reason: 'SECRET_REFERENCE_LEAVES_HOST' }]);
    expectContentFree(error, 'GITHUB_TOKEN');
    expect(f.calls()).toBe(0);
  });

  it('refuses to write a delivery identity reference into either config file, leaving the file unchanged', async () => {
    const f = await fixture();
    for (const path of [f.globalPath, f.projectPath]) {
      await writeFile(path, '{}');
      const error = await refusal(writeConfig(path, { execution: execution('$DECK:GITHUB_TOKEN') }));
      expect(error.issues).toEqual([{ path: 'execution.git.deliveryIdentity', reason: 'SECRET_REFERENCE_LEAVES_HOST' }]);
      expectContentFree(error, 'GITHUB_TOKEN');
      expect(await readFile(path, 'utf8')).toBe('{}');
    }
  });

  it('still resolves installation-layer references outside host-leaving fields, and plain project text that only mentions $DECK:', async () => {
    const f = await fixture();
    await writeFile(f.globalPath, JSON.stringify({ projectName: '$DECK:INSTALLATION_NAME', project_layer_allowed_probe: { token: '$DECK:INSTALLATION_TOKEN' } }));
    await writeFile(f.projectPath, JSON.stringify({ execution: execution('Delivery bot, see $DECK:NOT_A_REFERENCE') }));
    const config = await loadConfig(f.project, { env: f.env, heal: false, secretResolver: f.secretResolver });
    expect(config.projectName).toBe(FAKE_SECRET);
    expect(config['project_layer_allowed_probe']).toEqual({ token: FAKE_SECRET, rows: [] });
    expect(config.execution?.git.deliveryIdentity?.authorName).toBe('Delivery bot, see $DECK:NOT_A_REFERENCE');
    expect(config.secretPaths).toEqual(['/projectName', '/project_layer_allowed_probe/token']);
  });
});
