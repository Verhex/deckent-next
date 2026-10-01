// sdk-exports (DEPS-TYPES, owner 2026-09-29): the public name inventory of the SDK entry (`src/index.ts` → package export `.`), read with the
// TypeScript checker so `export *` is expanded and type-only exports are listed next to values, without executing any module. The committed
// inventory (tests/contracts/composition/sdk-public-exports.json) is the reviewed contract: a change to the SDK surface shows up as a diff of
// that file, and the contract test fails until it is regenerated on purpose.
// Usage: node scripts/sdk-exports.mjs [--write]   (prints the inventory; --write replaces the committed file)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const INVENTORY = 'tests/contracts/composition/sdk-public-exports.json';

/** `{ name: 'value' | 'type' }` for every export of `src/index.ts`, sorted by name. A name that is both (class, enum) counts as a value. */
export function sdkExports(root = ROOT) {
  const config = ts.getParsedCommandLineOfConfigFile(join(root, 'tsconfig.json'), {}, { ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); } });
  const entry = join(root, 'src/index.ts');
  const program = ts.createProgram({ rootNames: [entry], options: { ...config.options, noEmit: true } });
  const checker = program.getTypeChecker(), module = checker.getSymbolAtLocation(program.getSourceFile(entry));
  const exports = checker.getExportsOfModule(module).map(symbol => {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return [symbol.name, target.flags & ts.SymbolFlags.Value ? 'value' : 'type'];
  }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(exports);
}

export const inventoryDocument = exports => ({ schemaVersion: 1, entry: 'src/index.ts',
  note: 'Reviewed SDK surface. Regenerate with `node scripts/sdk-exports.mjs --write` only for an intended change; removals need a CHANGELOG BREAKING line.',
  exports });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = `${JSON.stringify(inventoryDocument(sdkExports()), null, 2)}\n`;
  if (process.argv.includes('--write')) writeFileSync(join(ROOT, INVENTORY), text); else process.stdout.write(text);
  if (process.argv.includes('--check') && readFileSync(join(ROOT, INVENTORY), 'utf8').replace(/\r\n/gu, '\n') !== text) process.exitCode = 1;
}
