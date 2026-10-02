// Source-only binding ratchet. The removed historical dead fields leave an empty, shrink-only baseline.
import ts from 'typescript';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
export const DECLARED_ONLY_ALLOWLIST = Object.freeze([]);
const fieldRegistry = 'src/platform/core/config-fields/internal/fields.ts';
const nameOf = node => ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
const property = (object, key) => ts.isObjectLiteralExpression(object) ? object.properties.find(node => ts.isPropertyAssignment(node) && nameOf(node.name) === key)?.initializer : undefined;
const literal = node => node && ts.isStringLiteralLike(node) ? node.text : undefined;
function sourceFiles(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sourceFiles(join(path, entry.name)) : entry.name.endsWith('.ts') ? [join(path, entry.name)] : []);
}
function referencesField(source, key) {
  let found = false;
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && node.name.text === key) found = true;
    if (ts.isElementAccessExpression(node) && literal(node.argumentExpression) === key) found = true;
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'getConfigFieldDefault' && literal(node.arguments[0]) === key) found = true;
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(node.operatorToken.kind)) {
      const selection = literal(node.left) === key ? node.right : literal(node.right) === key ? node.left : undefined;
      if (selection && ts.isPropertyAccessExpression(selection) && ['key', 'keyPath'].includes(selection.name.text)) found = true;
    }
    if (ts.isPropertyAssignment(node) && nameOf(node.name) === 'keyPath' && literal(node.initializer) === key) found = true;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(source); return found;
}
/** Shared source metadata for binding validation and lint-arch duplicate-default detection. */
export function collectConfigBindings(sources) {
  const declarations = [];
  for (const { source, path } of sources) {
    function visit(node) {
      if (path === fieldRegistry && ts.isPropertyAssignment(node) && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'field') {
        declarations.push({ key: nameOf(node.name), path, binding: node.initializer.arguments[1], apply: node.initializer.arguments[2], schema: node.initializer.arguments[3] });
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'registerConfigSection') {
        const key = literal(node.arguments[0]), metadata = node.arguments[2] && property(node.arguments[2], 'metadata');
        declarations.push({ key, path, binding: metadata && property(metadata, 'binding'), apply: metadata && property(metadata, 'apply'), schema: node.arguments[1] });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return declarations;
}
/** Checks declared consumer references, not runtime causality; behavioral proofs remain required for each binding. */
export function lintConfigBindings(root, fail) {
  if (!existsSync(join(root, fieldRegistry))) return;
  const references = new Map();
  const parse = file => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declarations = collectConfigBindings(sourceFiles(join(root, 'src')).map(file => ({ source: parse(file), path: relative(root, file).replaceAll('\\', '/') })));
  for (const row of declarations) {
    if (!row.key || !row.binding || !['live', 'restart'].includes(literal(row.apply))) { fail('config-binding-metadata', row.path, `${row.key ?? '<dynamic>'}: explicit binding and apply metadata required`); continue; }
    const state = literal(property(row.binding, 'state'));
    if (state === 'declared-only') {
      if (!literal(property(row.binding, 'reason'))) fail('config-binding-metadata', row.path, `${row.key}: declared-only reason required`);
      if (!DECLARED_ONLY_ALLOWLIST.includes(row.key)) fail('config-binding-declared-only', row.path, `${row.key}: new unbound configuration is forbidden`);
      continue;
    }
    const consumers = property(row.binding, 'consumers');
    if (state !== 'bound' || !consumers || !ts.isArrayLiteralExpression(consumers) || !consumers.elements.length) { fail('config-binding-metadata', row.path, `${row.key}: bound consumer unit paths required`); continue; }
    for (const consumer of consumers.elements) {
      const unit = literal(consumer);
      if (!unit || !/^src\/(platform|domain|adapters|engine|surfaces|composition)\/(core|base|enterprise|custom|user)\/[a-z][a-z0-9-]*$/.test(unit)) {
        fail('config-binding-consumer', row.path, `${row.key}: invalid consumer unit`); continue;
      }
      if (!references.has(unit)) references.set(unit, sourceFiles(join(root, unit)).map(parse));
      if (!references.get(unit).some(source => referencesField(source, row.key))) fail('config-binding-consumer', row.path, `${row.key}: ${unit} does not reference this configuration field`);
    }
  }
}
