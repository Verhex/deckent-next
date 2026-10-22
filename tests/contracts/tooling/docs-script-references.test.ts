import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Docs name npm scripts; a rename in package.json must not silently break them. Scanned: the README pair, CONTRIBUTING.md and
// every *.md directly in docs/ (docs/reports/ is generated and excluded).
const root = new URL('../../../', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), 'utf8');
const scripts = new Set(Object.keys((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts));
const documents = ['README.md', 'README.tr.md', 'CONTRIBUTING.md',
  ...readdirSync(new URL('docs/', root), { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => `docs/${entry.name}`).sort()];

function references(file: string, text: string): { file: string; line: number; script: string }[] {
  return text.split('\n').flatMap((line, index) => [...line.matchAll(/\bnpm run(?:\s+(?:--silent|-s))?\s+([A-Za-z0-9][\w:.-]*)/gu)]
    .map(match => ({ file, line: index + 1, script: match[1]! })));
}
const missing = (found: readonly { file: string; line: number; script: string }[]) =>
  found.filter(({ script }) => !scripts.has(script)).map(({ file, line, script }) => `${file}:${line} npm run ${script}`);

describe('documented npm scripts exist', () => {
  it('every npm run <script> in the README pair, CONTRIBUTING.md and docs/*.md is a package.json script', () => {
    const found = documents.flatMap(name => references(name, read(name)));
    expect(missing(found)).toEqual([]);
    expect(found.filter(item => item.file === 'README.md').map(item => item.script)).toEqual(expect.arrayContaining(['worker:image', 'build']));
    expect(found.some(item => item.file === 'README.tr.md')).toBe(true);
  });
  it('names a missing script with its file and line', () => {
    expect(missing(references('fake.md', 'run `npm run --silent typecheck` then `npm run no-such-script -- --x`'))).toEqual(['fake.md:1 npm run no-such-script']);
  });
});
