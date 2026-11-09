import { DEV_NULL } from './tables.js';

interface ShellScan {
  segments: string[];
  outputRedirect: boolean;
  truncatingRedirect: boolean;
  malformed: boolean;
}

const REDIRECTION_TARGET_STOP = /[\s|;&<>()]/u;
const DESCRIPTOR = /^(?:\d+|-)$/u;
/**
 * The redirection operator starting at `index` (unquoted): `>`, `>>`, `>|`, `>&`, `&>`, `&>>` or `<&` (a plain `<` only reads and stays
 * an ordinary character). `end` is just past the operator; its target stays in the segment, where the containment check still reads it
 * as a word. `writes`: the target may be a file — anything but `/dev/null`, or a descriptor number / `-` after `>&`. `malformed`: a
 * duplication without a target, or `<&` to something other than a descriptor (the shell refuses both).
 */
function redirectionAt(command: string, index: number): { readonly end: number; readonly writes: boolean; readonly truncates: boolean; readonly malformed: boolean } | null {
  const char = command[index], next = command[index + 1];
  let end: number, duplication = false, input = false;
  if (char === '>') {
    end = index + 1;
    duplication = next === '&';
    if (next === '>' || next === '|' || next === '&') end++;
  } else if (char === '&' && next === '>') {
    end = index + 2 + (command[index + 2] === '>' ? 1 : 0);
  } else if (char === '<' && next === '&') {
    end = index + 2; duplication = true; input = true;
  } else return null;
  let at = end;
  while (command[at] === ' ' || command[at] === '\t') at++;
  let target = '';
  while (at < command.length && !REDIRECTION_TARGET_STOP.test(command[at]!)) target += command[at++];
  if (input) return { end, writes: false, truncates: false, malformed: !DESCRIPTOR.test(target) };
  if (duplication && DESCRIPTOR.test(target)) return { end, writes: false, truncates: false, malformed: false };
  return { end, writes: target !== DEV_NULL, truncates: target !== DEV_NULL && !command.slice(index, end).includes('>>'), malformed: duplication && target === '' };
}

/**
 * Split shell control operators while respecting quotes, and recursively expose
 * command substitutions as independent segments. The scanner intentionally does
 * not try to execute or expand shell syntax: malformed input remains conservative.
 */
export function scanShell(command: string): ShellScan {
  const scan: ShellScan = { segments: [], outputRedirect: false, truncatingRedirect: false, malformed: false };
  let segment = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = (): void => {
    if (segment.trim() !== '') scan.segments.push(segment.trim());
    segment = '';
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (escaped) {
      segment += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      segment += char;
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      segment += char;
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      segment += char;
      continue;
    }

    if (quote !== "'" && char === '$' && command[index + 1] === '(') {
      let depth = 1;
      let innerQuote: "'" | '"' | null = null;
      let innerEscaped = false;
      let end = index + 2;
      for (; end < command.length; end++) {
        const nested = command[end]!;
        if (innerEscaped) { innerEscaped = false; continue; }
        if (nested === '\\' && innerQuote !== "'") { innerEscaped = true; continue; }
        if (nested === "'" && innerQuote !== '"') { innerQuote = innerQuote === "'" ? null : "'"; continue; }
        if (nested === '"' && innerQuote !== "'") { innerQuote = innerQuote === '"' ? null : '"'; continue; }
        if (innerQuote === null && nested === '(') depth++;
        if (innerQuote === null && nested === ')' && --depth === 0) break;
      }
      if (depth !== 0 || innerQuote !== null || innerEscaped) {
        scan.malformed = true;
        segment += command.slice(index);
        break;
      }
      const nested = scanShell(command.slice(index + 2, end));
      scan.segments.push(...nested.segments);
      scan.outputRedirect ||= nested.outputRedirect;
      scan.truncatingRedirect ||= nested.truncatingRedirect;
      scan.malformed ||= nested.malformed;
      segment += '__shell_substitution__';
      index = end;
      continue;
    }

    if (quote !== "'" && char === '`') {
      let end = index + 1;
      let innerEscaped = false;
      for (; end < command.length; end++) {
        const nested = command[end]!;
        if (innerEscaped) { innerEscaped = false; continue; }
        if (nested === '\\') { innerEscaped = true; continue; }
        if (nested === '`') break;
      }
      if (end >= command.length) {
        scan.malformed = true;
        segment += command.slice(index);
        break;
      }
      const nested = scanShell(command.slice(index + 1, end));
      scan.segments.push(...nested.segments);
      scan.outputRedirect ||= nested.outputRedirect;
      scan.truncatingRedirect ||= nested.truncatingRedirect;
      scan.malformed ||= nested.malformed;
      segment += '__shell_substitution__';
      index = end;
      continue;
    }

    // A redirection operator stays whole in its segment (B1, owner test 2026-10-07): the `&` of `2>&1`, `>&2`, `<&0` or `&>` belongs to
    // the operator, not a background job, so a descriptor duplication is not unparseable, and (B2) a redirection to `/dev/null` or a
    // descriptor writes no file, so it does not make a read a modification.
    const redirection = quote === null ? redirectionAt(command, index) : null;
    if (redirection) {
      if (redirection.malformed) scan.malformed = true;
      if (redirection.writes) scan.outputRedirect = true;
      if (redirection.truncates) scan.truncatingRedirect = true;
      segment += command.slice(index, redirection.end);
      index = redirection.end - 1;
      continue;
    }
    if (quote === null && (char === ';' || char === '|' || char === '\n')) {
      flush();
      if (command[index + 1] === char && char === '|') index++;
      continue;
    }
    if (quote === null && char === '&') {
      flush();
      if (command[index + 1] === '&') index++;
      else scan.malformed = true;
      continue;
    }
    segment += char;
  }

  if (quote !== null || escaped) scan.malformed = true;
  flush();
  return scan;
}

export function shellWords(segment: string): string[] | null {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const flush = (): void => {
    if (started) words.push(word);
    word = '';
    started = false;
  };

  for (const char of segment) {
    if (escaped) { word += char; started = true; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (char === "'" && quote !== '"') { quote = quote === "'" ? null : "'"; started = true; continue; }
    if (char === '"' && quote !== "'") { quote = quote === '"' ? null : '"'; started = true; continue; }
    if (quote === null && /\s/.test(char)) { flush(); continue; }
    word += char;
    started = true;
  }
  if (quote !== null || escaped) return null;
  flush();
  return words;
}

