// P5b: all process/public entries belong to ONE split graph, including extensions, so registration and consumption share module state.
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { transform } from 'esbuild';
import { normalizeZodImports } from './dist-zod.mjs';

// Non-literal imports into a BeUser candidate, plus the storage seams used to provision the offline distribution smoke fixture.
const RESOURCE_ENTRIES = ['platform/index.js', 'adapters/core/installation-files/index.js', 'adapters/core/local-runtime-socket/index.js',
  'composition/core/root/index.js', 'composition/core/storage/index.js'];
export function ownEntries(dist, manifest) {
  const exports = Object.values(manifest.exports).map(entry => typeof entry === 'string' ? entry : entry.import);
  return [...new Set([...Object.values(manifest.bin), ...exports].map(entry => resolve(dist, '..', entry))
    .concat(RESOURCE_ENTRIES.map(entry => join(dist, entry))))];
}

const ORIGINAL_URL = 'deckent-dist-source:';
/** esbuild's define parser replaces only the expression, never a comment/string. Restore its source-relative URL after chunk names are known. */
export function ownModulePlugin(dist) {
  return { name: 'deckent-own-source-urls', setup(builder) {
    builder.onLoad({ filter: /\.js$/ }, async args => {
      if (!args.path.startsWith(dist + sep)) return undefined;
      const original = readFileSync(args.path, 'utf8'), code = normalizeZodImports(original);
      if (!code.includes('import.meta')) return code === original ? undefined : { contents: code, loader: 'js', resolveDir: dirname(args.path) };
      const source = relative(dist, args.path).replaceAll('\\', '/');
      const url = JSON.stringify(ORIGINAL_URL + source);
      const result = await transform(code, { loader: 'js', target: 'node24', format: 'esm',
        define: { 'import.meta': JSON.stringify({ url: ORIGINAL_URL + source }), 'import.meta.url': url, 'import.meta.main': '__deckentOriginalMain' } });
      // Whole `import.meta` consumers (MCP's isMainModule) use the existing source-URL fallback. The bin's direct .main uses the same entry rule.
      const entryRule = relative(dirname(args.path), join(dist, 'platform/core/host/internal/entry.js')).replaceAll('\\', '/');
      const prefix = result.code.includes('__deckentOriginalMain') ? `import { isMainModule as __deckentIsMain } from ${JSON.stringify(entryRule.startsWith('.') ? entryRule : './' + entryRule)};
const __deckentOriginalMain = __deckentIsMain({ url: ${url} });\n` : '';
      const contents = result.code.startsWith('#!') ? result.code.replace('\n', '\n' + prefix) : prefix + result.code;
      return { contents, loader: 'js', resolveDir: dirname(args.path) };
    });
  } };
}

export function restoreOwnUrls(code, output, dist) {
  return code.replace(/"deckent-dist-source:([^"\n]+)"/gu, (_match, source) => {
    const path = relative(dirname(output), join(dist, source)).replaceAll('\\', '/');
    return `new URL(${JSON.stringify(path.startsWith('.') ? path : './' + path)}, import.meta.url).href`;
  });
}
