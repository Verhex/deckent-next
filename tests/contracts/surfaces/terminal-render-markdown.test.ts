import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderedText, resolveRenderGlyphs, type RenderedLine } from '#surfaces/core/terminal/index.js';

import { projectHiddenText, renderHumanMarkdown, type HumanTextProjector } from '#surfaces/core/terminal-render/index.js';

const unicode = resolveRenderGlyphs(false), ascii = resolveRenderGlyphs(true);
const plain = (markdown: string, width = 60, glyphs = unicode) => renderedText(renderMarkdown(markdown, { width, glyphs, codeLabel: 'code' }));
const styled = (lines: readonly RenderedLine[]) => lines.flatMap(entry => [...entry.prefix, ...entry.body]).filter(part => part.role || part.bold || part.italic || part.strike);

describe('terminal markdown renderer (plain text under the none palette)', () => {
  it('renders headings, emphasis, inline code, lists, quotes, rules and links as plain text without markers', () => {
    const markdown = [
      '# Title', '## Sub **bold**', 'Some **bold**, *italic*, _also_, ~~gone~~ and `code()` text.',
      '- first', '  - nested', '1. one', '10) ten', '> quoted *line*', '---', 'See [the docs](https://example.test/a_(b)) or [https://x.test](https://x.test).',
      'Math 2 * 3 * 4 stays literal; snake_case_name too.',
    ].join('\n');
    expect(plain(markdown)).toBe([
      'Title', 'Sub bold', 'Some bold, italic, also, gone and code() text.',
      '• first', '  • nested', '1. one', '10) ten', '▌ quoted line', '─'.repeat(40), 'See the docs (https://example.test/a_(b)) or https://x.test.',
      'Math 2 * 3 * 4 stays literal; snake_case_name too.',
    ].join('\n'));
  });

  it('uses ASCII decoration when the terminal cannot draw Unicode', () => {
    expect(plain('- a\n> b\n***\n```\nx\n```', 20, ascii)).toBe(['- a', '| b', '-'.repeat(20), '+- code', '| x', '+-'].join('\n'));
  });

  it('frames fenced code with its language label, collapses blank runs outside code and keeps blank lines inside', () => {
    expect(plain('Intro\n\n\n```ts\nconst a = 1;\n\nreturn a;\n```\nOutro')).toBe(
      ['Intro', '', '╭─ ts', '│ const a = 1;', '│ ', '│ return a;', '╰─', 'Outro'].join('\n'));
  });

  it('renders an unclosed fence as an open block (live tail) without a bottom frame', () => {
    expect(plain('```py\nprint(1)')).toBe(['╭─ py', '│ print(1)'].join('\n'));
  });

  it('highlights keywords, strings, numbers and comments for known languages and stays monochrome otherwise', () => {
    const [, ts] = renderMarkdown('```ts\nconst name = "x"; // note\n```', { width: 60, glyphs: unicode, codeLabel: 'code' });
    expect(ts!.body).toEqual([{ text: 'const', bold: true }, { text: ' name = ' }, { text: '"x"', role: 'success' }, { text: '; ' }, { text: '// note', role: 'muted', italic: true }]);
    const [, sql] = renderMarkdown('```sql\nSELECT id FROM t WHERE n = 42 -- c\n```', { width: 60, glyphs: unicode, codeLabel: 'code' });
    expect(styled([sql!]).map(part => part.text)).toEqual(['│', 'SELECT', 'FROM', 'WHERE', '42', '-- c']);
    const [, other] = renderMarkdown('```brainfuck\n+[->+<]\n```', { width: 60, glyphs: unicode, codeLabel: 'code' });
    expect(other!.body).toEqual([{ text: '+[->+<]' }]);
  });

  it('colours unified diff lines, also for an unlabelled fence that carries a diff', () => {
    for (const fence of ['```diff', '```']) {
      const lines = renderMarkdown(`${fence}\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n same\n\`\`\``, { width: 60, glyphs: unicode, codeLabel: 'code' });
      expect(lines.slice(1, 7).map(entry => entry.body[0])).toEqual([
        { text: '--- a/x.ts', bold: true }, { text: '+++ b/x.ts', bold: true }, { text: '@@ -1 +1 @@', role: 'info' },
        { text: '-old', role: 'error' }, { text: '+new', role: 'success' }, { text: ' same' }]);
    }
  });

  it('wraps long code lines inside the frame instead of breaking it', () => {
    expect(plain('```\nabcdefghij klmnopqrst uvwxyz\n```', 14)).toBe(['╭─ code', '│ abcdefghij', '│ klmnopqrst', '│ uvwxyz', '╰─'].join('\n'));
  });
});

describe('terminal markdown tables (width-aware)', () => {
  const table = '| Name | Role | Note |\n|:--|:-:|--:|\n| Ada | admin | `root` |\n| Linus | dev | x |';

  it('keeps natural column widths and alignment when the table fits', () => {
    expect(plain(table, 80)).toBe([
      '┌───────┬───────┬──────┐',
      '│ Name  │ Role  │ Note │',
      '├───────┼───────┼──────┤',
      '│ Ada   │ admin │ root │',
      '│ Linus │  dev  │    x │',
      '└───────┴───────┴──────┘',
    ].join('\n'));
  });

  it('shrinks and wraps the widest columns to fit a narrow terminal', () => {
    const wide = '| Key | Description |\n|---|---|\n| a | the quick brown fox jumps over |';
    const text = plain(wide, 26);
    expect(text).toBe([
      '┌─────┬──────────────────┐',
      '│ Key │ Description      │',
      '├─────┼──────────────────┤',
      '│ a   │ the quick brown  │',
      '│     │ fox jumps over   │',
      '└─────┴──────────────────┘',
    ].join('\n'));
    for (const row of text.split('\n')) expect(row.length).toBe(26);
  });

  it('degrades to header: value rows when even minimal columns do not fit', () => {
    expect(plain(table, 12)).toBe(['• Name: Ada', '  Role: admin', '  Note: root', '• Name: Linus', '  Role: dev', '  Note: x'].join('\n'));
  });

  it('keeps a pipe line followed by a rule as prose (a delimiter row needs a pipe)', () => {
    expect(plain('a | b\n---', 10)).toBe(['a | b', '─'.repeat(10)].join('\n'));
  });

  it('uses ASCII borders for the ASCII glyph set', () => {
    expect(plain('| a |\n|---|\n| 1 |', 40, ascii)).toBe(['+---+', '| a |', '+---+', '| 1 |', '+---+'].join('\n'));
  });
});


describe('S06 contextual hidden-text projection', () => {
  it('marks real exact-code tokens before wrapping; prose shaping and literal look-alikes retain their meaning', () => {
    const prose = 'Türkçe العربية فارسی می\u200cروم 👩\u200d💻 ❤️';
    const source = `${prose} <U+202E>\nInline \`pay\u200broll.ts\` and override \u202eX.\n\`\`\`sh\necho "tag\u{e0041}"\n\`\`\``;
    for (const width of [60, 80, 120]) {
      let count = 0;
      const project: HumanTextProjector = (text, context, style) => {
        const result = projectHiddenText(text, context, style); count += result.hiddenCount; return [...result.spans];
      };
      const lines = renderMarkdown(source, { width, glyphs: unicode, codeLabel: 'code', projectText: project });
      const text = renderedText(lines);
      expect(count).toBe(3);
      expect(text).toContain(prose);
      expect(text).toContain('pay<U+200B>roll.ts');
      expect(text).toContain('override <U+202E>X');
      expect(text).toContain('tag<U+E0041>');
      expect(text).not.toMatch(/[\u202e\u200b\u{e0041}]/u);
      expect(lines.flatMap(row => row.body).filter(part => part.hiddenCodePoint !== undefined).every(part => part.role === 'warning')).toBe(true);
    }
    const literal = projectHiddenText('<U+202E>', 'exact');
    expect(literal.hiddenCount).toBe(0);
    expect(literal.spans[0]).not.toHaveProperty('hiddenCodePoint');
  });

  it('classifies table inline code and URL identifiers with exact context before cell fitting', () => {
    let count = 0;
    const project: HumanTextProjector = (text, context, style) => {
      const result = projectHiddenText(text, context, style); count += result.hiddenCount; return [...result.spans];
    };
    const lines = renderMarkdown('| value | url |\n|---|---|\n| `a\u200bb` | [site](https://x/a\u200bb) |',
      { width: 60, glyphs: ascii, codeLabel: 'code', projectText: project });
    expect(count).toBe(2);
    expect(renderedText(lines)).toContain('a<U+200B>b');
  });
});


describe('S06 R1/R2 public projection regressions', () => {
  it('retains real fence-info FEFF metadata and distinguishes fake/clean/blank labels', () => {
    for (const width of [60, 80, 120]) for (const label of ['\ufeffsh', 'sh\ufeff', '\ufeff']) {
      const result = renderHumanMarkdown(`\`\`\`${label}\necho ok\n\`\`\``, { width, glyphs: unicode, codeLabel: 'code' });
      expect(result.hiddenCount).toBe(1);
      expect(renderedText(result.lines)).toContain('<U+FEFF>');
      expect(result.lines.flatMap(row => row.body).filter(part => part.hiddenCodePoint === 0xfeff)).toEqual([
        expect.objectContaining({ text: '<U+FEFF>', role: 'warning', hiddenCodePoint: 0xfeff }),
      ]);
      expect(renderedText(result.lines)).not.toContain('\ufeff');
    }
    for (const label of ['sh', '<U+FEFF>', '', ' \t ']) {
      const result = renderHumanMarkdown(`\`\`\`${label}\necho ok\n\`\`\``, { width: 60, glyphs: unicode, codeLabel: 'code' });
      expect(result.hiddenCount).toBe(0);
      expect(result.lines.flatMap(row => row.body).some(part => part.hiddenCodePoint !== undefined)).toBe(false);
      expect(renderedText(result.lines)).toContain(label.trim() || 'code');
    }
  });
});
