// pack-smoke (DEPS-DIST): installs a packed deckent tarball the way an air-gapped customer does (npm, --offline, EMPTY cache,
// --ignore-scripts) and drives the installed package through its real surfaces on one Node binary:
//   version  `deckent --version` (bin link, shebang, build identity next to the bundle)
//   mcp      `deckent-mcp` stdio: initialize + tools/list
//   client   `deckent mcp add --realm host` against the installed `deckent-mcp` (lazy MCP client SDK, cross-spawn, pinning)
//   runtime  `deckent runtime serve` → ready → `runtime describe` (N-API peer_credentials.node next to the bundle, SO_PEERCRED) → SIGTERM
//   terminal start contract: TTY `deckent` workline (lazy ink/react/yoga render: banner, Ready, composer placeholder, no line prompt; Ctrl+C
//            twice), piped `deckent terminal` typed refusal, line mode on a TTY (tr prompt) and piped (no prompt) — texts from the shipped catalogs
//   native   every shipped .node addon loads in this Node (Node-API: one binary serves Node 24 and 26)
//   lazy     the static import closure of `deckent` reaches no ink/react/yoga/MCP code, of `deckent-mcp` only the MCP server
//   imports  every shipped .js file names only node: builtins, relative files or the package's own #imports (nothing left to resolve)
//   types    (release gate, only with --types <typescript dir>[,<dir>…]) a consumer project using the SDK type-checks with skipLibCheck off,
//            NodeNext and Bundler resolution, per given TypeScript, with nothing but the installed package and @types/node on its path
// Usage: node scripts/pack-smoke.mjs <tarball> [--node /abs/node] [--root <installed package root>] [--types <ts dir>[,<ts dir>]]
//        [--types-root <dir holding @types/node>] [--keep] [--only a,b]
// Prints a JSON report; exit 1 when any check fails. Not part of verify (needs a packed tarball): run per supported Node before a release.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Typical SDK use by a zero-dependency consumer: values, derived zod types (must be real types, not `any`), a hand-written Standard Schema,
 * the i18n key union, errors — and the zod schema values removed from the entry (DEPS-SCHEMA C2-b) must stay absent. */
const TYPES_CONSUMER = `import * as deckent from 'deckent';
import { createRun, inspectRun, createDefaultConfig, validateConfig, getConfigFieldDefault, t, isStandardSchemaV1, validateStandardSchemaSync, DeckentError,
  type RunAdmission, type RunQuery, type DeckentConfig, type MessageKey, type StandardSchemaV1 } from 'deckent';

export const api: readonly string[] = Object.keys(deckent);
export const version: string = deckent.PACKAGE_VERSION;
const config: DeckentConfig = createDefaultConfig();
export const warnings: number = validateConfig(config).warnings.length;
export const schemaVersion: 3 = getConfigFieldDefault('schema_version');
// @ts-expect-error the default is the literal 3; an any from an unresolved zod type would make this line compile
export const notAny: 'x' = getConfigFieldDefault('schema_version');
const key: MessageKey = 'cli.agent.desc';
export const text: string = t(key);
// @ts-expect-error not a message key
export const badKey: MessageKey = 'no.such.key';
const positive: StandardSchemaV1<unknown, number> = { '~standard': { version: 1, vendor: 'consumer',
  validate: value => (typeof value === 'number' && value > 0 ? { value } : { issues: [{ message: 'not positive' }] }) } };
export const validated = isStandardSchemaV1(positive) ? validateStandardSchemaSync(positive, 3) : null;
export async function admit(root: string, admission: RunAdmission): Promise<readonly string[]> {
  const receipt = await createRun(root, admission);
  return receipt.admission.run.tasks.map(task => task.phase);
}
export const query = (root: string, input: RunQuery) => inspectRun(root, input);
export const describe = (error: unknown): string => (error instanceof DeckentError ? error.code : String(error));
// @ts-expect-error removed from the SDK entry (live zod schema values are Core-internal)
export const removed = deckent.CORE_SCHEMA;
`;

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(`--${name}`); return at > -1 ? args.splice(at, 2)[1] : undefined; };
const flag = name => { const at = args.indexOf(`--${name}`); if (at > -1) args.splice(at, 1); return at > -1; };
const node = resolve(option('node') ?? process.execPath), presetRoot = option('root'), typescript = option('types'), keep = flag('keep'), only = option('only')?.split(',');
const typesRoot = resolve(option('types-root') ?? join(dirname(dirname(fileURLToPath(import.meta.url))), 'node_modules/@types'));
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
  // npm bundled with this Node (nvm/official layout); otherwise the npm on PATH, which then runs on its own Node.
  const bundled = join(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js'), npm = existsSync(bundled) ? [node, bundled] : ['npm'];
  const started = performance.now();
  const install = spawnSync(npm[0], [...npm.slice(1), 'install', tarball, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(base, 'empty-cache')],
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

/** One pseudo-TTY session through util-linux `script`: each step waits until the (ANSI-stripped) output contains `wait`, then sends `send`
 * after `delayMs`. Resolves with the exit status, the stripped text and whether the time limit killed it. */
const ESC = String.fromCharCode(27), ANSI = new RegExp(`${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)|[()][0-9A-Za-z]|[=>])`, 'gu');
const plain = text => text.replace(ANSI, '').replace(/\r/gu, '');
function pty(command, cwd, steps, timeoutMs = 30_000) {
  return new Promise(done => {
    const child = spawn('script', ['-qfec', command, '/dev/null'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let raw = '', next = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => { raw += chunk;
      while (next < steps.length && plain(raw).includes(steps[next].wait)) { const step = steps[next++]; setTimeout(() => child.stdin.write(step.send), step.delayMs ?? 0); } });
    child.stdin.on('error', () => undefined);
    child.once('close', code => { clearTimeout(timer); done({ status: code, text: plain(raw), timedOut }); });
  });
}
async function terminalCheck() {
  // Terminal start contract (batch 16 workline composer; the line mode keeps its prompt). The expected words come from the installed package's
  // own message catalogs, so a wording change follows the catalog; what is asserted is which surface shows what:
  //   TTY `deckent`                 workline: banner, status `Ready`, composer placeholder — and no line-mode prompt; Ctrl+C twice exits 0
  //   piped `deckent terminal`      typed refusal TERMINAL_TTY_REQUIRED, exit 2 (the workline needs a terminal on both ends)
  //   TTY `terminal session --lang tr`  line mode: Turkish banner and `deckent› ` prompt; /exit closes with the closed line, exit 0
  //   piped `terminal session`      line mode without banner or prompt: /status answers, an unknown /command is reported, exit 0
  const catalog = locale => JSON.parse(readFileSync(join(root, 'dist/platform/core/i18n/locales', locale, 'cli.json'), 'utf8'));
  const en = catalog('en'), tr = catalog('tr'), words = key => key.split('{')[0].trim();
  const project = fixture('terminal-project', { terminal: { autostartService: false, scopeId: 'smoke' } });
  const cases = {}, verdict = (name, ok, detail) => { cases[name] = { ok, ...detail }; };
  // Whitespace-normalised: the workline wraps long lines at word boundaries to the pseudo-terminal width.
  const flat = text => text.replace(/\s+/gu, ' ');
  const expect = (text, wanted, unwanted = []) => ({ missing: wanted.filter(item => !flat(text).includes(flat(item))), unexpected: unwanted.filter(item => flat(text).includes(flat(item))) });

  const workline = await pty(bin('deckent'), project, [{ wait: en['terminal.workline.placeholder'], send: '\u0003', delayMs: 300 },
    { wait: en['terminal.workline.placeholder'], send: '\u0003', delayMs: 900 }]);
  const w = expect(workline.text, [en['terminal.workline.banner'], en['terminal.workline.statusReady'], en['terminal.workline.placeholder']], [en['terminal.session.prompt'].trim()]);
  verdict('worklineTty', workline.status === 0 && !workline.timedOut && !w.missing.length && !w.unexpected.length,
    { status: workline.status, timedOut: workline.timedOut, ...w, sample: workline.text.replace(/\s+/gu, ' ').slice(0, 300) });

  const refused = run([bin('deckent'), 'terminal'], { cwd: project, input: 'hello\n', timeout: 20_000 });
  verdict('worklinePiped', refused.status === 2 && refused.stderr.includes('[TERMINAL_TTY_REQUIRED]') && refused.stdout.trim() === '',
    { status: refused.status, stderr: refused.stderr.trim().slice(-300) });

  const session = await pty(`${bin('deckent')} terminal session --lang tr`, project, [{ wait: tr['terminal.session.prompt'].trimEnd(), send: '/exit\r', delayMs: 200 }]);
  const l = expect(session.text, [tr['terminal.session.banner'], tr['terminal.session.prompt'].trimEnd(), tr['terminal.session.closed']]);
  verdict('sessionTty', session.status === 0 && !session.timedOut && !l.missing.length,
    { status: session.status, timedOut: session.timedOut, ...l, sample: session.text.replace(/\s+/gu, ' ').slice(0, 300) });

  const piped = run([bin('deckent'), 'terminal', 'session'], { cwd: project, input: '/status\n/nope\n/exit\n', timeout: 20_000 });
  const p = expect(`${piped.stdout}${piped.stderr}`, [words(en['terminal.status.chat']), `${en['terminal.workline.unknownCommand']}: /nope`],
    [en['terminal.session.prompt'].trim(), en['terminal.session.banner'], en['terminal.session.closed']]);
  verdict('sessionPiped', piped.status === 0 && !p.missing.length && !p.unexpected.length, { status: piped.status, ...p, stderr: piped.stderr.trim().slice(-300) });

  record('terminal', Object.values(cases).every(item => item.ok), { cases });
}
if (want('terminal') && report.checks.install?.ok !== false) await terminalCheck();

if (want('native') && report.checks.install?.ok !== false) {
  const addons = [], find = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name);
    if (entry.isDirectory()) find(path); else if (entry.name.endsWith('.node')) addons.push(path); } };
  find(join(root, 'dist'));
  const loaded = addons.map(path => { const result = run([node, '-e', `const m = require(${JSON.stringify(path)}); process.stdout.write(Object.getOwnPropertyNames(m).sort().join(','))`], { cwd: base });
    return { path: path.slice(root.length + 1), status: result.status, exports: result.stdout, stderr: result.stderr.trim().slice(-300) }; });
  record('native', addons.length > 0 && loaded.every(item => item.status === 0 && item.exports.length > 0), { addons: loaded });
}

if (want('lazy') && report.checks.install?.ok !== false) {
  // Mirrors tests/contracts/composition/startup-graph.test.ts on the shipped files: esbuild marks every bundled module with a
  // `// node_modules/<pkg>/…` header, so a heavy package in the static closure of an entry means a lazy import() was lost.
  const imports = manifest.imports ?? {}, STATIC = /(?:^|[\n;])\s*(?:import|export)\b[^'";]*?\bfrom\s*["']([^"']+)["']|(?:^|[\n;])\s*import\s*["']([^"']+)["']/g;
  const target = (file, spec) => spec.startsWith('.') ? resolve(dirname(file), spec) : spec.startsWith('#')
    ? Object.entries(imports).map(([key, value]) => spec.startsWith(key.replace('*', '')) ? join(root, value.replace('*', spec.slice(key.length - 1))) : null).find(Boolean) : null;
  const reach = entry => { const seen = new Set(), stack = [entry], heavy = new Set();
    while (stack.length) { const file = stack.pop(); if (seen.has(file) || !file.endsWith('.js')) continue; seen.add(file);
      const code = readFileSync(file, 'utf8');
      for (const match of code.matchAll(/^\/\/ node_modules\/((?:@[^/]+\/)?[^/]+)\//gm)) if (['ink', 'react', 'react-reconciler', 'yoga-layout', '@modelcontextprotocol'].some(name => match[1] === name || match[1].startsWith(`${name}/`))) heavy.add(match[1]);
      for (const match of code.matchAll(STATIC)) { const next = target(file, match[1] ?? match[2]); if (next) stack.push(next); } }
    return { files: seen.size, heavy: [...heavy].sort() }; };
  const cli = reach(join(root, manifest.bin.deckent)), mcp = reach(join(root, manifest.bin['deckent-mcp']));
  record('lazy', cli.heavy.length === 0 && mcp.heavy.every(name => name.startsWith('@modelcontextprotocol/server') || name === '@modelcontextprotocol/core'),
    { cli, mcp });
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
  // Release gate (DEPS-TYPES): a library consumer type-checks with skipLibCheck OFF, for every given TypeScript (comma-separated package
  // dirs) × both consumer resolutions (NodeNext, Bundler). The consumer is the install project itself (node_modules holds only deckent) or,
  // with --root, a bare directory mapped onto the root; nothing that could hold zod/react/MCP types is on its resolution path. @types/node
  // (the only external types the package expects) comes from --types-root (default: this repository's node_modules/@types).
  const consumer = installDir ?? join(base, 'types-consumer'); mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, 'index.mts'), TYPES_CONSUMER);
  const modes = { nodenext: { module: 'NodeNext', moduleResolution: 'NodeNext' }, bundler: { module: 'ESNext', moduleResolution: 'Bundler' } };
  for (const dir of typescript.split(',').map(entry => resolve(entry))) {
    const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
    for (const [mode, resolution] of Object.entries(modes)) {
      const config = join(consumer, `tsconfig.${mode}.json`);
      writeFileSync(config, JSON.stringify({ compilerOptions: { ...resolution, target: 'ES2022', lib: ['ES2022'], strict: true, noEmit: true, skipLibCheck: false,
        resolveJsonModule: false, types: ['node'], typeRoots: [typesRoot], ...(installDir ? {} : { paths: { deckent: [join(root, 'dist/index.d.ts')] } }) }, files: ['index.mts'] }));
      const result = run([node, join(dir, 'bin/tsc'), '-p', config], { cwd: consumer, timeout: 300_000 });
      const errors = [...result.stdout.matchAll(/error (TS\d+): (.*)/g)].map(match => `${match[1]} ${match[2]}`);
      const unresolved = [...new Set(errors.map(text => /Cannot find module '([^']+)'/.exec(text)?.[1]).filter(Boolean))].sort();
      record(`types:${version}:${mode}`, result.status === 0, { status: result.status, errors: errors.length, unresolved, sample: errors.slice(0, 5) });
    }
  }
}

report.ok = Object.values(report.checks).every(check => check.ok);
report.workdir = keep ? base : null;
if (!keep) rmSync(base, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 1;
