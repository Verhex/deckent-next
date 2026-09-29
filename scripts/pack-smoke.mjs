// pack-smoke (DEPS-DIST): installs a packed deckent tarball the way an air-gapped customer does (npm, --offline, EMPTY cache,
// --ignore-scripts) and drives the installed package through its real surfaces on one Node binary:
//   version  `deckent --version` (bin link, shebang, build identity next to the bundle)
//   mcp      `deckent-mcp` stdio: initialize + tools/list
//   client   `deckent mcp add --realm host` against the installed `deckent-mcp` (lazy MCP client SDK, cross-spawn, pinning)
//   runtime  `deckent runtime serve` → ready → `runtime describe` (N-API peer_credentials.node next to the bundle, SO_PEERCRED) → SIGTERM
//   terminal `deckent terminal` in a pseudo-TTY (lazy ink/react/yoga render), quit with Ctrl+C twice
//   native   every shipped .node addon loads in this Node (Node-API: one binary serves Node 24 and 26)
//   imports  every shipped .js file names only node: builtins, relative files or the package's own #imports (nothing left to resolve)
//   types    (release gate, only with --types <typescript dir>) a consumer project type-checks `import * from 'deckent'` with
//            skipLibCheck off and nothing but the installed package and @types/node on its resolution path
// Usage: node scripts/pack-smoke.mjs <tarball> [--node /abs/node] [--root <installed package root>] [--types <typescript dir>] [--keep] [--only a,b]
// Prints a JSON report; exit 1 when any check fails. Not part of verify (needs a packed tarball): run per supported Node before a release.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(`--${name}`); return at > -1 ? args.splice(at, 2)[1] : undefined; };
const flag = name => { const at = args.indexOf(`--${name}`); if (at > -1) args.splice(at, 1); return at > -1; };
const node = resolve(option('node') ?? process.execPath), presetRoot = option('root'), typescript = option('types'), keep = flag('keep'), only = option('only')?.split(',');
const tarball = args[0] ? resolve(args[0]) : undefined;
if (!tarball && !presetRoot) { process.stderr.write('usage: pack-smoke.mjs <tarball> [--node /abs/node] [--root dir] [--keep] [--only checks]\n'); process.exit(2); }

const base = mkdtempSync(join(tmpdir(), 'deckent-pack-smoke-'));
const home = join(base, 'home'); mkdirSync(home, { mode: 0o700 });
const env = { PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: home, TERM: 'xterm-256color', LANG: 'C.UTF-8' };
const report = { node: spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout.trim(), tarball: tarball ?? null, checks: {} };
const record = (name, ok, detail) => { report.checks[name] = { ok, ...detail }; };
const want = name => !only || only.includes(name);

let root = presetRoot ? resolve(presetRoot) : null, installDir = null, bin = name => join(root, 'node_modules/.bin', name);
if (!root) {
  const project = join(base, 'install'); mkdirSync(project); writeFileSync(join(project, 'package.json'), '{"name":"smoke","version":"0.0.0","private":true}\n');
  const npm = join(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js');
  const started = performance.now();
  const install = spawnSync(node, [npm, 'install', tarball, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(base, 'empty-cache')],
    { cwd: project, env, encoding: 'utf8', timeout: 300_000 });
  record('install', install.status === 0, { ms: Math.round(performance.now() - started), status: install.status,
    installedPackages: existsSync(join(project, 'node_modules')) ? readdirSync(join(project, 'node_modules')).filter(name => !name.startsWith('.')) : [],
    ...(install.status === 0 ? {} : { stderr: install.stderr.slice(-1500) }) });
  installDir = project; root = join(project, 'node_modules/deckent'); bin = name => join(project, 'node_modules/.bin', name);
} else {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  bin = name => join(root, manifest.bin[name]);
}
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const run = (argv, options = {}) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 60_000, env, ...options });
const fixture = (name, config) => {
  const project = join(base, name); mkdirSync(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  if (config) writeFileSync(join(project, '.deckent/config.json'), JSON.stringify(config), { mode: 0o600 });
  return project;
};

if (want('version') && report.checks.install?.ok !== false) {
  const result = run([bin('deckent'), '--version'], { cwd: base });
  record('version', result.status === 0 && result.stdout.startsWith(`deckent v${manifest.version} `), { stdout: result.stdout.trim(), stderr: result.stderr.trim().slice(-600) });
}

const mcpInput = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pack-smoke', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }].map(line => JSON.stringify(line)).join('\n') + '\n';
let toolCount = null;
if (want('mcp') && report.checks.install?.ok !== false) {
  const project = fixture('mcp-project');
  const result = run([bin('deckent-mcp'), '--project', project], { cwd: project, input: mcpInput, timeout: 30_000 });
  const lines = result.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
  const init = lines.find(line => line.id === 1), list = lines.find(line => line.id === 2);
  toolCount = Array.isArray(list?.result?.tools) ? list.result.tools.length : null;
  record('mcp', init?.result?.serverInfo?.name === 'deckent' && init.result.serverInfo.version === manifest.version && toolCount > 0,
    { serverInfo: init?.result?.serverInfo ?? null, tools: toolCount, stderr: result.stderr.trim().slice(-600) });
}

if (want('client') && report.checks.install?.ok !== false) {
  const project = fixture('client-project');
  const result = run([bin('deckent'), 'mcp', 'add', '--yes', '--json', '--realm', 'host', 'self', '--', node, realpathSync(bin('deckent-mcp')), '--project', project],
    { cwd: project, timeout: 60_000 });
  let value = null; try { value = JSON.parse(result.stdout); } catch { /* reported below */ }
  record('client', result.status === 0 && value?.trust === 'trusted' && value.pinnedTools > 0 && (toolCount === null || value.pinnedTools === toolCount),
    { status: result.status, result: value, stderr: result.stderr.trim().slice(-600) });
}

async function runtimeCheck() {
  const project = fixture('runtime-project', { layout: { root: join(base, 'runtime-data') },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
    cancellationRuntime: { scopeIds: ['smoke-scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { identity: { scopeId: 'smoke-scope', serviceId: 'runtime' }, inputMaxBytes: 65536, responseMaxBytes: 65536, maxConnections: 8,
      maxConcurrentRequests: 4, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, responseTimeoutMs: 1000, shutdownGraceMs: 1000 } });
  const service = spawn(bin('deckent'), ['runtime', 'serve', '--json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; service.stdout.on('data', chunk => { stdout += chunk; }); service.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(done => service.once('close', (code, signal) => done({ code, signal })));
  const ready = await Promise.race([new Promise(done => { const poll = setInterval(() => { if (/"event":"ready"/.test(stdout)) { clearInterval(poll); done(true); } }, 50); exited.then(() => { clearInterval(poll); done(false); }); }),
    new Promise(done => setTimeout(() => done(false), 20_000))]);
  let described = null;
  if (ready) { const result = run([bin('deckent'), 'runtime', 'describe', '--json'], { cwd: project, timeout: 20_000 }); try { described = JSON.parse(result.stdout); } catch { described = { status: result.status, stderr: result.stderr.slice(-600) }; } }
  service.kill('SIGTERM');
  const end = await Promise.race([exited, new Promise(done => setTimeout(() => { service.kill('SIGKILL'); done({ code: null, signal: 'SIGKILL(timeout)' }); }, 10_000))]);
  record('runtime', ready && typeof described?.instanceId === 'string' && described.identity?.serviceId === 'runtime',
    { ready, instanceId: described?.instanceId ?? null, describe: typeof described?.instanceId === 'string' ? undefined : described, exit: end, stderr: stderr.trim().slice(-800) });
}
if (want('runtime') && report.checks.install?.ok !== false) await runtimeCheck();

if (want('terminal') && report.checks.install?.ok !== false) {
  const project = fixture('terminal-project', { terminal: { autostartService: false, scopeId: 'smoke' } });
  const script = spawnSync('/bin/sh', ['-c', `(sleep 4; printf '\\003'; sleep 1; printf '\\003') | script -qfec "${bin('deckent')} terminal" /dev/null`],
    { cwd: project, env, encoding: 'utf8', timeout: 30_000 });
  const text = script.stdout.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'gu'), ''); // strip ANSI CSI sequences
  record('terminal', script.status === 0 && text.includes('deckent>'), { status: script.status, sample: text.replace(/\s+/g, ' ').slice(0, 300) });
}

if (want('native') && report.checks.install?.ok !== false) {
  const addons = [], find = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name);
    if (entry.isDirectory()) find(path); else if (entry.name.endsWith('.node')) addons.push(path); } };
  find(join(root, 'dist'));
  const loaded = addons.map(path => { const result = run([node, '-e', `const m = require(${JSON.stringify(path)}); process.stdout.write(Object.getOwnPropertyNames(m).sort().join(','))`], { cwd: base });
    return { path: path.slice(root.length + 1), status: result.status, exports: result.stdout, stderr: result.stderr.trim().slice(-300) }; });
  record('native', addons.length > 0 && loaded.every(item => item.status === 0 && item.exports.length > 0), { addons: loaded });
}

if (want('imports') && report.checks.install?.ok !== false) {
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  const optional = new Set(['react-devtools-core', 'bufferutil', 'utf-8-validate']);
  const bare = new Map(), walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path); } else if (entry.name.endsWith('.js')) {
      const code = readFileSync(path, 'utf8');
      for (const match of code.matchAll(/(?:^|[\n;])\s*(?:import|export)\b[^'";]*?\bfrom\s*["']([^"']+)["']|(?:^|[\n;])\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = match[1] ?? match[2] ?? match[3];
        if (spec.startsWith('.') || spec.startsWith('#') || builtins.has(spec)) continue;
        bare.set(spec, [...(bare.get(spec) ?? []), path.slice(root.length + 1)]);
      } } } };
  walk(join(root, 'dist'));
  const unexpected = [...bare.keys()].filter(spec => !optional.has(spec));
  record('imports', unexpected.length === 0, { unexpected: Object.fromEntries(unexpected.map(spec => [spec, bare.get(spec).slice(0, 3)])),
    optionalExternal: [...bare.keys()].filter(spec => optional.has(spec)) });
}

if (typescript && report.checks.install?.ok !== false) {
  // The consumer is the install project itself (node_modules holds only deckent) or, with --root, a bare directory mapped onto the root;
  // nothing that could hold zod/react/MCP types is on its resolution path. @types/node comes from the given TypeScript's sibling tree.
  const consumer = installDir ?? join(base, 'types-consumer'); mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, 'index.ts'), "import * as deckent from 'deckent';\nexport const api: readonly string[] = Object.keys(deckent);\n");
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true,
    noEmit: true, skipLibCheck: false, resolveJsonModule: true, types: ['node'], typeRoots: [join(resolve(typescript), '../@types')],
    ...(installDir ? {} : { paths: { deckent: [join(root, 'dist/index.d.ts')] } }) }, files: ['index.ts'] }));
  const result = run([node, join(resolve(typescript), 'bin/tsc'), '-p', consumer], { cwd: consumer, timeout: 300_000 });
  const errors = [...result.stdout.matchAll(/error (TS\d+): (.*)/g)].map(match => `${match[1]} ${match[2]}`);
  const unresolved = [...new Set(errors.map(text => /Cannot find module '([^']+)'/.exec(text)?.[1]).filter(Boolean))].sort();
  record('types', result.status === 0, { status: result.status, errors: errors.length, unresolved, sample: errors.slice(0, 5) });
}

report.ok = Object.values(report.checks).every(check => check.ok);
report.workdir = keep ? base : null;
if (!keep) rmSync(base, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 1;
