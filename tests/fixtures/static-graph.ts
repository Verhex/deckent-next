import { access, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

// The built graph is the truth: `import type` is erased by the build, and `#layer/...` resolves through package.json `imports` to `dist/layer/...`.
export const dist = resolve('dist');
const STATIC = /(?:^|[\n;])\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// COLDSTART (PB-COLDSTART, owner 2026-10-19): help, `--version` and an unknown command load neither the adapters nor the engine barrel (each
// ~1000 modules, ~0.33 s of a ~0.45 s start), nor the CLI host that binds every composition unit; a command loads them on its first call.
export const HOST_GRAPH = ['adapters/index.js', 'engine/index.js', 'composition/core/root/index.js', 'composition/core/cli/internal/host.js', 'surfaces/core/cli-observe/index.js'];

/** Every file and package a built entry reaches: static edges only, or also lazy `import()` edges. `packages` maps a package to its first importer. */
export async function reachGraph(entry: string, options: { readonly dynamic?: boolean } = {}) {
  await access(entry).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const files = new Set<string>(), packages = new Map<string, string>(), parent = new Map<string, string>(), stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const text = await readFile(file, 'utf8');
    for (const match of [...text.matchAll(STATIC), ...options.dynamic ? text.matchAll(DYNAMIC) : []]) {
      const specifier = (match[1] ?? match[2])!;
      if (specifier.startsWith('node:')) continue;
      const target = specifier.startsWith('#') ? resolve(dist, specifier.slice(1)) : specifier.startsWith('.') ? resolve(dirname(file), specifier) : null;
      if (target === null) { const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!; if (!packages.has(name)) packages.set(name, relative(dist, file)); continue; }
      if (!parent.has(target)) parent.set(target, file);
      stack.push(target);
    }
  }
  const chain = (file: string) => { const out = [relative(dist, file)]; for (let at = parent.get(file); at; at = parent.get(at)) out.unshift(relative(dist, at)); return out.join(' -> '); };
  return { files, packages, chain };
}

export const staticReach = (entry: string) => reachGraph(entry);
