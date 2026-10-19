import { expect } from 'vitest';

/**
 * Host-independent cost of a redaction expression (SEC-6b F39). V8 Irregexp exposes no step counter, so this models the ECMA-262 §22.2.2
 * pattern semantics — a backtracking matcher with continuations — and counts its work: every matcher invocation, every character a greedy
 * loop consumes and every continuation it retries while giving characters back. The counted steps are the work a backtracking engine owes
 * the expression by definition; a real engine may skip some (literal pre-scan), never the asymptotic order. The subset is exactly what the
 * redaction table's jwt row uses — literals, `\w`, escaped punctuation, simple classes, `\b`, groups, lookahead, single-character
 * lookbehind and greedy `* + ?` — and anything else throws. `modelMatches` lets a test check the model against V8 on the same inputs.
 */
type Node =
  | { readonly t: 'char'; readonly test: (char: string) => boolean }
  | { readonly t: 'boundary' }
  | { readonly t: 'seq'; readonly items: readonly Node[] }
  | { readonly t: 'look'; readonly behind: boolean; readonly negative: boolean; readonly body: Node }
  | { readonly t: 'rep'; readonly body: Node; readonly min: number; readonly max: number };
const WORD = /^\w$/u;
const isWord = (char: string | undefined) => char !== undefined && WORD.test(char);

function parse(source: string): Node {
  let at = 0;
  const atom = (): Node => {
    const char = source[at++]!;
    if (char === '\\') {
      const escaped = source[at++]!;
      if (escaped === 'b') return { t: 'boundary' };
      if (escaped === 'w') return { t: 'char', test: isWord };
      if (/^[.\\\-[\]()*+?{}|^$/]$/u.test(escaped)) return { t: 'char', test: c => c === escaped };
      throw new Error(`REGEX_COST_UNSUPPORTED escape \\${escaped}`);
    }
    if (char === '[') {
      const tests: ((c: string) => boolean)[] = [];
      while (source[at] !== ']') {
        if (at >= source.length) throw new Error('REGEX_COST_UNSUPPORTED unterminated class');
        if (source[at] === '\\' && source[at + 1] === 'w') { tests.push(isWord); at += 2; continue; }
        const literal = source[at] === '\\' ? source[++at]! : source[at]!;
        if (literal === '^' && tests.length === 0) throw new Error('REGEX_COST_UNSUPPORTED negated class');
        if (source[at + 1] === '-' && source[at + 2] !== ']') throw new Error('REGEX_COST_UNSUPPORTED class range');
        tests.push(c => c === literal); at++;
      }
      at++;
      return { t: 'char', test: c => tests.some(test => test(c)) };
    }
    if (char === '(') {
      let look: { behind: boolean; negative: boolean } | null = null;
      if (source.startsWith('?:', at)) at += 2;
      else if (/^\?<?[=!]/u.test(source.slice(at, at + 3))) {
        const behind = source[at + 1] === '<'; look = { behind, negative: source[at + (behind ? 2 : 1)] === '!' }; at += behind ? 3 : 2;
      }
      else if (source[at] === '?') throw new Error('REGEX_COST_UNSUPPORTED group kind');
      const body = sequence();
      if (source[at++] !== ')') throw new Error('REGEX_COST_UNSUPPORTED unterminated group');
      if (look?.behind && body.t !== 'char') throw new Error('REGEX_COST_UNSUPPORTED lookbehind wider than one character');
      return look ? { t: 'look', ...look, body } : body;
    }
    if ('|)*+?{^$.'.includes(char)) throw new Error(`REGEX_COST_UNSUPPORTED ${char}`);
    return { t: 'char', test: c => c === char };
  };
  const sequence = (): Node => {
    const items: Node[] = [];
    while (at < source.length && source[at] !== ')') {
      let node = atom();
      const quantifier = source[at];
      if (quantifier === '*' || quantifier === '+' || quantifier === '?') {
        at++;
        if (source[at] === '?' || source[at] === '+') throw new Error('REGEX_COST_UNSUPPORTED lazy or possessive quantifier');
        node = { t: 'rep', body: node, min: quantifier === '+' ? 1 : 0, max: quantifier === '?' ? 1 : Infinity };
      }
      items.push(node);
    }
    return items.length === 1 ? items[0]! : { t: 'seq', items };
  };
  const root = sequence();
  if (at !== source.length) throw new Error('REGEX_COST_UNSUPPORTED alternation or trailing input');
  return root;
}

/** A node that consumes exactly one character or fails, with no alternative to retry (a class, or zero-width checks plus one class). */
function single(node: Node): boolean {
  if (node.t === 'char') return true;
  if (node.t !== 'seq') return false;
  const consuming = node.items.filter(item => item.t !== 'boundary' && item.t !== 'look');
  return consuming.length === 1 && single(consuming[0]!);
}

export interface RegexCost { readonly steps: number; readonly matches: readonly (readonly [number, number])[] }

/** `mode` 'test': the first match from position 0 (`RegExp#test`, `hasSecret`, the gate); 'all': every match like `matchAll` with `g` (counters). */
export function backtrackingSteps(source: string, input: string, mode: 'test' | 'all'): RegexCost {
  const root = parse(source);
  let steps = 0;
  type Continuation = (position: number) => boolean;
  const match = (node: Node, position: number, next: Continuation): boolean => {
    steps++;
    switch (node.t) {
      case 'char': return position < input.length && node.test(input[position]!) && next(position + 1);
      case 'boundary': return isWord(input[position - 1]) !== isWord(input[position]) && next(position);
      case 'seq': {
        const from = (index: number, at: number): boolean => index === node.items.length ? next(at) : match(node.items[index]!, at, end => from(index + 1, end));
        return from(0, position);
      }
      case 'look': {
        const found = node.behind ? position > 0 && match(node.body, position - 1, end => end === position) : match(node.body, position, () => true);
        return found !== node.negative && next(position);
      }
      case 'rep': {
        if (!single(node.body)) throw new Error('REGEX_COST_UNSUPPORTED repetition of a multi-character body');
        // Greedy loop over a one-character body: consume as far as possible, then give characters back one at a time.
        let count = 0;
        while (count < node.max && match(node.body, position + count, () => true)) count++;
        for (; count >= node.min; count--) { steps++; if (next(position + count)) return true; }
        return false;
      }
    }
  };
  const matches: [number, number][] = [];
  for (let start = 0; start <= input.length;) {
    let end = -1;
    steps++;
    if (match(root, start, at => { end = at; return true; })) {
      matches.push([start, end]);
      if (mode === 'test') break;
      start = end > start ? end : start + 1;
    } else start++;
  }
  return { steps, matches };
}

/** The model's matches for `source` (the same spans V8 reports as `[index, index + match.length]`). */
export const modelMatches = (source: string, input: string) => backtrackingSteps(source, input, 'all').matches;

/**
 * A wall-time helper scaled by an independent CPU control (xorshift32 × 5 000 000, median of three, reference 6 ms, factor capped at 10),
 * the same calibration as the JSON Schema validator guards. Steps stay the primary assertion; this only bounds the real engine coarsely.
 */
export function calibratedBudgetMs(baseMs: number, label: string): number {
  const control = () => {
    let value = 0x5eed;
    for (let i = 0; i < 5_000_000; i++) { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; }
    return value;
  };
  expect(control()).toBe(-242512527);
  const samplesMs = Array.from({ length: 3 }, () => {
    const start = process.threadCpuUsage(), value = control(), used = process.threadCpuUsage(start);
    expect(value).toBe(-242512527);
    return (used.user + used.system) / 1_000;
  });
  const factor = Math.max(1, [...samplesMs].sort((a, b) => a - b)[1]! / 6);
  console.info('REGEX_COST_TIMING_CALIBRATION', JSON.stringify({ label, samplesMs, referenceMs: 6, baseMs, factor, budgetMs: baseMs * Math.min(factor, 10) }));
  expect(factor, 'REGEX_COST_TIMING_CALIBRATION_OVERLOADED: independent CPU control exceeds the bounded 10x range').toBeLessThanOrEqual(10);
  return baseMs * factor;
}
