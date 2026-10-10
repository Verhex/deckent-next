const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', cntrl: '\\x00-\\x1f\\x7f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e',
};
const escapeRegExpChar = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/-]/gu, '\\$&');

/**
 * POSIX bracket expression at `segment[open]` → JS class source, or `null` when
 * the form is not supported EXACTLY (collating `[.x.]` / equivalence `[=x=]`),
 * which the caller classifies as GLOB_UNSUPPORTED. An unterminated `[` is a
 * literal bracket, as in sh. Returns the index just past the closing `]`.
 */
function compileBracket(segment: string, open: number): { source: string; end: number } | 'literal' | null {
  let i = open + 1;
  let negate = false;
  if (segment[i] === '!' || segment[i] === '^') { negate = true; i++; }
  let body = '';
  let first = true;
  while (i < segment.length) {
    const c = segment[i]!;
    if (c === ']' && !first) return { source: `[${negate ? '^/' : ''}${body}]`, end: i + 1 };
    first = false;
    if (c === '[' && (segment[i + 1] === '.' || segment[i + 1] === '=')) return null;
    if (c === '[' && segment[i + 1] === ':') {
      const close = segment.indexOf(':]', i + 2);
      if (close < 0) return null;
      const cls = POSIX_CLASSES[segment.slice(i + 2, close)];
      if (cls === undefined) return null;
      body += cls;
      i = close + 2;
      continue;
    }
    if (segment[i + 1] === '-' && i + 2 < segment.length && segment[i + 2] !== ']') {
      const hi = segment[i + 2]!;
      if (hi === '[') return null;
      if (c.charCodeAt(0) > hi.charCodeAt(0)) return null;
      body += `${escapeRegExpChar(c)}-${escapeRegExpChar(hi)}`;
      i += 3;
      continue;
    }
    body += escapeRegExpChar(c);
    i++;
  }
  return 'literal';
}

/** Shell-glob segment → RegExp (`*`/`?` never match a leading dot, as in sh);
 *  `null` for a bracket form that is not supported exactly (fail closed). */
export function globSegmentRegExp(segment: string): RegExp | null {
  let out = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const bracket = compileBracket(segment, i);
      if (bracket === null) return null;
      if (bracket === 'literal') { out += '\\['; continue; }
      out += bracket.source;
      i = bracket.end - 1;
    } else out += c.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }
  const leadingDotAllowed = segment.startsWith('.');
  return new RegExp(`^${leadingDotAllowed ? '' : '(?!\\.)'}${out}$`, 'u');
}

