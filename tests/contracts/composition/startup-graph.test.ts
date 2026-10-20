import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVER_INFO_META_KEY } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';

// Every deckent process (CLI, runtime service, SDK consumers, workers) pays for what its entry imports STATICALLY, because ESM evaluates the
// whole static graph before the first line runs. Measured 2026-09-28 on this repo: `ink` ~167 ms, the MCP server SDK ~105 ms, of a ~470 ms
// `deckent --version` (STARTUP-COST). Lazy `import()` edges are the sanctioned way to keep a heavy module off the startup path, so this
// walk follows static edges only (the sibling sdk-import-graph test deliberately follows both).
const dist = resolve('dist');
const STATIC = /(?:^|[\n;])\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;

async function staticReach(entry: string) {
  await access(entry).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const files = new Set<string>(), packages = new Map<string, string>(), stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const match of (await readFile(file, 'utf8')).matchAll(STATIC)) {
      const specifier = (match[1] ?? match[2])!;
      if (specifier.startsWith('node:')) continue;
      const target = specifier.startsWith('#') ? resolve(dist, specifier.slice(1)) : specifier.startsWith('.') ? resolve(dirname(file), specifier) : null;
      if (target) stack.push(target);
      else packages.set(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!, relative(dist, file));
    }
  }
  return { files, packages };
}

// Packages whose import cost is large enough that a process must opt in (dynamic import) rather than inherit them.
const HEAVY = ['ink', 'react', '@modelcontextprotocol/server', '@modelcontextprotocol/client'];
const entries = { 'SDK entry': 'index.js', 'extensions entry (before runCli/runMcp)': 'extensions.js',
  'CLI entry (`--version`, `runtime serve`, every subcommand)': 'composition/core/cli/internal/entry.js' };

for (const [label, entry] of Object.entries(entries)) {
  it(`${label} statically reaches none of the heavy packages`, async () => {
    const { packages } = await staticReach(resolve(dist, entry));
    expect(HEAVY.filter(name => packages.has(name)).map(name => `${name} <- ${packages.get(name)}`)).toEqual([]);
  });
}

it('the stdio MCP entry may load the server SDK but never the terminal UI stack or the MCP client SDK', async () => {
  const { packages } = await staticReach(resolve(dist, 'composition/core/mcp/internal/entry.js'));
  expect(['ink', 'react', '@modelcontextprotocol/client'].filter(name => packages.has(name)).map(name => `${name} <- ${packages.get(name)}`)).toEqual([]);
  expect(packages.has('@modelcontextprotocol/server')).toBe(true);
});

it('the inlined server-info meta key equals the SDK constant it replaces', async () => {
  for (const file of ['surfaces/core/mcp/internal/delivery.js', 'adapters/core/mcp-transport/internal/delivery.js']) {
    expect(await readFile(resolve(dist, file), 'utf8')).toContain(`const SERVER_INFO_META_KEY = '${SERVER_INFO_META_KEY}';`);
  }
});

// COLDSTART (PB-COLDSTART, owner 2026-10-19): help, `--version` and an unknown command load neither the adapters nor the engine barrel (each
// ~1000 modules, ~0.33 s of a ~0.45 s start), nor the CLI host that binds every composition unit; a command loads them on its first call.
const HOST_GRAPH = ['adapters/index.js', 'engine/index.js', 'composition/core/root/index.js', 'composition/core/cli/internal/host.js', 'surfaces/core/cli-observe/index.js'];

it('the CLI entry statically reaches none of the host graph (adapters, engine, composition root, CLI host)', async () => {
  const { files } = await staticReach(resolve(dist, 'composition/core/cli/internal/entry.js'));
  expect(HOST_GRAPH.filter(path => files.has(resolve(dist, path)))).toEqual([]);
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

// A lazy edge fails only when its command runs, so every `import()` target of the CLI start path must load from the build (the names are
// pinned by the type checker through `lazyFunction`).
it('every lazy edge of the CLI start path loads from the build', async () => {
  const sources = ['composition/core/cli/internal/entry.js', 'surfaces/index.js', 'surfaces/core/cli/internal/entry.js', 'surfaces/core/cli/internal/kernel-commands.js'];
  const targets = new Set<string>();
  for (const source of sources) {
    for (const match of (await readFile(resolve(dist, source), 'utf8')).matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const specifier = match[1]!;
      targets.add(specifier.startsWith('.') ? pathToFileURL(resolve(dist, dirname(source), specifier)).href : specifier);
    }
  }
  expect(targets.size).toBeGreaterThanOrEqual(15);
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
