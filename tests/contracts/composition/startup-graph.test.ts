import { access, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
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
