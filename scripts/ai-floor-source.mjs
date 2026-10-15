// Development-only source loader. No dist, build, application startup or product state.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

/** Run in a fresh process: Node caches source modules. transform is for isolated mutation tests only. */
export async function loadPolicySource(root, transform = (_path, text) => text) {
  const sourceRoot = pathToFileURL(join(root, 'src') + '/').href;
  const sources = {};
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('#domain/')) return nextResolve(pathToFileURL(join(root, 'src', specifier.slice(1).replace(/\.js$/u, '.ts'))).href, context);
      if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js'))
        return nextResolve(new URL(specifier.replace(/\.js$/u, '.ts'), context.parentURL).href, context);
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith(sourceRoot) || !url.endsWith('.ts')) return nextLoad(url, context);
      const path = relative(root, fileURLToPath(url)).replaceAll('\\', '/');
      const original = readFileSync(fileURLToPath(url), 'utf8').replace(/\r\n/gu, '\n');
      const source = transform(path, original);
      sources[path] = createHash('sha256').update(source).digest('hex');
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: path,
      }).outputText };
    },
  });
  try {
    const policy = await import(pathToFileURL(resolve(root, 'src/domain/core/policy/index.ts')).href);
    return { policy, sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
  } finally { hooks.deregister(); }
}
