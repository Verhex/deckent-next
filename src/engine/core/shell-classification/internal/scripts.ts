import type { ShellReasonCode } from './scanner.js';

/**
 * Script grammars of sed and awk (legacy @a8b67e2a1, kept as is): a script is read-only only when every command prints or edits
 * the stream; writing (`w`, `W`, `s///w`), reading other files (`r`, `R`), executing (`e`, `s///e`, `system`, `getline`, pipes) or
 * redirecting output is SCRIPT_UNSAFE, and anything the grammar does not recognise is SCRIPT_UNPARSEABLE (fail closed).
 */
export function checkSedScript(script: string): ShellReasonCode | null {
  let i = 0;
  const n = script.length;
  const skipDelimited = (delim: string): boolean => {
    while (i < n) {
      const c = script[i]!;
      if (c === '\\') { i += 2; continue; }
      if (c === delim) { i++; return true; }
      if (c === '\n') return false;
      i++;
    }
    return false;
  };
  const parseAddress = (): boolean => {
    const c = script[i] ?? '';
    if (/\d/u.test(c)) {
      while (i < n && /\d/u.test(script[i]!)) i++;
      if (script[i] === '~') { i++; while (i < n && /\d/u.test(script[i]!)) i++; }
      return true;
    }
    if (c === '$') { i++; return true; }
    if (c === '/') { i++; if (!skipDelimited('/')) return false; while (script[i] === 'I' || script[i] === 'M') i++; return true; }
    if (c === '\\') {
      const delim = script[i + 1] ?? '';
      if (delim === '' || delim === '\n' || delim === '\\') return false;
      i += 2;
      if (!skipDelimited(delim)) return false;
      while (script[i] === 'I' || script[i] === 'M') i++;
      return true;
    }
    return true;
  };
  let depth = 0;
  while (i < n) {
    const c = script[i]!;
    if (c === ' ' || c === '\t' || c === ';' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < n && script[i] !== '\n') i++; continue; }
    if (c === '}') { if (depth === 0) return 'SCRIPT_UNPARSEABLE'; depth--; i++; continue; }
    if (!parseAddress()) return 'SCRIPT_UNPARSEABLE';
    if (script[i] === ',') {
      i++;
      if (script[i] === '+' || script[i] === '~') i++;
      if (!parseAddress()) return 'SCRIPT_UNPARSEABLE';
    }
    while (script[i] === ' ' || script[i] === '\t') i++;
    while (script[i] === '!') i++;
    while (script[i] === ' ' || script[i] === '\t') i++;
    const cmd = script[i] ?? '';
    if (cmd === '') return 'SCRIPT_UNPARSEABLE';
    i++;
    switch (cmd) {
      case '{': depth++; continue;
      case 'p': case 'P': case 'n': case 'N': case 'd': case 'D': case 'g': case 'G':
      case 'h': case 'H': case 'x': case '=': case 'z': case 'F':
        break;
      case 'l': case 'q': case 'Q': case 'L':
        while (i < n && (script[i] === ' ' || /\d/u.test(script[i]!))) i++;
        break;
      case 's': {
        const delim = script[i] ?? '';
        if (delim === '' || delim === '\n' || delim === '\\') return 'SCRIPT_UNPARSEABLE';
        i++;
        if (!skipDelimited(delim)) return 'SCRIPT_UNPARSEABLE';
        if (!skipDelimited(delim)) return 'SCRIPT_UNPARSEABLE';
        while (i < n && /[gpiImM0-9]/u.test(script[i]!)) i++;
        if (script[i] === 'e' || script[i] === 'w') return 'SCRIPT_UNSAFE';
        break;
      }
      case 'y': {
        const delim = script[i] ?? '';
        if (delim === '' || delim === '\n' || delim === '\\') return 'SCRIPT_UNPARSEABLE';
        i++;
        if (!skipDelimited(delim)) return 'SCRIPT_UNPARSEABLE';
        if (!skipDelimited(delim)) return 'SCRIPT_UNPARSEABLE';
        break;
      }
      case 'b': case 't': case 'T': case ':':
        while (i < n && script[i] !== ';' && script[i] !== '\n' && script[i] !== '}') i++;
        break;
      case 'a': case 'i': case 'c':
        // GNU one-liner text: output-only, consumes the rest of the line
        // (backslash-newline continuations included).
        while (i < n) {
          if (script[i] === '\\') { i += 2; continue; }
          if (script[i] === '\n') break;
          i++;
        }
        break;
      case 'r': case 'R': case 'w': case 'W': case 'e':
        return 'SCRIPT_UNSAFE';
      default:
        return 'SCRIPT_UNPARSEABLE';
    }
    while (script[i] === ' ' || script[i] === '\t') i++;
    const after = script[i] ?? '';
    if (after !== '' && after !== ';' && after !== '\n' && after !== '}' && after !== '#') return 'SCRIPT_UNPARSEABLE';
  }
  return depth === 0 ? null : 'SCRIPT_UNPARSEABLE';
}

const AWK_UNSAFE_IDENTIFIERS = new Set(['system', 'getline']);

export function checkAwkProgram(program: string): ShellReasonCode | null {
  let i = 0;
  const n = program.length;
  let braceDepth = 0;
  let parenDepth = 0;
  let previous = '';
  const regexMayStart = (): boolean => previous === '' || '(,;{}!~&|=<>+-*%^?:\n'.includes(previous);
  while (i < n) {
    const c = program[i]!;
    if (c === '"') {
      i++;
      while (i < n && program[i] !== '"') { if (program[i] === '\\') i++; i++; }
      if (i >= n) return 'SCRIPT_UNPARSEABLE';
      i++;
      previous = '"';
      continue;
    }
    if (c === '/' && regexMayStart()) {
      i++;
      while (i < n && program[i] !== '/') {
        if (program[i] === '\\') i++;
        else if (program[i] === '\n') return 'SCRIPT_UNPARSEABLE';
        i++;
      }
      if (i >= n) return 'SCRIPT_UNPARSEABLE';
      i++;
      previous = '/';
      continue;
    }
    if (c === '#') { while (i < n && program[i] !== '\n') i++; continue; }
    if (c === '@') return 'SCRIPT_UNSAFE';
    if (/[A-Za-z_]/u.test(c)) {
      let ident = '';
      while (i < n && /[A-Za-z0-9_]/u.test(program[i]!)) ident += program[i++];
      if (AWK_UNSAFE_IDENTIFIERS.has(ident)) return 'SCRIPT_UNSAFE';
      previous = ident;
      continue;
    }
    if (c === '|') {
      if (program[i + 1] === '|') { i += 2; previous = '|'; continue; }
      return 'SCRIPT_UNSAFE';
    }
    if (c === '>') {
      if (program[i + 1] === '=') { i += 2; previous = '='; continue; }
      if (braceDepth > 0 && parenDepth === 0) return 'SCRIPT_UNSAFE';
      i++;
      previous = '>';
      continue;
    }
    if (c === '{') braceDepth++;
    else if (c === '}') { if (braceDepth === 0) return 'SCRIPT_UNPARSEABLE'; braceDepth--; }
    else if (c === '(') parenDepth++;
    else if (c === ')') { if (parenDepth === 0) return 'SCRIPT_UNPARSEABLE'; parenDepth--; }
    if (!/\s/u.test(c)) previous = c;
    i++;
  }
  return braceDepth === 0 && parenDepth === 0 ? null : 'SCRIPT_UNPARSEABLE';
}
