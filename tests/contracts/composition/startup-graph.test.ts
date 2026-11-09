import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SERVER_INFO_META_KEY } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { dist, HOST_GRAPH, staticReach } from '../../fixtures/static-graph.js';

// Every deckent process (CLI, runtime service, SDK consumers, workers) pays for what its entry imports STATICALLY, because ESM evaluates the
// whole static graph before the first line runs. Measured 2026-09-28 on this repo: `ink` ~167 ms, the MCP server SDK ~105 ms, of a ~470 ms
// `deckent --version` (STARTUP-COST). Lazy `import()` edges are the sanctioned way to keep a heavy module off the startup path, so this
// walk follows static edges only (the sibling sdk-import-graph test deliberately follows both).
// Packages whose import cost is large enough that a process must opt in (dynamic import) rather than inherit them.
const INK = ['ink', 'react'], SERVER = ['@modelcontextprotocol/server'], XTERM = ['@xterm/headless', '@xterm/addon-unicode11'];
const HEAVY = [...INK, ...SERVER, '@modelcontextprotocol/client', ...XTERM];
// The load budget of every entry and every lazy target of the CLI start path: [heavy packages it loads by design, today's offenders].
// The offender column is a ratchet (KG9 F1): BARREL (Ink in text families) and later cards shrink it, and it ends empty.
const LOAD_BUDGET: Readonly<Record<string, readonly [byDesign: readonly string[], today: readonly string[]]>> = {
  'index.js': [[], []], 'extensions.js': [[], []], 'composition/core/mcp/internal/entry.js': [SERVER, []], 'adapters/core/beuser-surface/internal/pty.js': [XTERM, []],
  ...Object.fromEntries(['entry', 'cli-main', 'host', 'git-tracked', 'model-help'].map(name => [`composition/core/cli/internal/${name}.js`, [[], []]])),
  ...Object.fromEntries(['query-errors', 'scoped-request', 'model-connect'].map(unit => [`composition/core/${unit}/index.js`, [[], []]])),
  'surfaces/core/mcp/index.js': [SERVER, []], 'surfaces/core/hub-mcp/index.js': [SERVER, []],
  ...Object.fromEntries(['terminal', 'terminal-work', 'terminal-ledger', 'setup'].map(unit => [`surfaces/core/${unit}/index.js`, [INK, []]])),
  'surfaces/core/cli/internal/terminal.js': [INK, []], 'surfaces/core/cli/internal/launch-shell.js': [INK, []],
  ...Object.fromEntries(['terminal-turn', 'cli-models', 'cli-beuser', 'cli-approval', 'cli-identity', 'monitor', 'cli-decision', 'cli-memory', 'cli-agents', 'cli-task']
    .map(unit => [`surfaces/core/${unit}/index.js`, [[], []]])),
  ...Object.fromEntries(['cli-observe', 'cli-admin', 'cli-run', 'cli-installation', 'config', 'cli-hub'].map(unit => [`surfaces/core/${unit}/index.js`, [[], INK]])),
  'surfaces/core/cli/internal/mcp.js': [[], INK], 'surfaces/core/cli/internal/setup-offer.js': [[], INK], 'surfaces/core/terminal-labels/index.js': [[], ['react']],
};

it.each(Object.entries(LOAD_BUDGET))('%s statically reaches exactly its budgeted heavy packages', async (entry, [byDesign, today]) => {
  const { packages } = await staticReach(resolve(dist, entry));
  const reached = HEAVY.filter(name => packages.has(name));
  expect(reached.filter(name => byDesign.includes(name)), 'by design').toEqual(HEAVY.filter(name => byDesign.includes(name)));
  expect(reached.filter(name => !byDesign.includes(name)), reached.map(name => `${name} <- ${packages.get(name)}`).join(', ')).toEqual(HEAVY.filter(name => today.includes(name)));
});

it('the inlined server-info meta key equals the SDK constant it replaces', async () => {
  for (const file of ['surfaces/core/mcp/internal/delivery.js', 'adapters/core/mcp-transport/internal/delivery.js']) {
    expect(await readFile(resolve(dist, file), 'utf8')).toContain(`const SERVER_INFO_META_KEY = '${SERVER_INFO_META_KEY}';`);
  }
});


it.each([['--version'], ['--help'], ['operation', '--help'], ['--help', '--all', '--lang', 'tr'], ['no-such-command']].map(argv => [argv.join(' '), argv] as const))('`deckent %s` loads none of the host graph at run time', async (_label, argv) => {
  const entry = resolve(dist, 'composition/core/cli/internal/entry.js');
  await access(entry).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const root = await mkdtemp(join(tmpdir(), 'deckent-coldstart-'));
  try {
    const hook = join(root, 'trace.mjs'), out = join(root, 'loaded.txt');
    await writeFile(hook, "import { registerHooks } from 'node:module'; import { writeFileSync } from 'node:fs'; const urls = [];\n"
      + "registerHooks({ load(url, context, next) { urls.push(url); return next(url, context); } });\n"
      + 'process.on(\'exit\', () => writeFileSync(process.env.TRACE_OUT, urls.join(\'\\n\')));\n');
    const run = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, entry, ...argv], { cwd: root, encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', HOME: root, TRACE_OUT: out } });
    expect(run.status).toBe(argv[0] === 'no-such-command' ? 2 : 0);
    const loaded = new Set((await readFile(out, 'utf8')).split('\n'));
    expect(HOST_GRAPH.filter(path => loaded.has(pathToFileURL(resolve(dist, path)).href))).toEqual([]);
    expect(loaded.has(pathToFileURL(entry).href)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// KUR-55: `deckent … | head` closes the reader; the CLI ends quietly with the SIGPIPE code, never an EPIPE stack trace.
it('a closed stdout reader ends the CLI quietly with 141', async () => {
  const entry = resolve(dist, 'composition/core/cli/internal/entry.js');
  await access(entry).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const child = spawn(process.execPath, [entry, '--help', '--all'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env['PATH'] ?? '', HOME: tmpdir() } });
  child.stdout.destroy();
  let stderr = ''; child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>(done => child.on('close', done));
  expect({ code, stderr }).toEqual({ code: 141, stderr: '' });
});

// A lazy edge fails only when its command runs, so every `import()` target of the CLI start path must load from the build (the names are
// pinned by the type checker through `lazyFunction`) and has a LOAD_BUDGET row (a new family is weighed, not only loaded).
it('every lazy edge of the CLI start path loads from the build and has a load budget', async () => {
  const sources = ['composition/core/cli/internal/entry.js', 'composition/core/cli/internal/cli-main.js', 'surfaces/index.js', 'surfaces/core/cli/internal/entry.js', 'surfaces/core/cli/internal/kernel-commands.js'];
  const targets = new Set<string>();
  for (const source of sources) {
    for (const match of (await readFile(resolve(dist, source), 'utf8')).matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const specifier = match[1]!;
      targets.add(specifier.startsWith('.') ? pathToFileURL(resolve(dist, dirname(source), specifier)).href : specifier);
    }
  }
  expect(targets.size).toBeGreaterThanOrEqual(15);
  expect([...targets].map(target => target.startsWith('#') ? target.slice(1) : relative(dist, fileURLToPath(target))).filter(path => !Object.hasOwn(LOAD_BUDGET, path))).toEqual([]);
  const load = (list: readonly string[]) => spawnSync(process.execPath, ['--input-type=module', '-e', `for (const target of ${JSON.stringify(list)}) `
    + 'try { await import(target); } catch (error) { console.log(`LAZY_EDGE_FAILED ${target} ${error?.code ?? error}`); process.exitCode = 1; }'],
  { cwd: resolve(dist, '..'), encoding: 'utf8' });
  const loaded = load([...targets]);
  expect(loaded.stdout).toBe('');
  expect(loaded.status).toBe(0);
  // Negative control: a missing target is reported by name, so a broken lazy edge cannot pass as loaded.
  const broken = load([...targets, '#surfaces/core/no-such-unit/index.js']);
  expect(broken.stdout).toContain('LAZY_EDGE_FAILED #surfaces/core/no-such-unit/index.js');
  expect(broken.status).toBe(1);
});
