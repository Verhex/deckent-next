import { access, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';

// The SDK entry (and every process that loads composition: runtime service, workers) must not load the surface layer (Ink/React)
// at runtime. A value import of `#surfaces/index.js` inside composition pulled the whole surfaces barrel into the SDK graph and made
// process tests ~25% slower (COMPOSITION-BUDGET follow-up). `import type` is erased by the build, so the built graph is the truth.
const dist = resolve('dist');
const STATIC = /(?:^|[\n;])\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

async function reachable(entry: string) {
  await access(entry).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const files = new Set<string>(), packages = new Set<string>(), parent = new Map<string, string>(), stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const text = await readFile(file, 'utf8');
    for (const match of [...text.matchAll(STATIC), ...text.matchAll(DYNAMIC)]) {
      const specifier = (match[1] ?? match[2])!;
      // `#layer/...` resolves through package.json `imports` to `dist/layer/...`; a bare specifier is a package.
      const target = specifier.startsWith('#') ? resolve(dist, specifier.slice(1)) : specifier.startsWith('.') ? resolve(dirname(file), specifier) : null;
      if (target === null) { packages.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!); continue; }
      if (!parent.has(target)) parent.set(target, file);
      stack.push(target);
    }
  }
  const chain = (file: string) => { const out = [relative(dist, file)]; for (let at = parent.get(file); at; at = parent.get(at)) out.unshift(relative(dist, at)); return out.join(' -> '); };
  return { files, packages, chain };
}

it('the SDK entry reaches no surface module and neither Ink nor React, statically or through a lazy import', async () => {
  const graph = await reachable(resolve(dist, 'index.js'));
  const surfaces = [...graph.files].filter(file => relative(dist, file).startsWith('surfaces/'));
  expect(surfaces.map(graph.chain)).toEqual([]);
  expect([...graph.packages].filter(name => name === 'ink' || name === 'react')).toEqual([]);
  // The walk really covers composition's runtime service and the terminal chat stream it serves.
  expect(graph.files.has(resolve(dist, 'composition/core/terminal-chat/internal/agent-stream.js'))).toBe(true);
});
