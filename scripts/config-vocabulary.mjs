// Source-only projection: never import dist or execute application initialization during lint.
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const registryPath = 'src/platform/core/config-fields/internal/fields.ts';
export const projectionPath = 'scripts/config-vocabulary.json';
export function projectVocabulary(root) {
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error('CONFIG_TYPESCRIPT_CONFIG_MISSING');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram([join(root, registryPath)], parsed.options);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(join(root, registryPath));
  if (!source) throw new Error('CONFIG_REGISTRY_MISSING');
  const dependencies = new Map([[registryPath, source.text]]);
  const track = node => { const f = node.getSourceFile(); dependencies.set(relative(root, f.fileName).replaceAll('\\', '/'), f.text); };
  function strings(node, seen = new Set()) {
    if (!node) return [];
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return strings(node.expression, seen);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(n => strings(n, seen));
    if (ts.isCallExpression(node) && node.expression.getText() === 'Object.freeze') return strings(node.arguments[0], seen);
    if (ts.isIdentifier(node)) {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declaration = symbol?.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || seen.has(declaration)) throw new Error(`CONFIG_VOCABULARY_UNRESOLVED:${node.text}`);
      track(declaration);
      return strings(declaration.initializer, new Set([...seen, declaration]));
    }
    // Numbers, null, booleans and object defaults are not string vocabulary.
    if (ts.isNumericLiteral(node) || ts.isObjectLiteralExpression(node) || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.kind)) return [];
    throw new Error(`CONFIG_VOCABULARY_UNSUPPORTED:${node.getText()}`);
  }
  const fields = {};
  function visit(node) {
    if (ts.isPropertyAssignment(node) && ts.isCallExpression(node.initializer) && node.initializer.expression.getText() === 'field') {
      const key = node.name.getText().replace(/^['"]|['"]$/g, '');
      const values = new Set();
      function schema(n) {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['enum', 'literal', 'default'].includes(n.expression.name.text)) {
          strings(n.arguments[0]).forEach(value => values.add(value));
        }
        ts.forEachChild(n, schema);
      }
      schema(node.initializer.arguments[1]);
      fields[key] = [...values].sort();
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!Object.keys(fields).length) throw new Error('CONFIG_REGISTRY_EMPTY');
  return { schemaVersion: 1, sources: Object.fromEntries([...dependencies].sort().map(([path, text]) => [path, createHash('sha256').update(text).digest('hex')])), fields };
}
export function lintConfigVocabulary(root, files, fail) {
  // Tiny architecture fixtures without config do not have a config vocabulary contract.
  if (!existsSync(join(root, registryPath))) return;
  let current;
  try {
    current = projectVocabulary(root);
    const stored = JSON.parse(readFileSync(join(root, projectionPath), 'utf8'));
    if (JSON.stringify(stored) !== JSON.stringify(current)) { fail('config-vocabulary-stale', projectionPath, 'regenerate from current source before lint/build'); return; }
  } catch (error) { fail('config-vocabulary', projectionPath, error.message); return; }
  const fieldNames = new Set(Object.keys(current.fields));
  const values = new Set(Object.values(current.fields).flat());
  const nameOf = node => ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) && node.argumentExpression ? nameOf(node.argumentExpression) : undefined;
  for (const path of files) {
    const rel = relative(root, path).replaceAll('\\', '/');
    if (Object.hasOwn(current.sources, rel)) continue;
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isStringLiteralLike(node) && values.has(node.text)) {
        let ancestor = node.parent, violation = false;
        // Check config field declarations/assignments, parameter defaults, nullish/OR defaults,
        // and duplicate enum/default schemas. Comparisons and type literals remain valid semantics.
        while (ancestor && !ts.isStatement(ancestor)) {
          if ((ts.isPropertyAssignment(ancestor) || ts.isVariableDeclaration(ancestor) || ts.isParameter(ancestor)) && ancestor.initializer && fieldNames.has(nameOf(ancestor.name))) violation = true;
          if (ts.isBinaryExpression(ancestor) && ancestor.operatorToken.kind === ts.SyntaxKind.EqualsToken && fieldNames.has(nameOf(ancestor.left))) violation = true;
          if (ts.isBinaryExpression(ancestor) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(ancestor.operatorToken.kind) && fieldNames.has(nameOf(ancestor.left))) violation = true;
          if (ts.isCallExpression(ancestor) && ts.isPropertyAccessExpression(ancestor.expression) && ['enum', 'default'].includes(ancestor.expression.name.text)) violation = true;
          ancestor = ancestor.parent;
        }
        if (violation) fail('config-literal', `${rel}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`, `config value ${JSON.stringify(node.text)} must come from the registry`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const value = JSON.stringify(projectVocabulary(root), null, 2) + '\n';
  if (process.argv.includes('--write')) writeFileSync(join(root, projectionPath), value);
  else if (readFileSync(join(root, projectionPath), 'utf8') !== value) { process.stderr.write('CONFIG_VOCABULARY_STALE\n'); process.exitCode = 1; }
}
