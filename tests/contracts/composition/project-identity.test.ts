import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLocalOsIdentity, type LocalPeerIdentity } from '#adapters/index.js';
import { clearConfigCache } from '#platform/index.js';
import { loadConfiguredInstallationIdentity, loadConfiguredProjectIdentity, loadConfiguredPeerScopeContext } from '#composition/core/scoped-request/index.js';
import { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import { main } from '#surfaces/index.js';
import { main as composedMain } from '#composition/core/cli/index.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-project-context-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(data, { mode: 0o700 });
  const config = join(project, '.deckent/config.json');
  await writeFile(config, JSON.stringify({ layout: { root: data }, company: { id: 'alpha' } }));
  const actor = readLocalOsIdentity();
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [],
    grants: [{ id: 'g', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: actor.issuer, subject: actor.subject }],
      resource: { kind: 'scope', ids: 'all' } }] }), { mode: 0o600 });
  const peer: LocalPeerIdentity = { pid: process.pid, uid: process.getuid!(), gid: process.getgid!(), assurance: 'linux-so-peercred' };
  return { root, project, data, config, peer, options: { env: { DECKENT_GLOBAL_HOME: join(root, 'global'), HOME: join(root, 'home') } } };
}

describe('installation and project identity composition', () => {
  beforeEach(context => { if (process.platform !== 'linux') context.skip('INSTALLATION_IDENTITY_UNSUPPORTED: POSIX identity persistence is unavailable; typed refusal has a separate active test'); });
  it('upgrades an existing project on first use without editing config or creating a ledger; alternate data roots share no project identity', async () => {
    const f = await fixture(); const before = await readFile(f.config, 'utf8');
    const identity = await loadConfiguredProjectIdentity(f.project, f.options);
    const installation = await loadConfiguredInstallationIdentity(f.project, f.options);
    expect(await loadConfiguredInstallationIdentity(f.project, f.options)).toEqual(installation);
    expect(await loadConfiguredProjectIdentity(f.project, f.options)).toEqual(identity);
    expect(await readFile(f.config, 'utf8')).toBe(before);
    await expect(stat(join(f.data, 'state/ledger.db'))).rejects.toMatchObject({ code: 'ENOENT' });
    const other = join(f.root, 'other'); await mkdir(join(other, '.deckent'), { recursive: true });
    await writeFile(join(other, '.deckent/config.json'), before);
    expect((await loadConfiguredProjectIdentity(other, f.options)).projectId).not.toBe(identity.projectId);
    expect(await loadConfiguredInstallationIdentity(other, f.options)).toEqual(installation);
    expect(JSON.parse(await readFile(join(f.data, 'installation-identity/identity.json'), 'utf8'))).toMatchObject({ schemaVersion: 2, installationId: installation.installationId });
    await expect(stat(join(f.project, '.deckent/installation-identity'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('carries the durable value through peer scope and invocation contexts without changing company or principal', async () => {
    const f = await fixture(); const identity = await loadConfiguredProjectIdentity(f.project, f.options);
    const scoped = await loadConfiguredPeerScopeContext(f.project, 's', f.options, f.peer, 'read');
    const invocation = await loadPeerInvocationContext(f.project, 's', f.options, f.peer, 'read');
    const installation = await loadConfiguredInstallationIdentity(f.project, f.options);
    expect(scoped.installationId).toBe(installation.installationId); expect(invocation.installationId).toBe(installation.installationId);
    expect(scoped.projectId).toBe(identity.projectId); expect(invocation.projectId).toBe(identity.projectId);
    expect(invocation.principal).toEqual(scoped.principal); expect(scoped.principal.scopeIds).toEqual(['s']);
    expect(scoped.config.company.id).toBe('alpha');
  });
  it('rejects an untrusted peer or undeclared scope before creating project metadata', async () => {
    const f = await fixture();
    await expect(loadConfiguredPeerScopeContext(f.project, 's', f.options, { ...f.peer, uid: f.peer.uid + 1 }, 'read'))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    await expect(loadConfiguredPeerScopeContext(f.project, 'foreign', f.options, f.peer, 'read')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(stat(join(f.project, '.deckent/project-identity'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(f.data, 'installation-identity'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('wires the real CLI composition to persistence without a runtime or provider call', async () => {
    const f = await fixture(); const output: string[] = [];
    vi.spyOn(process, 'cwd').mockReturnValue(f.project);
    for (const [key, value] of Object.entries(f.options.env)) vi.stubEnv(key, value);
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
    expect(await composedMain(['terminal', 'status', '--json'])).toBe(0);
    const json = JSON.parse(output.join(''));
    expect(json.projectId).toBe((await loadConfiguredProjectIdentity(f.project, f.options)).projectId);
    expect(json.installationId).toBe((await loadConfiguredInstallationIdentity(f.project, f.options)).installationId);
  });
  it.each(['en', 'tr'])('renders both durable identities in human, JSON and session status (%s)', async lang => {
    const f = await fixture(); const output: string[] = []; const sink = { write: (s: string) => { output.push(s); } };
    const context = { root: f.project, env: f.options.env, stdout: sink, stderr: sink, initialize() {}, loadProjectIdentity: loadConfiguredProjectIdentity,
      loadInstallationIdentity: loadConfiguredInstallationIdentity };
    expect(await main(['terminal', 'status', '--json', '--lang', lang], context)).toBe(0);
    const json = JSON.parse(output.join('')); const persisted = JSON.parse(await readFile(join(f.project, '.deckent/project-identity/identity.json'), 'utf8'));
    const installation = JSON.parse(await readFile(join(f.data, 'installation-identity/identity.json'), 'utf8'));
    expect(json.projectId).toBe(persisted.projectId); expect(json.installationId).toBe(installation.installationId); output.length = 0;
    expect(await main(['terminal', 'status', '--lang', lang], context)).toBe(0);
    expect(output.join('')).toContain(`${lang === 'en' ? 'Project identity' : 'Proje kimliği'}: ${persisted.projectId}`);
    expect(output.join('')).toContain(`${lang === 'en' ? 'Installation identity' : 'Kurulum kimliği'}: ${installation.installationId}`);
    const completeTerminalChat = vi.fn(async () => 'unused'); output.length = 0;
    expect(await main(['terminal', 'session', '--scope', 's', '--lang', lang], { ...context, completeTerminalChat,
      stdin: Object.assign(Readable.from(['/status\n', '/exit\n']), { isTTY: false }) })).toBe(0);
    expect(completeTerminalChat).not.toHaveBeenCalled();
    expect(output.join('')).toContain(installation.installationId); expect(output.join('')).toContain(persisted.projectId);
    await writeFile(join(f.project, '.deckent/project-identity/identity.json'), '{}'); output.length = 0;
    expect(await main(['terminal', 'status', '--json', '--lang', lang], context)).not.toBe(0);
    expect(output.join('')).toContain('PROJECT_IDENTITY_INVALID'); expect(output.join('')).not.toContain(persisted.projectId);
    await writeFile(join(f.project, '.deckent/project-identity/identity.json'), JSON.stringify(persisted));
    await writeFile(join(f.data, 'installation-identity/identity.json'), '{}'); output.length = 0;
    expect(await main(['terminal', 'status', '--json', '--lang', lang], context)).not.toBe(0);
    expect(output.join('')).toContain('INSTALLATION_IDENTITY_INVALID'); expect(output.join('')).not.toContain(installation.installationId);
  });
});

it('native Windows status reports typed identity refusal before persistence', async context => {
  if (process.platform !== 'win32') context.skip('NATIVE_WINDOWS_NOT_RUN: current host is not win32; unsupported layout refusal is tested separately');
  const root = await mkdtemp(join(tmpdir(), 'deckent-identity-unsupported-')); roots.push(root);
  const output: string[] = [], sink = { write: (value: string) => { output.push(value); } };
  const env = { DECKENT_GLOBAL_HOME: join(root, 'global'), HOME: join(root, 'home') };
  const cliContext = { root, env, stdout: sink, stderr: sink, initialize() {}, loadInstallationIdentity: loadConfiguredInstallationIdentity };
  expect(await main(['terminal', 'status', '--json'], cliContext)).not.toBe(0);
  expect(output.join('')).toContain('INSTALLATION_IDENTITY_UNSUPPORTED');
  await expect(stat(join(root, '.deckent/installation-identity'))).rejects.toMatchObject({ code: 'ENOENT' });
});
