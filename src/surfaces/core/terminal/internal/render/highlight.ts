import { span, type Span } from './spans.js';

/**
 * Small built-in code highlighter (no dependency): keywords, literals, strings, numbers and comments for common
 * languages, unified diff lines, and a monochrome fallback. Roles follow legacy chat-render's code theme: keyword bold,
 * string success, number/literal info, comment muted italic.
 */
type Grammar = Readonly<{ keywords: ReadonlySet<string>; literals: ReadonlySet<string>; line: readonly string[]; block: readonly [string, string] | null;
  quotes: string; caseless: boolean; variables: boolean }>;
export type HighlightState = Readonly<{ inBlockComment: boolean }>;
export const HIGHLIGHT_START: HighlightState = Object.freeze({ inBlockComment: false });

const words = (text: string): ReadonlySet<string> => new Set(text.split(' '));
const JS = words('abstract as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public readonly return satisfies set static super switch throw try type typeof var void while with yield');
const GRAMMARS: Readonly<Record<string, Grammar>> = {
  js: { keywords: JS, literals: words('true false null undefined this NaN Infinity'), line: ['//'], block: ['/*', '*/'], quotes: '\'"`', caseless: false, variables: false },
  json: { keywords: words(''), literals: words('true false null'), line: [], block: null, quotes: '"', caseless: false, variables: false },
  py: { keywords: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield'),
    literals: words('True False None self'), line: ['#'], block: null, quotes: '\'"', caseless: false, variables: false },
  sh: { keywords: words('if then else elif fi for while until do done case esac in function return export local readonly set unset shift exit source echo cd'),
    literals: words('true false'), line: ['#'], block: null, quotes: '\'"', caseless: false, variables: true },
  sql: { keywords: words('select from where and or not insert into values update set delete create table view index drop alter add join left right inner outer full on as group by order having limit offset union all distinct case when then else end is in exists between like returning primary key foreign references begin commit rollback with'),
    literals: words('null true false'), line: ['--'], block: ['/*', '*/'], quotes: '\'', caseless: true, variables: false },
};
const ALIASES: Readonly<Record<string, string>> = { ts: 'js', tsx: 'js', jsx: 'js', typescript: 'js', javascript: 'js', mjs: 'js', cjs: 'js',
  jsonc: 'json', python: 'py', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', postgres: 'sql', postgresql: 'sql', sqlite: 'sql', patch: 'diff' };

export function languageOf(label: string): string | null {
  const key = label.trim().toLowerCase();
  const resolved = ALIASES[key] ?? key;
  return resolved === 'diff' || resolved in GRAMMARS ? resolved : null;
}

/** A fence without a language that carries a unified diff still gets diff colouring. */
export function looksLikeDiff(lines: readonly string[]): boolean {
  return /^(diff --git |@@ |--- )/.test(lines[0] ?? '') && lines.some(entry => /^@@ /.test(entry));
}

function diffLine(text: string): Span[] {
  if (/^(\+\+\+|---) /.test(text) || text.startsWith('diff --git')) return [span(text, { bold: true })];
  if (text.startsWith('@@')) return [span(text, { role: 'info' })];
  if (text.startsWith('+')) return [span(text, { role: 'success' })];
  if (text.startsWith('-')) return [span(text, { role: 'error' })];
  return [span(text)];
}

function codeLine(grammar: Grammar, text: string, state: HighlightState): { spans: Span[]; state: HighlightState } {
  const out: Span[] = [];
  let index = 0, inBlock = state.inBlockComment, plain = '';
  const push = (value: string, style: Parameters<typeof span>[1]) => { if (plain) { out.push(span(plain)); plain = ''; } out.push(span(value, style)); };
  while (index < text.length) {
    const rest = text.slice(index);
    if (inBlock) {
      const end = rest.indexOf(grammar.block![1]);
      const size = end === -1 ? rest.length : end + grammar.block![1].length;
      push(rest.slice(0, size), { role: 'muted', italic: true }); index += size; inBlock = end === -1; continue;
    }
    if (grammar.line.some(marker => rest.startsWith(marker))) { push(rest, { role: 'muted', italic: true }); break; }
    if (grammar.block && rest.startsWith(grammar.block[0])) { inBlock = true; push(grammar.block[0], { role: 'muted', italic: true }); index += grammar.block[0].length; continue; }
    const quote = rest[0]!;
    if (grammar.quotes.includes(quote)) {
      let end = 1;
      while (end < rest.length && rest[end] !== quote) end += rest[end] === '\\' ? 2 : 1;
      push(rest.slice(0, end + 1), { role: 'success' }); index += end + 1; continue;
    }
    const token = /^(\$\{?\w+\}?|\d[\w.]*|[A-Za-z_]\w*)/.exec(rest)?.[0];
    if (token === undefined) { plain += quote; index += 1; continue; }
    const key = grammar.caseless ? token.toLowerCase() : token;
    if (token.startsWith('$') && grammar.variables) push(token, { role: 'info' });
    else if (/^\d/.test(token) || grammar.literals.has(key)) push(token, { role: 'info' });
    else if (grammar.keywords.has(key)) push(token, { bold: true });
    else plain += token;
    index += token.length;
  }
  if (plain) out.push(span(plain));
  return { spans: out, state: inBlock === state.inBlockComment ? state : Object.freeze({ inBlockComment: inBlock }) };
}

/** Highlights one code line; `language` is a resolved name from `languageOf` (null → monochrome). */
export function highlightLine(language: string | null, text: string, state: HighlightState): { spans: Span[]; state: HighlightState } {
  if (language === 'diff') return { spans: diffLine(text), state };
  const grammar = language === null ? undefined : GRAMMARS[language];
  return grammar ? codeLine(grammar, text, state) : { spans: text === '' ? [] : [span(text)], state };
}
