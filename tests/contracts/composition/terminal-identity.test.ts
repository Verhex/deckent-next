import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileInstallationIdentityStore, FileProjectIdentityStore, readLocalOsIdentity } from '#adapters/index.js';
import { clearConfigCache, ErrorRegistry, t } from '#platform/index.js';
import { main as composedMain } from '#composition/core/cli/index.js';
import { ensureConfiguredTerminalIdentity, loadConfiguredInstallationIdentity, loadConfiguredProjectIdentity } from '#composition/core/scoped-request/index.js';
import { main } from '#surfaces/index.js';
import { until } from '../support/workline-harness.js';
import { followLedgerSurface } from '#composition/core/monitor/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { machineBindingNotRunReason } from '../support/binding-capability.js';
const bindingNotRun = await machineBindingNotRunReason();

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-terminal-identity-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ terminal: { autostartService: false } }));
  const actor = readLocalOsIdentity();
  await writeFile(join(project, '.deckent/policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [],
    grants: [{ id: 'g', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: actor.issuer, subject: actor.subject }],
      resource: { kind: 'scope', ids: 'all' } }] }), { mode: 0o600 });
  const options = { env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'global') } };
  const paths = ['installation', 'project'].map(kind => join(project, `.deckent/${kind}-identity/identity.json`));
  return { root, project, options, paths };
}

describe.skipIf(process.platform !== 'linux')('terminal managed identity admission (Linux filesystem evidence)', () => {
  beforeEach(context => { if (bindingNotRun) context.skip(bindingNotRun); });
  it('creates both identities through write admission and retains the exact persisted values and bytes on reopen', async () => {
    const f = await fixture(), before = await readFile(join(f.project, '.deckent/config.json'));
    const ids = await ensureConfiguredTerminalIdentity(f.project, 's', f.options);
    const bytes = await Promise.all(f.paths.map(path => readFile(path)));
    expect(ids).toEqual({ installationId: JSON.parse(bytes[0]!.toString()).installationId, projectId: JSON.parse(bytes[1]!.toString()).projectId });
    expect(ids.installationId).toBeTruthy(); expect(ids.projectId).toBeTruthy();
    expect(await ensureConfiguredTerminalIdentity(f.project, 's', f.options)).toEqual(ids);
    expect(await Promise.all(f.paths.map(path => readFile(path)))).toEqual(bytes);
    expect(await readFile(join(f.project, '.deckent/config.json'))).toEqual(before);
    expect((await readdir(join(f.project, '.deckent'))).sort()).toEqual(['config.json', 'installation-identity', 'policy.json', 'project-identity']);
  });
  it.each(['scope', 'principal', 'policy'])('refuses missing %s authority before identity writes', async refusal => {
    const f = await fixture();
    if (refusal === 'principal') {
      const path = join(f.project, '.deckent/policy.json'), policy = JSON.parse(await readFile(path, 'utf8'));
      policy.grants[0].principals[0].subject = 'unrelated-principal'; await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
    }
    if (refusal === 'policy') await rm(join(f.project, '.deckent/policy.json'));
    const before = await readdir(join(f.project, '.deckent'));
    await expect(ensureConfiguredTerminalIdentity(f.project, refusal === 'scope' ? 'foreign' : 's', f.options))
      .rejects.toMatchObject({ code: refusal === 'policy' ? 'POLICY_UNAVAILABLE' : 'POLICY_DENIED' });
    expect(await readdir(join(f.project, '.deckent'))).toEqual(before);
  });
  it('refuses a relocated installation without rewriting copied identity bytes', async () => {
    const f = await fixture(); await ensureConfiguredTerminalIdentity(f.project, 's', f.options);
    const copy = join(f.root, 'copy'); await cp(f.project, copy, { recursive: true });
    const paths = f.paths.map(path => path.replace(f.project, copy)), bytes = await Promise.all(paths.map(path => readFile(path)));
    await expect(ensureConfiguredTerminalIdentity(copy, 's', f.options)).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(bytes);
  });
  it.each(['en', 'tr'])('wires real CLI composition: interactive session creates IDs before local /status (%s)', async lang => {
    const f = await fixture(), output: string[] = [];
    vi.spyOn(process, 'cwd').mockReturnValue(f.project);
    for (const [key, value] of Object.entries(f.options.env)) vi.stubEnv(key, value);
    const input = Object.assign(new PassThrough(), { isTTY: true }); input.write('/status\n/exit\n');
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as NodeJS.ReadStream);
    const screen = Object.assign(new Writable({ write(chunk, _encoding, done) { output.push(String(chunk)); done(); } }), { isTTY: true });
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(screen as NodeJS.WriteStream);
    vi.spyOn(process, 'stderr', 'get').mockReturnValue(screen as NodeJS.WriteStream);
    const code = await composedMain(['terminal', 'session', '--scope', 's', '--lang', lang]);
    input.destroy(); expect(code, output.join('')).toBe(0);
    for (const path of f.paths) {
      const record = JSON.parse(await readFile(path, 'utf8'));
      expect(output.join('')).toContain(record.installationId ?? record.projectId);
    }
  });
  it('reports not-initialized from a clean read, preserves denied authority, and follows after explicit identity admission', async () => {
    const f = await fixture(), path = join(f.project, '.deckent/policy.json');
    const policy = JSON.parse(await readFile(path, 'utf8'));
    policy.grants.push({ ...policy.grants[0], id: 'output', actions: ['read-output'], resource: { kind: 'attempt', ids: 'all' } });
    await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
    const before = await readdir(join(f.project, '.deckent'));
    const writes = vi.spyOn(FileInstallationIdentityStore.prototype, 'loadOrCreate'), projectWrites = vi.spyOn(FileProjectIdentityStore.prototype, 'loadOrCreate');
    const ready = vi.fn(), signal = new AbortController().signal;
    const first = followLedgerSurface(f.project, 's', f.options, signal, ready);
    expect((await first.next()).value).toEqual({ access: 'not-initialized', scopeId: 's', stopped: true });
    expect(await first.next()).toMatchObject({ done: true });
    expect(ready).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(projectWrites).not.toHaveBeenCalled();
    expect(await readdir(join(f.project, '.deckent'))).toEqual(before);
    for (const refusal of ['scope', 'principal', 'output']) {
      const deniedPolicy = structuredClone(policy);
      if (refusal === 'principal') for (const grant of deniedPolicy.grants) grant.principals[0].subject = 'foreign';
      if (refusal === 'output') deniedPolicy.grants.pop();
      await writeFile(path, JSON.stringify(deniedPolicy), { mode: 0o600 });
      const denied = followLedgerSurface(f.project, refusal === 'scope' ? 'foreign' : 's', f.options, signal);
      expect((await denied.next()).value).toMatchObject({ access: 'denied', stopped: true });
      expect(await denied.next()).toMatchObject({ done: true });
    }
    expect(await readdir(join(f.project, '.deckent'))).toEqual(before);
    await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
    await ensureConfiguredTerminalIdentity(f.project, 's', f.options);
    const store = await openConfiguredAttemptStore(f.project, f.options); store.store.close();
    const normal = followLedgerSurface(f.project, 's', f.options, signal);
    try {
      expect((await normal.next()).value).toMatchObject({ access: 'denied', kinds: ['approval'], stopped: false });
      expect((await normal.next()).value).toMatchObject({ control: 'start', scopeId: 's' });
    } finally { await normal.return(); }
    const copy = join(f.root, 'relocated'); await cp(f.project, copy, { recursive: true });
    const relocated = followLedgerSurface(copy, 's', f.options, signal);
    expect((await relocated.next()).value).toMatchObject({ access: 'denied', stopped: true }); await relocated.return();
    await writeFile(f.paths[0]!, '{');
    const corrupt = followLedgerSurface(f.project, 's', f.options, signal);
    expect((await corrupt.next()).value).toMatchObject({ access: 'denied', stopped: true }); await corrupt.return();
  });
  // B36 R6: a fresh project without a trusted policy still opens the interactive terminal (as before ID-1D); the refused write admission
  // creates no identity metadata and grants nothing — governed commands meet their own POLICY_UNAVAILABLE gate.
  it.each(['en', 'tr'] as const)('opens the interactive terminal with a no-policy warning and no identity metadata (%s)', async lang => {
    const f = await fixture(), output: string[] = [];
    await rm(join(f.project, '.deckent/policy.json'));
    vi.spyOn(process, 'cwd').mockReturnValue(f.project);
    for (const [key, value] of Object.entries(f.options.env)) vi.stubEnv(key, value);
    const input = Object.assign(new PassThrough(), { isTTY: true }); input.write('/status\n/exit\n');
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as NodeJS.ReadStream);
    const screen = Object.assign(new Writable({ write(chunk, _encoding, done) { output.push(String(chunk)); done(); } }), { isTTY: true });
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(screen as NodeJS.WriteStream);
    vi.spyOn(process, 'stderr', 'get').mockReturnValue(screen as NodeJS.WriteStream);
    const code = await composedMain(['terminal', 'session', '--scope', 's', '--lang', lang]);
    input.destroy(); expect(code, output.join('')).toBe(0);
    expect(output.join('')).toContain(t('terminal.admission.policyUnavailable', {}, lang));
    expect(await readdir(join(f.project, '.deckent'))).toEqual(['config.json']);
  });
});

it('refuses unsupported identity capability before policy or project metadata access on any platform', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-terminal-unsupported-')); roots.push(root);
  vi.spyOn(FileInstallationIdentityStore.prototype, 'read').mockResolvedValue({ status: 'unavailable', reason: 'unsupported', bindingCapability: 'unsupported' });
  const installation = vi.spyOn(FileInstallationIdentityStore.prototype, 'loadOrCreate'), project = vi.spyOn(FileProjectIdentityStore.prototype, 'read');
  await expect(ensureConfiguredTerminalIdentity(root, 's', { env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'global') } }))
    .rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_UNAVAILABLE' });
  expect(installation).not.toHaveBeenCalled(); expect(project).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
});

it.each(['en', 'tr'])('refuses unsupported/relocated interactive startup before service/history/session/model effects (%s)', async lang => {
  for (const code of ['INSTALLATION_IDENTITY_UNAVAILABLE', 'INSTALLATION_IDENTITY_RELOCATED'] as const) {
    for (const action of ['workline', 'session']) {
      const root = await mkdtemp(join(tmpdir(), 'deckent-terminal-refusal-')); roots.push(root);
      const output: string[] = [], sink = { isTTY: true, write: (value: string) => { output.push(value); } };
      const effect = vi.fn(), ensure = vi.fn(async () => { throw ErrorRegistry.createError(code); });
      expect(await main(['terminal', action, '--scope', 's', '--lang', lang], { root,
        env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'global') }, stdout: sink, stderr: sink,
        stdin: Object.assign(Readable.from([]), { isTTY: true }), ensureTerminalIdentity: ensure,
        completeTerminalChat: effect, ensureRuntimeService: effect, openTerminalHistory: effect, openTerminalSessions: effect })).toBe(78);
      expect(ensure).toHaveBeenCalledOnce(); expect(effect).not.toHaveBeenCalled();
      expect(output.join('')).toContain(code);
      expect(output.join('')).toContain(code === 'INSTALLATION_IDENTITY_RELOCATED' ? (lang === 'en' ? 'same installation' : 'aynı kurulum')
        : (lang === 'en' ? 'installation identity' : 'Kurulum kimliği'));
      expect(await readdir(root)).toEqual([]);
    }
  }
});

it('never calls the write port for status, help, non-TTY workline or piped /status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-terminal-read-')); roots.push(root);
  const ensure = vi.fn(), sink = { write() {} }, env = { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'global') };
  const context = { root, env, stdout: sink, stderr: sink, ensureTerminalIdentity: ensure,
    loadInstallationIdentity: loadConfiguredInstallationIdentity, loadProjectIdentity: loadConfiguredProjectIdentity, completeTerminalChat: vi.fn() };
  for (const args of [['terminal', 'status'], ['terminal', 'status', '--json'], ['terminal', '--help']]) expect(await main(args, context)).toBe(0);
  expect(await main(['terminal', 'workline', '--scope', 's'], { ...context, stdin: Object.assign(Readable.from([]), { isTTY: false }) })).toBe(2);
  expect(await main(['terminal', 'session', '--scope', 's'], { ...context, stdin: Object.assign(Readable.from(['/status\n', '/exit\n']), { isTTY: false }) })).toBe(0);
  expect(ensure).not.toHaveBeenCalled(); expect(context.completeTerminalChat).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
});


it.each(['en', 'tr'] as const)('renders each deferred admission reason through Workline opening notices (%s)', async lang => {
  const reasons = {
    POLICY_UNAVAILABLE: 'terminal.admission.policyUnavailable', POLICY_DENIED: 'terminal.admission.policyDenied',
    SCOPE_UNKNOWN: 'terminal.admission.scopeUnknown', ATTEMPT_STORE_VERSION: 'terminal.admission.ledgerUpgrade',
  } as const;
  for (const [code, key] of Object.entries(reasons)) {
    const root = await mkdtemp(join(tmpdir(), 'deckent-admission-notice-')); roots.push(root);
    let output = '';
    const screen = Object.assign(new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } }), { isTTY: true, columns: 240, rows: 60 });
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return input; }, ref() { return input; }, unref() { return input; } });
    const stop = new AbortController(), model = vi.fn();
    const run = main(['terminal', 'workline', '--scope', 's', '--lang', lang], {
      root, env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'global') }, initialize() {},
      stdout: screen as unknown as NodeJS.WriteStream, stderr: screen as unknown as NodeJS.WriteStream,
      stdin: input as unknown as NodeJS.ReadStream, signal: stop.signal,
      async ensureTerminalIdentity() { throw ErrorRegistry.createError(code); }, completeTerminalChat: model,
    });
    try {
      await until(() => output.includes(t(key, {}, lang)), `opening warning ${code}`);
      expect(output).not.toContain('{reason}');
      input.write('/exit\r'); expect(await run).toBe(0);
      expect(model).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
    } finally { stop.abort(); await run; input.destroy(); }
  }
});
