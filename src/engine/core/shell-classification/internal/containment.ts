import { EVAL_PROGRAMS, INTERPRETER_PROGRAMS, PRIVILEGE_PROGRAMS, PROGRAM_ALIASES, XARGS_PROGRAMS } from './programs.js';
import { NETWORK_PROGRAMS, PACKAGE_PROGRAMS } from './mutation.js';
import { scanShell, shellWords } from './risk.js';
import type { ShellDialect } from './classify.js';

/**
 * Whether a command may run without a card inside an enforced sandbox (SHELL-AUTONOMY, owner 2026-09-28). There the realm draws the
 * boundary — no network, HOME hidden, `.git` and the write floor read-only, the product state masked — so a command the strict
 * classifier cannot bound (compound, variable or command expansion, a path outside the project) no longer needs one. What still
 * keeps the card is decided over every part the lenient scanner exposes, command substitutions included:
 * - the program floor: privilege, interpreters, eval-like wrappers, xargs, package managers, network tools, `env <program>` and
 *   `find -exec`-style actions (checkpoint C1: an intent filter, not a boundary — the sandbox is the boundary); `tee` is not on it
 *   (it writes files like a redirection does, and the realm bounds both);
 * - a program word that is not a plain name (`$x`, `$(…)`, a path such as `./x`): it could be any of the above;
 * - a process substitution (`<(…)`, `>(…)`), whose inside the lenient scanner does not expose, and anything it cannot parse;
 * - a word that names a protected path (the write floor, the product state): the realm keeps existing floor paths read-only, but a
 *   floor path that does not exist yet can only be seen by name. Owner 2026-10-18 ("okuma kartı kalksın", Jev 5e6dd7aa): `readOnlyFloor`
 *   names the floor paths the run's own view binds read-only and readable (the caller passes it only then: an enforced sandbox, an
 *   unattended posture, never the product state); such a name is no reason for a card when a read-only program reads it as a plain
 *   argument — never as a redirection target or an option's value, never for any other program (a write, rename or delete still asks).
 * The destructive table is not here: its only owner is the risk tier (`shell-destructive`), which no mode lowers.
 */
export type ShellContainmentReason = 'CONTAINED' | 'PROGRAM_FLOOR' | 'PROGRAM_UNKNOWN' | 'PROCESS_SUBSTITUTION' | 'PROTECTED_NAME' | 'UNPARSEABLE'
  | 'EMPTY_COMMAND' | 'UNSUPPORTED_DIALECT';
export interface ShellContainmentVerdict { readonly contained: boolean; readonly reasonCode: ShellContainmentReason; readonly detail?: string }

const SUBSTITUTION = '__shell_substitution__';
/** Words before a pipeline's program: shell keywords, group openers and assignments. */
const KEYWORDS: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'in', 'esac', 'select', '!', '{', '}']);
const TEST_PROGRAMS: ReadonlySet<string> = new Set(['[', '[[', ':']);
const PLAIN_PROGRAM = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/u;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const FIND_ACTIONS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const REDIRECTION = /^(?:\d*|&)(?:>>|>\||>&|>|<)/u;
/** Security re-review of 03d82341 (fail closed): the tolerance holds only for a plain path word (no expansion, quoting residue or option)
 * right after a word without `<`/`>` (any redirection form: `<>`, `{fd}>`, `n>|`, an escaped `\>`), and never in a command that may change
 * what a program name resolves to or how the shell reads it (an assignment such as `PATH=`, aliases, functions, `hash`, `enable`, …). */
const PLAIN_PATH = /^[A-Za-z0-9_./@+][A-Za-z0-9_./@+-]*$/u;
const RESOLUTION_CHANGERS: ReadonlySet<string> = new Set(['alias', 'unalias', 'function', 'hash', 'enable', 'shopt', 'set', 'unset', 'export', 'declare', 'typeset', 'readonly',
  'local', 'trap']);
/** Programs that only read the files they are given (no option of theirs writes one): a read-only floor name may be their argument. */
const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set(['cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'ls', 'stat', 'diff', 'cmp', 'cut', 'nl', 'od', 'md5sum', 'sha1sum', 'sha256sum', 'jq']);
const verdict = (contained: boolean, reasonCode: ShellContainmentReason, detail?: string): ShellContainmentVerdict =>
  Object.freeze(detail === undefined ? { contained, reasonCode } : { contained, reasonCode, detail });
const onProgramFloor = (name: string) => PRIVILEGE_PROGRAMS.has(name) || INTERPRETER_PROGRAMS.has(name) || EVAL_PROGRAMS.has(name) || XARGS_PROGRAMS.has(name)
  || PACKAGE_PROGRAMS.has(name) || NETWORK_PROGRAMS.has(name);

export function classifyShellContainment(command: string, protectedName: (path: string) => boolean, dialect: ShellDialect = 'posix',
  readOnlyFloor?: (path: string) => boolean): ShellContainmentVerdict {
  if (dialect !== 'posix') return verdict(false, 'UNSUPPORTED_DIALECT', dialect);
  if (typeof command !== 'string' || command.trim().length === 0) return verdict(false, 'EMPTY_COMMAND');
  const scan = scanShell(command);
  if (scan.malformed) return verdict(false, 'UNPARSEABLE');
  if (scan.segments.length === 0) return verdict(false, 'EMPTY_COMMAND');
  const changes = scan.segments.some(segment => (shellWords(segment) ?? ['(']).some((word, at, all) => ASSIGNMENT.test(word) || word.includes('(')
    || (RESOLUTION_CHANGERS.has(word) && all.slice(0, at).every(prior => KEYWORDS.has(prior)))));
  const floorRead = changes ? undefined : readOnlyFloor;
  for (const segment of scan.segments) {
    const words = shellWords(segment);
    if (!words) return verdict(false, 'UNPARSEABLE');
    const substitution = words.find(word => word.includes('<(') || word.includes('>('));
    if (substitution !== undefined) return verdict(false, 'PROCESS_SUBSTITUTION', substitution);
    let index = 0;
    while (index < words.length && (KEYWORDS.has(words[index]!) || ASSIGNMENT.test(words[index]!) || /^[({]+$/u.test(words[index]!))) index++;
    const raw = words[index];
    let reader = false;
    // A `case` arm's program follows its pattern (`case x in a) python;;`): not read here, so the construct asks.
    if (raw === 'case') return verdict(false, 'PROGRAM_UNKNOWN', 'case');
    if (raw !== undefined) {
      const head = raw.replace(/^[({]+/u, '').replace(/\)+$/u, ''), args = words.slice(index + 1);
      if (!TEST_PROGRAMS.has(head) && (head.includes(SUBSTITUTION) || !PLAIN_PROGRAM.test(head))) return verdict(false, 'PROGRAM_UNKNOWN', head);
      const name = (PROGRAM_ALIASES[head] ?? head).toLowerCase();
      if (onProgramFloor(name)) return verdict(false, 'PROGRAM_FLOOR', name);
      if (name === 'env' && args.some(arg => !arg.startsWith('-') && !ASSIGNMENT.test(arg))) return verdict(false, 'PROGRAM_FLOOR', 'env');
      if (name === 'find' && args.some(arg => FIND_ACTIONS.has(arg))) return verdict(false, 'PROGRAM_FLOOR', 'find');
      reader = READ_ONLY_PROGRAMS.has(name);
    }
    for (const [position, word] of words.entries()) {
      const value = pathOfWord(word);
      if (value === null || !protectedName(value)) continue;
      const read = reader && position > index && value === word && PLAIN_PATH.test(word) && !/[<>]/u.test(words[position - 1] ?? '') && floorRead?.(value) === true;
      if (!read) return verdict(false, 'PROTECTED_NAME', value);
    }
  }
  return verdict(true, 'CONTAINED');
}

/** The path a word may name, as the containment check reads it: a redirection's target, an option's `=value`, or the word itself; null
 * when it is empty or holds a command substitution. */
function pathOfWord(word: string): string | null {
  const path = word.replace(REDIRECTION, ''), value = path.startsWith('-') && path.includes('=') ? path.slice(path.indexOf('=') + 1) : path;
  return value.length > 0 && !value.includes(SUBSTITUTION) ? value : null;
}

/**
 * The words of a command (every part the lenient scanner exposes) that name a path `matches` accepts, in order and without repeats — the
 * same reading as the containment check's protected names. B3 (owner test 2026-10-07): a sandboxed command that failed on a read-only
 * protected path is explained by name. Words only: what a variable or glob expands to is not seen.
 */
export function shellNamedPaths(command: string, matches: (path: string) => boolean): readonly string[] {
  const named: string[] = [];
  for (const segment of scanShell(command).segments) {
    for (const word of shellWords(segment) ?? []) {
      const value = pathOfWord(word);
      if (value !== null && !named.includes(value) && matches(value)) named.push(value);
    }
  }
  return Object.freeze(named);
}
