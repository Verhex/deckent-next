import ts from 'typescript';

/** Keep Zod's namespace statically visible to esbuild; its named `z` alias retains every export. */
export function normalizeZodImports(code) {
  const source = ts.createSourceFile('dist.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'zod') continue;
    const clause = statement.importClause, bindings = clause?.namedBindings;
    if (!clause || clause.name || !bindings || !ts.isNamedImports(bindings) || bindings.elements.length !== 1 || statement.attributes) continue;
    const imported = bindings.elements[0];
    if ((imported.propertyName ?? imported.name).text !== 'z') continue;
    let escapes = false;
    const inspect = node => {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isIdentifier(node) && node.text === imported.name.text && !(ts.isPropertyAccessExpression(node.parent)
        && node.parent.expression === node && !['z', 'default'].includes(node.parent.name.text))) escapes = true;
      ts.forEachChild(node, inspect);
    };
    inspect(source);
    if (escapes) continue;
    edits.push({ start: statement.getStart(source), end: statement.end,
      replacement: `import * as ${imported.name.text} from ${statement.moduleSpecifier.getText(source)};` });
  }
  for (const edit of edits.reverse()) code = code.slice(0, edit.start) + edit.replacement + code.slice(edit.end);
  return code;
}
