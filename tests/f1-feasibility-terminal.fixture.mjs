import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { transformSync } from 'esbuild';

const modes = ['seed', 'connect', 'login', 'login-by-id', 'logout'];
const mode = process.argv[2], project = process.cwd(), base = dirname(project);
assert(modes.includes(mode) && project === join(base, 'project') && base.split('/').at(-1).startsWith('f1-terminal-'));
const home = join(base, 'home'), storeRoot = join(home, 'global');
const env = { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TERM: 'xterm-256color',
  LANG: 'C.UTF-8', DECKENT_GLOBAL_HOME: storeRoot, NO_COLOR: '1', NODE_ENV: 'production' };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);

// Load the pinned checkout's source in the PTY child without using or refreshing dist.
const source = new URL('../src/', import.meta.url);
const browser = new URL('adapters/core/provider-siwc/internal/browser.ts', source).href;
registerHooks({
  resolve(specifier, context, next) {
    const url = specifier.startsWith('#') ? new URL(specifier.slice(1), source)
      : specifier.startsWith('.') && context.parentURL?.startsWith('file:') ? new URL(specifier, context.parentURL) : null;
    if (url?.href.startsWith(source.href) && url.pathname.endsWith('.js')) {
      for (const extension of ['.ts', '.tsx']) {
        const candidate = new URL(url.href.replace(/\.js$/u, extension));
        if (candidate.href === browser) return { url: 'data:text/javascript,export async function siwcBrowserAuthorization(){console.log("FIXTURE_BROWSER_REACHED");throw new Error("blocked by fixture")}', shortCircuit: true };
        if (existsSync(candidate)) return next(candidate.href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(source.href) && /\.tsx?$/u.test(url)) {
      return { format: 'module', shortCircuit: true, source: transformSync(readFileSync(new URL(url), 'utf8'),
        { loader: url.endsWith('.tsx') ? 'tsx' : 'ts', jsx: 'automatic', target: 'esnext', format: 'esm', sourcemap: 'inline', sourcefile: new URL(url).pathname }).code };
    }
    return next(url, context);
  },
});

const device = mode === 'seed' ? 2049 : 2050, minor = mode === 'seed' ? 1 : 2;
const mounts = join(base, 'mountinfo'), disk = join(base, 'devices/ata-fixture/block/fixture-disk');
const keyPath = join(storeRoot, 'secrets.key'), envelopePath = join(storeRoot, 'secrets.sealed.json');
const bindingPath = join(storeRoot, 'personal-store-binding.v1.json');
const { lstat, statfs, open, realpath, readFile } = fs;
const member = path => path === keyPath || path === envelopePath;
const mounted = (path, info) => path === storeRoot || member(path) ? Object.assign(info, { dev: device }) : info;
let keyReads = 0, envelopeReads = 0, revocationRequests = 0;
fs.lstat = async (path, ...args) => {
  const info = await lstat(path, ...args);
  if (typeof info?.dev !== 'number') return info;
  if (path === '/' || path === '/tmp') return Object.assign(info, { uid: 0, mode: info.mode & ~0o022 });
  return mounted(path, info);
};
fs.statfs = (path, ...args) => path === storeRoot ? Promise.resolve({ type: 0xef53 }) : statfs(path, ...args);
fs.realpath = (path, ...args) => path === `/sys/dev/block/8:${minor}` ? realpath(disk, ...args) : realpath(path, ...args);
fs.readFile = (path, ...args) => path === '/etc/machine-id' ? Promise.resolve('123456789abcdef0123456789abcdef0\n') : readFile(path, ...args);
fs.open = async (path, ...args) => {
  const handle = await open(path === '/proc/self/mountinfo' ? mounts : path, ...args);
  if (member(path)) {
    const stat = handle.stat.bind(handle), read = handle.read.bind(handle), readAll = handle.readFile.bind(handle);
    handle.stat = async (...options) => mounted(path, await stat(...options));
    const count = () => { if (path === keyPath) keyReads++; else envelopeReads++; };
    handle.read = (...options) => { count(); return read(...options); };
    handle.readFile = (...options) => { count(); return readAll(...options); };
  }
  return handle;
};
syncBuiltinESMExports();
globalThis.fetch = async (_url, options) => {
  if (mode !== 'logout' || options?.method !== 'GET') throw new Error('Unexpected fixture network request');
  revocationRequests++;
  return new Response('', { status: 503 });
};

const { composeCore } = await import('#composition/core/root/index.js');
const { attestLocalInteractiveTerminal, installationSecretRoot, openConfiguredSecretStore, SIWC_PROTOCOL } = await import('#adapters/index.js');
const { resolveGlobalConfigPaths, formatHumanError, exitCodeFor } = await import('#platform/index.js');
const { withConfiguredSiwc } = await import('#composition/core/siwc/index.js');
const { loadConfiguredScopeContext, withScopeAudit } = await import('#composition/core/scoped-request/index.js');
composeCore();
assert.equal(installationSecretRoot(env), storeRoot);
assert.equal(await attestLocalInteractiveTerminal(), true, 'The action process must have a real controlling terminal');
const options = { env }, scopeId = 'scope-a', connectionId = 'a1000000-0000-4000-8000-000000000002';
const name = SIWC_PROTOCOL.connectionSecretPrefix + connectionId.replaceAll('-', '').toUpperCase();
await fs.writeFile(mounts, `41 40 8:${minor} / ${storeRoot} rw - ext4 /dev/fixture rw\n`);

if (mode === 'seed') {
  const { applyPolicyTemplateInstallation } = await import('#composition/core/installation/index.js');
  const { openConfiguredAttemptStore } = await import('./contracts/support/configured-open.ts');
  const configPath = resolveGlobalConfigPaths(env).platformPath;
  await fs.mkdir(dirname(configPath), { mode: 0o700, recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ secrets: { store: SIWC_PROTOCOL.encryptedStoreId },
    identity: { profile: { id: 'core:solo', version: 1 } } }), { mode: 0o600 });
  await fs.mkdir(join(disk, 'slaves'), { recursive: true });
  await fs.mkdir(join(disk, 'device'));
  await fs.symlink('/fixture/bus/scsi', join(disk, 'device/subsystem'));
  await applyPolicyTemplateInstallation(project, scopeId, options);
  (await openConfiguredAttemptStore(project, options)).store.close();
  const context = await loadConfiguredScopeContext(project, scopeId, options, 'write');
  await withScopeAudit(context, () => undefined);
  const owner = await withConfiguredSiwc(project, scopeId, options, 'connect', async (app, owner) => {
    assert.deepEqual(await app.list(), []);
    return owner;
  });
  const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
  const store = openConfiguredSecretStore(context.config, env);
  await store.set(name, JSON.stringify({ schemaVersion: 2, custody: { bindingId: binding.bindingId, generation: binding.generation },
    connectionId, owner, clientId: 'fixture-client', identity: { issuer: SIWC_PROTOCOL.issuer, subject: 'fixture-subject', email: null },
    generation: 4, planUseEnabled: true, state: 'connected', remoteRevocation: 'not-attempted',
    tokens: { accessToken: 'made-up-access', refreshToken: 'made-up-refresh', idToken: null, scopes: [SIWC_PROTOCOL.usagePermission],
      expiresAtMs: Date.now() + 60_000, earliestRefreshAtMs: null } }));
  const original = await withConfiguredSiwc(project, scopeId, options, 'inspect', app => app.inspect(connectionId));
  assert.equal(original.state, 'connected');
  console.log('FIXTURE_SEEDED_ATTESTED');
} else {
  const { modelsCommand } = await import('#surfaces/core/cli-models/index.js');
  const { executeConfiguredSiwc } = await import('#composition/core/model-connect/index.js');
  // Establish the starting refusal independently of the action under test.
  await assert.rejects(withConfiguredSiwc(project, scopeId, options, 'inspect', app => app.inspect(connectionId)),
    { code: 'SIWC_STORE_NOT_PERSONAL', reason: 'binding-changed' });
  assert.equal(keyReads + envelopeReads, 0);
  const connection = 'chatgpt-login';
  const args = ['models', mode === 'login-by-id' ? 'login' : mode, '--connection', connection, '--scope', scopeId,
    ...(mode === 'login-by-id' ? ['--connection-id', connectionId] : [])];
  try {
    process.exitCode = await modelsCommand(args, { root: project, env, locale: 'en', siwc: { connection, execute: executeConfiguredSiwc } }) ?? 0;
  } catch (error) {
    console.log(formatHumanError(error, { locale: 'en', env, isTTY: true }));
    console.log(`FIXTURE_REFUSAL ${error.code} ${error.params?.reason ?? '-'}`);
    process.exitCode = exitCodeFor(error);
  }
  console.log(`FIXTURE_EFFECTS ${keyReads} ${envelopeReads} ${revocationRequests}`);
}
