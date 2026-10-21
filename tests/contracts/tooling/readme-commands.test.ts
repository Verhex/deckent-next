import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLI_CATALOG, type CliCommandSpec } from '#surfaces/core/cli-kit/index.js';

// README promise: every `deckent ...` command shown in a code fence exists. A family must be a CLI_CATALOG name; a captured
// action word must be a live (not planned) child of a family that has children. Families without children take no action word.
interface Mention { readonly file: string; readonly line: number; readonly family: string; readonly action: string | null }
const catalog = CLI_CATALOG as readonly CliCommandSpec[];

function mentions(file: string, text: string): Mention[] {
  const found: Mention[] = [];
  let fenced = false;
  text.split('\n').forEach((raw, index) => {
    if (/^\s*```/u.test(raw)) { fenced = !fenced; return; }
    if (!fenced) return;
    for (const match of raw.matchAll(/(?:^|[\s`(;&|$])deckent\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/gu)) {
      found.push({ file, line: index + 1, family: match[1]!, action: match[2] ?? null });
    }
  });
  return found;
}
function failures(found: readonly Mention[]): string[] {
  return found.flatMap(({ file, line, family, action }) => {
    const spec = catalog.find(command => command.name === family);
    if (!spec) return [`${file}:${line} deckent ${family}: no such command`];
    if (!spec.children?.length || action === null) return [];
    return spec.children.some(child => child.name === action && !child.planned) ? [] : [`${file}:${line} deckent ${family} ${action}: no such action`];
  });
}
const readme = (name: string) => readFileSync(new URL(`../../../${name}`, import.meta.url), 'utf8');

describe('README command guard', () => {
  it.each(['README.md', 'README.tr.md'])('every fenced deckent command in %s exists in CLI_CATALOG', name => {
    const found = mentions(name, readme(name));
    expect(found.length).toBeGreaterThan(20);
    expect(failures(found)).toEqual([]);
  });
  it('names an unknown family and an unknown action, and ignores unfenced text', () => {
    const text = '```sh\ndeckent nosuch run\ndeckent init nosuch\ndeckent doctor --json\n```\ndeckent nosuch outside\n';
    expect(failures(mentions('fake.md', text))).toEqual(['fake.md:2 deckent nosuch: no such command', 'fake.md:3 deckent init nosuch: no such action']);
  });
});
