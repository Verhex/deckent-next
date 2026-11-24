import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeNativeCodingRegistry, configureNativeCodingTemplate } from '#composition/core/native-coding/index.js';
import { configureNativeTemplate, initializeNativeRegistry, type NativeTemplatePorts } from '#engine/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { NATIVE_NODE_DEPENDENCY_LAYOUT } from '#domain/index.js';
import { reviewSealedWorkerTree } from '#adapters/core/worker-tree-gate/index.js';
import { withMcpPrincipal } from '#adapters/index.js';
import { clearConfigCache, EMPTY_KNOWN_SECRETS } from '#platform/index.js';
import { main } from '#surfaces/core/cli/index.js';
import { personEnv } from '../support/person-env.js';

/**
 * alpha.55.1 (same class as functest B P1): `deckent init registry --apply` and `deckent coding template --apply` write the protected
 * `admission` root on a person's behalf, so they need the same person terminal witness as `config set`: the composed writer asks it
 * (assertConfigPersonWitness) before the write, the CLI refuses the AI marker, a pipe and `--json` before anything. `--preview` stays open.
 */
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const docker = { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}`, memoryBytes: 268435456, cpus: 1, pids: 64,
  logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const registry = { schemaVersion: 1, scopeId: 's', provider: 'codex', kind: 'feature', poolId: 'customer', executionSlots: 3, inFlightSlots: 5, discovery: 'repository' };
const detect = async () => 'codex-cli 0.159.2';
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'native-template-witness-')); roots.push(root);
  await applyPolicyTemplateInstallation(root, 's');
  const path = join(root, '.deckent/config.json'), options = { env: { DECKENT_GLOBAL_HOME: join(root, 'global') } };
  const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  config['terminal'] = { ...(config['terminal'] as object), scopeId: 's' }; config['execution'] = { docker, git: { gitExecutable: 'git', timeoutMs: 5000 } };
  await writeFile(path, JSON.stringify(config)); clearConfigCache();
  return { root, path, options };
}
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; params?: Record<string, unknown> }) => error);
const witness = (value: boolean) => ({ attest: async () => value });

describe.skipIf(process.platform === 'win32')('native registry and template writes of `admission` need the person terminal witness', () => {
  it('init registry --apply: refused without the witness and for the MCP actor, nothing written; the witnessed person applies it', async () => {
    const f = await setup(), before = await readFile(f.path, 'utf8');
    expect(await refusal(initializeNativeCodingRegistry(f.root, { ...registry, apply: true }, f.options, { detect, witness: witness(false) })))
      .toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED', params: { operation: 'config set admission' } });
    const probe = vi.fn(detect); // the discovery probe starts a container: a refused MCP apply never reaches it
    expect(await refusal(withMcpPrincipal(() => initializeNativeCodingRegistry(f.root, { ...registry, apply: true }, f.options, { detect: probe, witness: witness(true) }))))
      .toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' }); expect(probe).not.toHaveBeenCalled();
    expect(await readFile(f.path, 'utf8')).toBe(before);
    expect((await initializeNativeCodingRegistry(f.root, { ...registry, apply: false }, f.options, { detect, witness: witness(false) })).status).toBe('preview');
    expect((await initializeNativeCodingRegistry(f.root, { ...registry, apply: true }, f.options, { detect, witness: witness(true) })).status).toBe('applied');
  });
  it('coding template --apply: refused without the witness, nothing written; the witnessed person applies it', async () => {
    const f = await setup();
    await initializeNativeCodingRegistry(f.root, { ...registry, apply: true }, f.options, { detect, witness: witness(true) });
    const before = await readFile(f.path, 'utf8'), request = { provider: 'codex', kind: 'review', apply: true };
    expect(await refusal(configureNativeCodingTemplate(f.root, request, f.options, { witness: witness(false) })))
      .toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED', params: { operation: 'config set admission.registry' } });
    expect(await readFile(f.path, 'utf8')).toBe(before);
    expect((await configureNativeCodingTemplate(f.root, { ...request, apply: false }, f.options, { witness: witness(false) })).status).toBe('preview');
    expect((await configureNativeCodingTemplate(f.root, request, f.options, { witness: witness(true) })).status).toBe('applied');
  });
  it('Astra 2752: a missing or refusing witness stops an apply before any snapshot, discovery, principal, writer or beforeWrite', async () => {
    for (const refuse of [undefined, async (operation: string) => { throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation } }); }]) {
      const untouched = () => vi.fn(() => { throw new Error('must not run before the witness'); });
      const ports = { snapshot: untouched(), principal: untouched(), writer: untouched(), template: untouched(), detect: untouched(), beforeWrite: untouched(),
        ...(refuse ? { witness: refuse } : {}) };
      for (const apply of [() => initializeNativeRegistry({ ...registry, apply: true }, ports as unknown as NativeTemplatePorts),
        () => configureNativeTemplate({ provider: 'codex', kind: 'review', apply: true }, ports as unknown as NativeTemplatePorts)])
        expect(await refusal(apply())).toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
      for (const port of Object.values(ports)) if (vi.isMockFunction(port)) expect(port).not.toHaveBeenCalled();
    }
  });
  it('the CLI refuses --apply under the AI marker, through a pipe and with --json before the handler runs; --preview stays open', async () => {
    const handlers = { initializeNativeCodingRegistry: vi.fn(async () => { throw new Error('must not run'); }), configureCodingTemplate: vi.fn(async () => { throw new Error('must not run'); }) };
    const commands = [['init', 'registry', '--scope', 's', '--provider', 'codex', '--kind', 'feature', '--pool', 'p', '--execution-slots', '1', '--in-flight-slots', '1', '--apply'],
      ['coding', 'template', '--provider', 'codex', '--kind', 'feature', '--apply']];
    const term = { TERM: 'xterm-256color', HOME: tmpdir() };
    const ios = [{ env: { ...term, CLAUDECODE: '1' }, tty: true, json: false }, { env: term, tty: false, json: false }, { env: term, tty: true, json: true }];
    for (const argv of commands) for (const io of ios) {
      let error = '';
      const context = { root: '/tmp/native-template-witness', env: io.env, stdin: { isTTY: io.tty }, stdout: { isTTY: io.tty, write: () => true },
        stderr: { write: (chunk: string) => { error += chunk; return true; } }, ...handlers };
      expect(await main([...argv, ...(io.json ? ['--json'] : [])], context as never), `${argv.join(' ')} ${JSON.stringify(io)}`).not.toBe(0);
      expect(error).toContain('AUTHORITY_WITNESS_REQUIRED');
    }
    expect(handlers.initializeNativeCodingRegistry).not.toHaveBeenCalled(); expect(handlers.configureCodingTemplate).not.toHaveBeenCalled();
  });
  it('renders the declared mount and approval route in English and Turkish with the ordinary template command', async () => {
    const f = await setup(), env = personEnv({ ...f.options.env, TERM: 'xterm-256color' });
    const configureCodingTemplate = vi.fn(async () => ({ status: 'preview', profile: { id: 'pkg-template', version: 1,
      adapter: { id: 'native-coding-template', version: 3 }, parameters: { dependencyLayout: 'node-npm' } },
      kind: { kind: 'coding' }, registry: { revision: 'r' }, expect: null, write: null }));
    for (const [lang, text] of [['en', 'Read-only mount at ./node_modules in the worker checkout'], ['tr', 'İşçi çalışma kopyasında ./node_modules salt okunur bağlanır']]) {
      let shown = '';
      const code = await main(['coding', 'template', '--provider', 'codex', '--kind', 'coding', '--connection', 'selected', '--node-dependencies', '--preview', '--lang', lang],
        { root: f.root, env, stdout: { isTTY: false, write: (chunk: string) => { shown += chunk; return true; } }, configureCodingTemplate } as never);
      expect(code).toBe(0); expect(shown).toContain(text); expect(shown).toContain('--inspect-dependencies');
      expect(configureCodingTemplate).toHaveBeenLastCalledWith(f.root, expect.objectContaining({ nodeDependencies: true, apply: false }), expect.any(Object));
    }
  });
  it.skipIf(process.platform !== 'linux')('renders every pattern rule in the native list preview without the synthetic matched text', async () => {
    const f = await setup(), source = join(f.root, 'node_modules'), pkg = join(source, 'example');
    await mkdir(source); await mkdir(pkg);
    const value = 'fixture-person:fixture-preview-value';
    await writeFile(join(pkg, 'check.js'), `https://${value}@example.invalid\n-----BEGIN PRIVATE KEY-----`);
    const review = await reviewSealedWorkerTree(source, 'node_modules',
      { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 4096, timeoutMs: 20_000, allowPatternPaths: [], acknowledgedDenyPaths: [] }, EMPTY_KNOWN_SECRETS);
    const inspectCodingDependencies = async () => ({ kind: 'prepared', project: f.root, workTarget: f.root, platform: 'linux-x64',
      layout: NATIVE_NODE_DEPENDENCY_LAYOUT, listDigest: review.digest, lockfileDigest: 'a'.repeat(64), manifest: review.manifest });
    const produceCodingDependencies = vi.fn(async () => ({ ...await inspectCodingDependencies(), written: NATIVE_NODE_DEPENDENCY_LAYOUT.fileList }));
    const configureCodingTemplate = () => { throw Error('inspection cannot apply the template'); };
    for (const [lang, warning] of [['en', 'You may decline.'], ['tr', 'Onayı reddedebilirsiniz.']]) {
      async function command(args: string[]) {
        let shown = '';
        const code = await main(['coding', 'template', ...args, '--scope', 's', '--lang', lang],
          { root: f.root, env: f.options.env, stdout: { isTTY: false, write: (chunk: string) => { shown += chunk; return true; } },
            configureCodingTemplate, inspectCodingDependencies, produceCodingDependencies } as never);
        expect(code).toBe(0);
        expect(shown).toContain(warning);
        expect(shown).toContain('example/check.js · pattern:private-key-block');
        expect(shown).toContain('example/check.js · pattern:url-userinfo');
        expect(shown).not.toContain(value);
        expect(shown).not.toContain('-----BEGIN PRIVATE KEY-----');
        return shown;
      }
      await command(['--inspect-dependencies']);
      const shown = await command(['--produce-dependencies', '--npm-cache', '/fixture/npm-cache']);
      expect(produceCodingDependencies).toHaveBeenLastCalledWith(f.root, 's', expect.any(Object), '/fixture/npm-cache');
      expect(shown).toContain(NATIVE_NODE_DEPENDENCY_LAYOUT.fileList);
    }
  });
});
