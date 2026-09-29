/**
 * Linear-time matcher for JSON Schema `pattern` / `patternProperties` (MCP-SCHEMA-VALIDATOR, owner 2026-09-29).
 *
 * A remote MCP server controls both a pinned `outputSchema.pattern` and the instance it answers with; a backtracking engine (V8 Irregexp,
 * as used by ajv and @cfworker) blocked the process for 1.44 s on a 27-character input (`^(a+)+$`). This engine answers the only question
 * JSON Schema asks — does the pattern match somewhere in the string (never implicitly anchored, 2020-12 Core §6.4) — by Thompson-NFA
 * simulation over code points: O(|input| × |program|) and every visited state is charged to the caller's step budget.
 *
 * The pattern is first compiled (never executed) by `new RegExp(pattern, 'u')`, so only valid u-mode syntax reaches the parser. The parser owns
 * control flow: sequence, `|`, groups (capturing, `(?:…)`, named — all plain), quantifiers `* + ? {n} {n,} {n,m}` and their lazy forms (for a
 * boolean match lazy ≡ greedy), `^ $` (never multiline) and `\b \B` (ASCII word characters). Every single-code-point atom (`.`, `[…]`, `\d \w \s`
 * and negations, `\p{…}`, character escapes) keeps V8's exact meaning: its source alone is compiled as `^(?:atom)$` with `u` and tested on one
 * code point, which is constant time (no quantifier, no backtracking). Refused before any matching: backreferences, lookaround, pattern
 * modifiers, and programs above the size limits.
 */

/** Why a pattern cannot be used: invalid ECMA-262 u-mode syntax, a construct this engine does not run in linear time, or a size limit. */
export type PatternRefusalReason = 'invalid-pattern' | 'unsupported-pattern' | 'limit';
export class PatternRefusal extends Error {
  constructor(readonly reason: PatternRefusalReason, message: string) { super(message); this.name = 'PatternRefusal'; }
}
/** Thrown when a match exhausts the step budget shared with the rest of a validation (the caller turns it into a fail-closed result). */
export class StepBudgetExceeded extends Error {
  constructor() { super('validation step budget exceeded'); this.name = 'StepBudgetExceeded'; }
}
export interface StepBudget { remaining: number }
export interface PatternLimits { readonly sourceMax: number; readonly statesMax: number; readonly repeatMax: number }
export interface LinearPattern { readonly source: string; readonly states: number; test(input: string, budget: StepBudget): boolean }

type Node =
  | { readonly t: 'atom'; readonly atom: number }
  | { readonly t: 'assert'; readonly kind: number }
  | { readonly t: 'seq'; readonly items: readonly Node[] }
  | { readonly t: 'alt'; readonly items: readonly Node[] }
  | { readonly t: 'rep'; readonly node: Node; readonly min: number; readonly max: number };

const BOL = 0, EOL = 1, WORD_BOUNDARY = 2, NOT_WORD_BOUNDARY = 3;
const CHAR = 0, SPLIT = 1, JMP = 2, ASSERT = 3, MATCH = 4;
const HEX = /^[0-9A-Fa-f]$/u;
const NON_ASCII_CACHE_MAX = 1_024;
/** Budget steps are ≈ 10 ns units (calibrated in proof/MCP-SCHEMA-VALIDATOR-2026-09-29/logs/budget-bench-*.json). */
const NATIVE_TEST_STEPS = 4;
/** Parser and generator recurse per group level; bounded far below the call-stack limit. */
const GROUP_DEPTH_MAX = 64;

/** One single-code-point matcher: a literal code point, or an atom source whose meaning V8 decides on one code point at a time. */
class Atom {
  private readonly ascii = new Int8Array(128).fill(-1);
  private readonly other = new Map<number, boolean>();
  private readonly native: RegExp | null;
  constructor(readonly literal: number, source: string) {
    this.native = literal >= 0 ? null : new RegExp(`^(?:${source})$`, 'u');
  }
  /** An uncached V8 test (≈ 37 ns measured) is charged {@link NATIVE_TEST_STEPS}; a simulation state visit (≈ 4–10 ns) is one step. */
  matches(cp: number, budget: StepBudget): boolean {
    if (this.literal >= 0) return cp === this.literal;
    if (cp < 128) {
      const known = this.ascii[cp]!;
      if (known >= 0) return known === 1;
      budget.remaining -= NATIVE_TEST_STEPS;
      const value = this.native!.test(String.fromCharCode(cp));
      this.ascii[cp] = value ? 1 : 0;
      return value;
    }
    const known = this.other.get(cp);
    if (known !== undefined) return known;
    budget.remaining -= NATIVE_TEST_STEPS;
    const value = this.native!.test(String.fromCodePoint(cp));
    if (this.other.size < NON_ASCII_CACHE_MAX) this.other.set(cp, value);
    return value;
  }
}

class Parser {
  private i = 0;
  private depth = 0;
  readonly atoms: Atom[] = [];
  private readonly atomIds = new Map<string, number>();
  constructor(private readonly src: string, private readonly limits: PatternLimits) {}
  parse(): Node {
    const node = this.alternation();
    if (this.i < this.src.length) throw new PatternRefusal('invalid-pattern', `unbalanced ')' at ${this.i}`);
    return node;
  }
  private alternation(): Node {
    const items = [this.sequence()];
    while (this.src[this.i] === '|') { this.i++; items.push(this.sequence()); }
    return items.length === 1 ? items[0]! : { t: 'alt', items };
  }
  private sequence(): Node {
    const items: Node[] = [];
    while (this.i < this.src.length && this.src[this.i] !== '|' && this.src[this.i] !== ')') items.push(this.quantified(this.term()));
    return items.length === 1 ? items[0]! : { t: 'seq', items };
  }
  private term(): Node {
    const c = this.src[this.i]!;
    if (c === '^') { this.i++; return { t: 'assert', kind: BOL }; }
    if (c === '$') { this.i++; return { t: 'assert', kind: EOL }; }
    if (c === '(') return this.group();
    if (c === '[') return this.atom(this.i, this.classEnd(this.i));
    if (c === '\\') {
      const e = this.src[this.i + 1];
      if (e === 'b' || e === 'B') { this.i += 2; return { t: 'assert', kind: e === 'b' ? WORD_BOUNDARY : NOT_WORD_BOUNDARY }; }
      if (e !== undefined && e >= '1' && e <= '9') throw new PatternRefusal('unsupported-pattern', 'backreference');
      if (e === 'k') throw new PatternRefusal('unsupported-pattern', 'named backreference');
      return this.atom(this.i, this.escapeEnd(this.i));
    }
    const cp = this.src.codePointAt(this.i)!;
    const end = this.i + (cp > 0xffff ? 2 : 1);
    if (c === '.') return this.atom(this.i, end);
    this.i = end;
    return this.literal(cp);
  }
  private group(): Node {
    let start = this.i + 1;
    if (this.src[start] === '?') {
      const next = this.src[start + 1];
      if (next === ':') start += 2;
      else if (next === '<' && this.src[start + 2] !== '=' && this.src[start + 2] !== '!') {
        const close = this.src.indexOf('>', start);
        start = close + 1;
      } else if (next === '=' || next === '!' || next === '<') throw new PatternRefusal('unsupported-pattern', 'lookaround');
      else throw new PatternRefusal('unsupported-pattern', 'pattern modifier group');
    }
    if (++this.depth > GROUP_DEPTH_MAX) throw new PatternRefusal('limit', `groups nested deeper than ${GROUP_DEPTH_MAX}`);
    this.i = start;
    const inner = this.alternation();
    if (this.src[this.i] !== ')') throw new PatternRefusal('invalid-pattern', 'unterminated group');
    this.i++; this.depth--;
    return inner;
  }
  /** End (exclusive) of the escape at `at` (`\` included), in u-mode: `\u{…}`, `\uHHHH` (a surrogate pair of two is one code point), `\xHH`,
   * `\cX`, `\p{…}`/`\P{…}`, otherwise one character. */
  private escapeEnd(at: number): number {
    const e = this.src[at + 1];
    if (e === undefined) throw new PatternRefusal('invalid-pattern', 'trailing backslash');
    if ((e === 'u' && this.src[at + 2] === '{') || e === 'p' || e === 'P') {
      const close = this.src.indexOf('}', at);
      if (close < 0) throw new PatternRefusal('invalid-pattern', 'unterminated escape');
      return close + 1;
    }
    if (e === 'u') {
      const unit = parseInt(this.src.slice(at + 2, at + 6), 16);
      if (unit >= 0xd800 && unit <= 0xdbff && this.src.startsWith('\\u', at + 6)) {
        const trail = this.src.slice(at + 8, at + 12);
        const low = [...trail].every(ch => HEX.test(ch)) && trail.length === 4 ? parseInt(trail, 16) : -1;
        if (low >= 0xdc00 && low <= 0xdfff) return at + 12;
      }
      return at + 6;
    }
    if (e === 'x') return at + 4;
    if (e === 'c') return at + 3;
    return at + 1 + (this.src.codePointAt(at + 1)! > 0xffff ? 2 : 1);
  }
  /** End (exclusive) of the class starting at `at`: the first unescaped `]` after `[` / `[^` (u-mode has no nested classes; `[]` is empty). */
  private classEnd(at: number): number {
    let j = at + 1;
    if (this.src[j] === '^') j++;
    while (j < this.src.length && this.src[j] !== ']') j = this.src[j] === '\\' ? this.escapeEnd(j) : j + 1;
    if (j >= this.src.length) throw new PatternRefusal('invalid-pattern', 'unterminated class');
    return j + 1;
  }
  private atom(start: number, end: number): Node {
    this.i = end;
    const source = this.src.slice(start, end);
    let id = this.atomIds.get(source);
    if (id === undefined) { id = this.atoms.push(new Atom(-1, source)) - 1; this.atomIds.set(source, id); }
    return { t: 'atom', atom: id };
  }
  private literal(cp: number): Node {
    const key = `#${cp}`;
    let id = this.atomIds.get(key);
    if (id === undefined) { id = this.atoms.push(new Atom(cp, '')) - 1; this.atomIds.set(key, id); }
    return { t: 'atom', atom: id };
  }
  private quantified(node: Node): Node {
    let min: number, max: number;
    const c = this.src[this.i];
    if (c === '*') { min = 0; max = Infinity; this.i++; }
    else if (c === '+') { min = 1; max = Infinity; this.i++; }
    else if (c === '?') { min = 0; max = 1; this.i++; }
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/u.exec(this.src.slice(this.i, this.i + 32));
      if (!m) throw new PatternRefusal('invalid-pattern', 'bad quantifier');
      min = Number(m[1]); max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      if (min > this.limits.repeatMax || (max !== Infinity && max > this.limits.repeatMax))
        throw new PatternRefusal('limit', `repetition bound above ${this.limits.repeatMax}`);
      this.i += m[0].length;
    } else return node;
    if (this.src[this.i] === '?') this.i++;
    return { t: 'rep', node, min, max };
  }
}

/** Instruction arrays of the compiled program (Pike-VM layout: CHAR atom, SPLIT a b, JMP a, ASSERT kind, MATCH). */
class Program {
  op: number[] = []; a: number[] = []; b: number[] = [];
  constructor(private readonly statesMax: number) {}
  emit(op: number, a = 0, b = 0): number {
    if (this.op.length >= this.statesMax) throw new PatternRefusal('limit', `pattern program above ${this.statesMax} states`);
    this.op.push(op); this.a.push(a); this.b.push(b);
    return this.op.length - 1;
  }
  gen(node: Node): void {
    switch (node.t) {
      case 'atom': this.emit(CHAR, node.atom); return;
      case 'assert': this.emit(ASSERT, node.kind); return;
      case 'seq': for (const item of node.items) this.gen(item); return;
      case 'alt': {
        const jumps: number[] = [];
        node.items.forEach((item, k) => {
          if (k === node.items.length - 1) { this.gen(item); return; }
          const split = this.emit(SPLIT);
          this.a[split] = split + 1;
          this.gen(item);
          jumps.push(this.emit(JMP));
          this.b[split] = this.op.length;
        });
        for (const jump of jumps) this.a[jump] = this.op.length;
        return;
      }
      case 'rep': {
        for (let k = 0; k < node.min; k++) this.gen(node.node);
        if (node.max === Infinity) {
          const split = this.emit(SPLIT);
          this.a[split] = split + 1;
          this.gen(node.node);
          this.emit(JMP, split);
          this.b[split] = this.op.length;
          return;
        }
        const exits: number[] = [];
        for (let k = node.min; k < node.max; k++) {
          const split = this.emit(SPLIT);
          this.a[split] = split + 1;
          exits.push(split);
          this.gen(node.node);
        }
        for (const split of exits) this.b[split] = this.op.length;
      }
    }
  }
}

const isWord = (cp: number) => (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95;

/** Compiles `source` (ECMA-262, u-mode) to a linear-time unanchored matcher, or throws a typed {@link PatternRefusal}. */
export function compilePattern(source: string, limits: PatternLimits): LinearPattern {
  if (source.length > limits.sourceMax) throw new PatternRefusal('limit', `pattern longer than ${limits.sourceMax}`);
  try { new RegExp(source, 'u'); } catch (error) { throw new PatternRefusal('invalid-pattern', (error as Error).message); }
  const parser = new Parser(source, limits), tree = parser.parse(), program = new Program(limits.statesMax);
  program.gen(tree);
  program.emit(MATCH);
  const { op, a, b } = program, atoms = parser.atoms, size = op.length;
  // Reused by every `test` (synchronous, never re-entered): marks per position generation, the closure stack and the two thread lists.
  const marks = new Int32Array(size), stack = new Int32Array(size * 2 + 2);
  let current = new Int32Array(size + 1), following = new Int32Array(size + 1), generation = 0;
  /** Adds `pc` and its ε-closure at the current position to `list` (size in `list[size]`); true when MATCH is reached. */
  const add = (list: Int32Array, pc0: number, prev: number, next: number, budget: StepBudget): boolean => {
    let top = 0;
    stack[top++] = pc0;
    while (top > 0) {
      const pc = stack[--top]!;
      if (marks[pc] === generation) continue;
      marks[pc] = generation;
      if (--budget.remaining < 0) throw new StepBudgetExceeded();
      switch (op[pc]) {
        case CHAR: list[list[size]!++] = pc; break;
        case MATCH: return true;
        case JMP: stack[top++] = a[pc]!; break;
        case SPLIT: stack[top++] = b[pc]!; stack[top++] = a[pc]!; break;
        case ASSERT: {
          const kind = a[pc]!;
          const holds = kind === BOL ? prev < 0 : kind === EOL ? next < 0
            : (isWord(prev) !== isWord(next)) === (kind === WORD_BOUNDARY);
          if (holds) stack[top++] = pc + 1;
        }
      }
    }
    return false;
  };
  return {
    source, states: size,
    test(input: string, budget: StepBudget): boolean {
      if (generation > 0x3fffffff) { marks.fill(0); generation = 0; }
      current[size] = 0;
      // The previous code point of position 0 is none (-1); inside the loop it is the code point just consumed.
      let i = 0, next = input.length > 0 ? input.codePointAt(0)! : -1;
      generation++;
      if (add(current, 0, -1, next, budget)) return true;
      while (i < input.length) {
        const cp = next, width = cp > 0xffff ? 2 : 1, after = i + width < input.length ? input.codePointAt(i + width)! : -1;
        generation++;
        following[size] = 0;
        for (let k = 0; k < current[size]!; k++) {
          const pc = current[k]!;
          if (--budget.remaining < 0) throw new StepBudgetExceeded();
          if (atoms[a[pc]!]!.matches(cp, budget) && add(following, pc + 1, cp, after, budget)) return true;
        }
        if (add(following, 0, cp, after, budget)) return true;
        [current, following] = [following, current];
        i += width; next = after;
      }
      return false;
    },
  };
}
