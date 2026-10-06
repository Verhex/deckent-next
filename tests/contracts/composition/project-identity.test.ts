import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileInstallationIdentityStore, FileProjectIdentityStore, readLocalOsIdentity, type LocalPeerIdentity } from '#adapters/index.js';
import { clearConfigCache, resolveProductLayout } from '#platform/index.js';
import { loadConfiguredInstallationIdentity, loadConfiguredProjectIdentity, loadConfiguredPeerScopeContext } from '#composition/core/scoped-request/index.js';
import { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import { main } from '#surfaces/index.js';
import { main as composedMain } from '#composition/core/cli/index.js';
import { installationBindingNotRunReason } from '../support/binding-capability.js';
const bindingNotRun = await installationBindingNotRunReason();

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

async function createIdentities(f: Awaited<ReturnType<typeof fixture>>) {
  const installation = await new FileInstallationIdentityStore(resolveProductLayout({ projectRoot: f.project, root: f.data })).loadOrCreate();
  const project = await new FileProjectIdentityStore(f.project).loadOrCreate();
  return { installation, project };
}
function available<T>(read: { status: 'available'; value: T } | { status: 'unavailable'; reason: string }): T {
  expect(read.status).toBe('available');
  if (read.status !== 'available') throw new Error('IDENTITY_NOT_CREATED');
  return read.value;
}

describe('installation and project identity composition', () => {
  beforeEach(context => { if (process.platform !== 'linux') context.skip('Linux peer identity fixture; portable read/status tests run separately'); else if (bindingNotRun) context.skip(bindingNotRun); });
  it('reads identities created by explicit initialization without editing config or creating a ledger; alternate data roots share no project identity', async () => {
    const f = await fixture(); const before = await readFile(f.config, 'utf8');
    await createIdentities(f); const identity = available(await loadConfiguredProjectIdentity(f.project, f.options));
    const installation = available(await loadConfiguredInstallationIdentity(f.project, f.options));
    expect(available(await loadConfiguredInstallationIdentity(f.project, f.options))).toEqual(installation);
    expect(available(await loadConfiguredProjectIdentity(f.project, f.options))).toEqual(identity);
    expect(await readFile(f.config, 'utf8')).toBe(before);
    await expect(stat(join(f.data, 'state/ledger.db'))).rejects.toMatchObject({ code: 'ENOENT' });
    const other = join(f.root, 'other'); await mkdir(join(other, '.deckent'), { recursive: true });
    await writeFile(join(other, '.deckent/config.json'), before);
    await new FileProjectIdentityStore(other).loadOrCreate();
    expect(available(await loadConfiguredProjectIdentity(other, f.options)).projectId).not.toBe(identity.projectId);
    expect(available(await loadConfiguredInstallationIdentity(other, f.options))).toEqual(installation);
    expect(JSON.parse(await readFile(join(f.data, 'installation-identity/identity.json'), 'utf8'))).toMatchObject({ schemaVersion: 2, installationId: installation.installationId });
    await expect(stat(join(f.project, '.deckent/installation-identity'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('carries the durable value through peer scope and invocation contexts without changing company or principal', async () => {
    const f = await fixture(); await createIdentities(f); const identity = available(await loadConfiguredProjectIdentity(f.project, f.options));
    const scoped = await loadConfiguredPeerScopeContext(f.project, 's', f.options, f.peer, 'read');
    const invocation = await loadPeerInvocationContext(f.project, 's', f.options, f.peer, 'read');
    const installation = available(await loadConfiguredInstallationIdentity(f.project, f.options));
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
    const f = await fixture(); await createIdentities(f); const output: string[] = [];
    vi.spyOn(process, 'cwd').mockReturnValue(f.project);
    for (const [key, value] of Object.entries(f.options.env)) vi.stubEnv(key, value);
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
    expect(await composedMain(['terminal', 'status', '--json'])).toBe(0);
    const json = JSON.parse(output.join(''));
    expect(json.projectId).toBe(available(await loadConfiguredProjectIdentity(f.project, f.options)).projectId);
    expect(json.installationId).toBe(available(await loadConfiguredInstallationIdentity(f.project, f.options)).installationId);
  });
  it.each(['en', 'tr'])('renders both durable identities in human, JSON and session status (%s)', async lang => {
    const f = await fixture(); await createIdentities(f); const output: string[] = []; const sink = { write: (s: string) => { output.push(s); } };
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

it('native Windows status reports unavailable capability without failing or persisting', async context => {
  if (process.platform !== 'win32') context.skip('NATIVE_WINDOWS_NOT_RUN: current host is not win32; unsupported layout refusal is tested separately');
  const root = await mkdtemp(join(tmpdir(), 'deckent-identity-unsupported-')); roots.push(root);
  const output: string[] = [], sink = { write: (value: string) => { output.push(value); } };
  const env = { DECKENT_GLOBAL_HOME: join(root, 'global'), HOME: join(root, 'home') };
  const cliContext = { root, env, stdout: sink, stderr: sink, initialize() {}, loadInstallationIdentity: loadConfiguredInstallationIdentity };
  expect(await main(['terminal', 'status', '--json'], cliContext)).toBe(0);
  expect(JSON.parse(output.join('')).identity.installation).toEqual({ status: 'unavailable', reason: 'unsupported', bindingCapability: 'unsupported' });
  await expect(stat(join(root, '.deckent/installation-identity'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['en', 'tr'])('fresh terminal status/session remain filesystem-effect free and carry an explicit reason (%s)', async lang => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-identity-readonly-')); roots.push(root);
  const output: string[] = [], sink = { write: (value: string) => { output.push(value); } };
  const env = { DECKENT_GLOBAL_HOME: join(root, 'global'), HOME: join(root, 'home') };
  const context = { root, env, stdout: sink, stderr: sink, initialize() {}, loadInstallationIdentity: loadConfiguredInstallationIdentity,
    loadProjectIdentity: loadConfiguredProjectIdentity, completeTerminalChat: vi.fn(async () => 'unused') };
  expect(await main(['terminal', 'status', '--json', '--lang', lang], context)).toBe(0);
  const reason = process.platform === 'win32' ? 'unsupported' : 'not-created';
  expect(JSON.parse(output.join(''))).toMatchObject({ installationId: null, projectId: null, identity: {
    installation: { status: 'unavailable', reason }, project: { status: 'unavailable', reason } } });
  output.length = 0;
  expect(await main(['terminal', 'status', '--lang', lang], context)).toBe(0);
  if (process.platform !== 'win32') expect(output.join('')).toContain(lang === 'en' ? 'unavailable (not yet created)' : 'kullanılamıyor (henüz oluşturulmadı)');
  output.length = 0;
  expect(await main(['terminal', 'session', '--scope', 's', '--lang', lang], { ...context,
    stdin: Object.assign(Readable.from(['/status\n', '/exit\n']), { isTTY: false }) })).toBe(0);
  expect(context.completeTerminalChat).not.toHaveBeenCalled();
  const { readdir } = await import('node:fs/promises');
  expect(await readdir(root)).toEqual([]);
});

it.skipIf(process.platform !== 'linux')('peer read admission stays absent; first managed write creates both IDs and later reads retain their bytes', async () => {
  const f = await fixture();
  const observed = await loadConfiguredPeerScopeContext(f.project, 's', f.options, f.peer, 'read');
  expect(observed).toMatchObject({ projectId: null, installationId: null, identity: {
    project: { status: 'unavailable', reason: 'not-created' }, installation: { status: 'unavailable', reason: 'not-created' } } });
  const projectPath = join(f.project, '.deckent/project-identity/identity.json'), installationPath = join(f.data, 'installation-identity/identity.json');
  await expect(stat(projectPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(installationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  const written = await loadConfiguredPeerScopeContext(f.project, 's', f.options, f.peer, 'write');
  expect(written.projectId).toBeTruthy(); expect(written.installationId).toBeTruthy();
  const before = await Promise.all([projectPath, installationPath].map(path => readFile(path)));
  const again = await loadConfiguredPeerScopeContext(f.project, 's', f.options, f.peer, 'read');
  expect(again.identity).toEqual(written.identity);
  expect(await Promise.all([projectPath, installationPath].map(path => readFile(path)))).toEqual(before);
});

it.skipIf(process.platform !== 'linux')('session status observes identities created by the first managed write after terminal startup', async () => {
  const f = await fixture(), output: string[] = [], sink = { write: (value: string) => { output.push(value); } };
  let created: Awaited<ReturnType<typeof loadConfiguredPeerScopeContext>> | undefined;
  const context = { root: f.project, env: f.options.env, stdout: sink, stderr: sink, initialize() {},
    loadInstallationIdentity: loadConfiguredInstallationIdentity, loadProjectIdentity: loadConfiguredProjectIdentity,
    completeTerminalChat: async () => {
      created = await loadConfiguredPeerScopeContext(f.project, 's', f.options, f.peer, 'write'); return 'fixture write';
    }, stdin: Object.assign(Readable.from(['/status\n', 'write\n', '/status\n', '/exit\n']), { isTTY: false }) };
  expect(await main(['terminal', 'session', '--scope', 's', '--lang', 'en'], context)).toBe(0);
  expect(output.join('')).toContain('unavailable (not yet created)');
  expect(created?.installationId).toBeTruthy(); expect(created?.projectId).toBeTruthy();
  expect(output.join('')).toContain(created!.installationId); expect(output.join('')).toContain(created!.projectId);
});
