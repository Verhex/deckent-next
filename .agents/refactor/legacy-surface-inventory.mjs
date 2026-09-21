import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const fail = () => { throw new Error('LEGACY_CONTRACT_UNSUPPORTED'); };
const identifier = (node, name) => node && ts.isIdentifier(node) && node.text === name;
function frozenArgument(node) {
  if (!node || !ts.isCallExpression(node) || node.arguments.length !== 1
    || !ts.isPropertyAccessExpression(node.expression) || !identifier(node.expression.expression, 'Object')
    || !identifier(node.expression.name, 'freeze')) fail();
  return node.arguments[0];
}
/** Parse authored literals only. Never transpile/import/evaluate legacy code. */
function literal(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) {
    const result = Object.create(null);
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) fail();
      const key = property.name.text;
      if (Object.hasOwn(result, key) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail();
      result[key] = literal(property.initializer);
    }
    return result;
  }
  fail();
}
function surfaces(value) {
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length
    || value.some(surface => !['cli', 'mcp', 'repl'].includes(surface))) fail();
  return value;
}
function defaultSurfaces(ast) {
  const factories = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && identifier(statement.name, 'c'));
  if (factories.length !== 1 || !factories[0].body) fail();
  const returns = factories[0].body.statements.filter(ts.isReturnStatement);
  if (returns.length !== 1 || !returns[0].expression || !ts.isObjectLiteralExpression(returns[0].expression)) fail();
  const properties = returns[0].expression.properties.filter(property => ts.isPropertyAssignment(property) && identifier(property.name, 'surfaces'));
  if (properties.length !== 1) fail();
  const array = frozenArgument(properties[0].initializer);
  if (!ts.isArrayLiteralExpression(array) || array.elements.length !== 1 || !ts.isSpreadElement(array.elements[0])) fail();
  let fallback = array.elements[0].expression;
  while (ts.isParenthesizedExpression(fallback)) fallback = fallback.expression;
  if (!ts.isBinaryExpression(fallback) || fallback.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
    || !ts.isPropertyAccessExpression(fallback.left) || !identifier(fallback.left.expression, 'init')
    || !identifier(fallback.left.name, 'surfaces')) fail();
  return surfaces(literal(fallback.right));
}
export function inventoryLegacyContract(source, sourcePath = 'cli-command-contract.ts') {
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (ast.parseDiagnostics.length) fail();
  const catalogs = ast.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
    .filter(declaration => identifier(declaration.name, 'CLI_COMMAND_CONTRACTS'));
  if (catalogs.length !== 1) fail();
  const array = frozenArgument(catalogs[0].initializer), defaults = defaultSurfaces(ast);
  if (!ts.isArrayLiteralExpression(array) || !array.elements.length) fail();
  const seen = new Set();
  const rows = array.elements.map(node => {
    if (!ts.isCallExpression(node) || !identifier(node.expression, 'c') || node.arguments.length !== 1
      || !ts.isObjectLiteralExpression(node.arguments[0])) fail();
    const authored = literal(node.arguments[0]);
    if (typeof authored.path !== 'string' || !authored.path.length || authored.path.trim() !== authored.path
      || /[\r\n\t]| {2}/.test(authored.path) || seen.has(authored.path)) fail();
    if (['summaryKey', 'effect', 'defaultExecution', 'authority', 'output'].some(key => typeof authored[key] !== 'string' || !authored[key])) fail();
    seen.add(authored.path);
    return { path: authored.path, surfaces: surfaces(Object.hasOwn(authored, 'surfaces') ? authored.surfaces : [...defaults]),
      surfacesSource: Object.hasOwn(authored, 'surfaces') ? 'row' : 'factory-fallback',
      sourceLine: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, authored };
  });
  return { schemaVersion: 1, source: { path: sourcePath, sha256: createHash('sha256').update(source).digest('hex') },
    evidence: 'static-authored-contract; no legacy execution, runtime reachability, Next parity or migration acceptance',
    defaultSurfaces: defaults,
    counts: { paths: rows.length, bySurface: Object.fromEntries(['cli', 'mcp', 'repl'].map(surface =>
      [surface, rows.filter(row => row.surfaces.includes(surface)).length])),
      replOnly: rows.filter(row => row.surfaces.length === 1 && row.surfaces[0] === 'repl').length }, rows };
}
export async function readLegacyInventory(path) {
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 2_097_152n) fail();
    const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const bytes = buffer.subarray(0, length), after = await handle.stat({ bigint: true });
    if (before.size !== BigInt(bytes.length) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail();
    return inventoryLegacyContract(new TextDecoder('utf-8', { fatal: true }).decode(bytes), resolve(path));
  } finally { await handle.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('LEGACY_CONTRACT_USAGE');
    console.log(JSON.stringify(await readLegacyInventory(process.argv[2]), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message === 'LEGACY_CONTRACT_USAGE' ? error.message : 'LEGACY_CONTRACT_UNSUPPORTED' }));
    process.exitCode = 1;
  }
}
