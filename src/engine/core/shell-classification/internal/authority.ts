import { scanPosixCommand } from './scanner.js';
import { AWK_PROGRAMS, EVAL_PROGRAMS, INLINE_PROGRAM_FLAGS, INTERPRETER_PROGRAMS, PRIVILEGE_PROGRAMS, PRODUCT_AUTHORITY_COMMANDS, PRODUCT_PROGRAM_NAMES, PROGRAM_ALIASES, PTY_WRAPPER_PROGRAMS,
  SHELL_PROGRAMS, TRANSPARENT_PROGRAMS, XARGS_PROGRAMS } from './programs.js';
import { PACKAGE_PROGRAMS } from './mutation.js';

/** The product's authority subcommands as they appear in any command text (the program may be `deckent`, a path to it, `node …/entry.js` or `npx`). */
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const AUTHORITY_TEXT: readonly RegExp[] = Object.values(PRODUCT_AUTHORITY_COMMANDS).flatMap(groups => Object.entries(groups).map(([group, rule]) => {
  const actions = rule.actions.filter(Boolean).map(escapePattern).join('|');
  const words = `${group.split(' ').map(escapePattern).join('\\s+')}${actions ? rule.actions.includes('') ? `(?:\\s+(?:${actions}))?` : `\\s+(?:${actions})` : ''}`;
  const flags = rule.requiredFlags ? `\\b[^;&|\\n]*?\\s(?:${rule.requiredFlags.map(escapePattern).join('|')})\\b` : '\\b';
  const product = rule.bound ? `(?:^|[\\s;&|])(?:[^\\s;&|]*\\/)?(?:${PRODUCT_PROGRAM_NAMES.map(escapePattern).join('|')}|entry\\.[cm]?js)(?:@[^\\s;&|/]*)?\\s+` : '\\b';
  return new RegExp(`${product}${words}${flags}`, 'u');
}));
const LAUNCHERS = new Set([...PRODUCT_PROGRAM_NAMES, ...Object.keys(PRODUCT_AUTHORITY_COMMANDS), ...INTERPRETER_PROGRAMS, ...EVAL_PROGRAMS, ...PTY_WRAPPER_PROGRAMS, ...XARGS_PROGRAMS,
  ...PACKAGE_PROGRAMS, ...PRIVILEGE_PROGRAMS, ...TRANSPARENT_PROGRAMS]);
/** A prefix that hands its stdin to a later program word (`… | command bash`, `env -u X bash < f`). */
const HANDS_ON = new Set([...TRANSPARENT_PROGRAMS, ...PRIVILEGE_PROGRAMS, ...EVAL_PROGRAMS]);
/** Whether some later word is a shell or interpreter that reads its program from stdin (only options after it). */
const stdinInterpreterAfter = (args: readonly string[]) => args.some((arg, at) => readsProgramFromStdin(programName(arg), args.slice(at + 1)));
const PTY_WORD = new RegExp(`(?:^|[\\s;&|(\`$"'])(?:${[...PTY_WRAPPER_PROGRAMS].join('|')})(?=[\\s"']|$)`, 'u');
const programName = (word: string) => { const name = PROGRAM_ALIASES[word] ?? word; return (name.split('/').pop() ?? name).toLowerCase(); };
const names = (text: string) => AUTHORITY_TEXT.some(pattern => pattern.test(text));
/** alpha.56 FIX2b: the product program (a product name, its `entry.js`), also with a package runner's version/tag suffix (`npx deckent@latest`, `@scope/deckent@2`). */
const isProductProgram = (word: string) => { const name = programName(word).replace(/(?<=.)@[^@]*$/u, ''); return PRODUCT_PROGRAM_NAMES.includes(name) || /^entry\.[cm]?js$/u.test(name); };
/**
 * alpha.56 FIX2 (commit-security review of U5-S3): the product's authority commands decided on the decoded argv, so option words between the program
 * and its group/action (`deckent --lang en run resume`, `npx --yes deckent --json task reject`, `node …/entry.js --scope x run resume`) never hide one.
 * Every product program word in the stage (a product name, or the product's `entry.js`) starts a reading; options (`-x`, `--opt`, `--opt=value`) may
 * stand anywhere, and a word after a bare option is read both as its value and as a positional (fail closed: any reading that matches keeps the card).
 * This widens the text patterns above and never replaces them (N3-U5-3: the PRE-8 floor is not narrowed).
 */
const isOption = (word: string) => word.length > 1 && word.startsWith('-');
const PRODUCT_RULES = Object.values(PRODUCT_AUTHORITY_COMMANDS).flatMap(groups => Object.entries(groups).flatMap(([group, rule]) =>
  rule.actions.map(action => ({ words: [...group.split(' '), ...(action ? [action] : [])], flags: rule.requiredFlags }))));
function positionalsAt(args: readonly string[], expected: readonly string[], from: number): boolean {
  if (expected.length === 0) return true;
  for (let at = from; at < args.length; at++) {
    if (isOption(args[at]!)) continue;
    if (args[at] === expected[0] && positionalsAt(args, expected.slice(1), at + 1)) return true;
    // Not the expected word: it may still be the value of a bare option before it, otherwise it is the positional that decides.
    if (at === from || !isOption(args[at - 1]!) || args[at - 1]!.includes('=')) return false;
  }
  return false;
}
const productArgvRunsAuthority = (words: readonly string[]) => words.some((word, at) => {
  if (!isProductProgram(word)) return false;
  const args = words.slice(at + 1);
  return PRODUCT_RULES.some(rule => positionalsAt(args, rule.words, 0)
    && (!rule.flags || args.some(arg => rule.flags!.some(flag => arg === flag || arg.startsWith(`${flag}=`)))));
});

/**
 * Lead decision 2026-10-21 (PRE-8 finding, law audit MAJOR 2; owner rules "AI cannot approve", "the hard floor stays closed in full access"): whether a
 * shell command runs one of the product's authority commands — `secret grant|revoke|set|delete|handover|store`, `approval decide`, `init policy … --apply|--modes`
 * — directly, through the product's own entry, a launcher (interpreter, `-c` string, eval, package runner, privilege) or a pty wrapper (`script`, `unbuffer`,
 * `expect`: they forge the terminal witness). A pty wrapper whose payload cannot be read (an expansion), or a command the strict scanner cannot read that
 * names a pty wrapper, counts too: when it cannot be told what runs, the card stays. The answer is the `authority` tier — the `edit-authority` cell, kept in
 * full access. Text that only mentions the words (`echo`, a commit message) does not count. Defense in depth (lead 2026-10-26, AUDIT-3DEC D3): `false`
 * means not recognised, never safe; the boundary is semantic policy/approval plus enforced sandbox and socket custody.
 */
export function classifyShellAuthority(command: string): boolean {
  return typeof command === 'string' && command.length > 0 && runsAuthority(command, 0);
}
/**
 * Astra REVISE 2706 (lead decision): an interpreter's inline program is not a shell argv. It keeps the floor when, normalised to lower-case
 * alphanumerics, it names the product (`deckent`, `deckent-mcp`) or an authority word pair (`secretgrant`, `approvaldecide`, `initpolicy`, …);
 * otherwise the normal mode rules apply. Program text built from character codes or encodings is not recognised (known limit; the open sandbox and
 * the vault floor remain the boundary).
 */
const normalised = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/gu, '');
const PRODUCT_MARKS: readonly string[] = Object.freeze([...PRODUCT_PROGRAM_NAMES.map(normalised),
  ...Object.values(PRODUCT_AUTHORITY_COMMANDS).flatMap(groups => Object.entries(groups).flatMap(([group, rule]) => rule.actions.map(action => normalised(`${group}${action}`)))),
  normalised('approval decide'), normalised('init policy')]);
const INLINE_INTERPRETER = (name: string) => (INTERPRETER_PROGRAMS.has(name) && !SHELL_PROGRAMS.has(name)) || AWK_PROGRAMS.has(name);
/** The inline programs of an interpreter word at `at` (its flag's operand, an attached `-e…`, awk's first operand); none for a program file. */
function inlinePrograms(words: readonly string[], at: number): readonly string[] {
  const name = programName(words[at]!), args = words.slice(at + 1), out: string[] = [];
  if (AWK_PROGRAMS.has(name)) { const program = args.find((arg, index) => !arg.startsWith('-') && !['-F', '-v', '-f'].includes(args[index - 1] ?? '')); return program ? [program] : []; }
  args.forEach((arg, index) => { const operand = inlineOperand(arg, args[index + 1]); if (operand !== null) out.push(operand); });
  return out;
}
/**
 * Astra REVISE 2708: the ONE operand rule of every inline-program option — the separate word (`--eval CODE`, `-e CODE`), the long `--opt=CODE` and
 * the attached short `-eCODE` are the same program. Null when the word is not an inline-program option.
 */
function inlineOperand(arg: string, next: string | undefined): string | null {
  if (INLINE_PROGRAM_FLAGS.has(arg)) return next ?? null;
  const equals = arg.indexOf('=');
  if (arg.startsWith('--') && equals > 2) return INLINE_PROGRAM_FLAGS.has(arg.slice(0, equals)) ? arg.slice(equals + 1) : null;
  return /^-[ecrEpx]./u.test(arg) && !arg.startsWith('--') ? arg.slice(2) : null;
}
/** Whether any interpreter in the stage (at the head, or after transparent prefixes) runs an inline program that names the product. */
const inlineNamesProduct = (words: readonly string[]) => words.some((word, at) => (at === 0 || LAUNCHERS.has(programName(words[0]!))) && INLINE_INTERPRETER(programName(word))
  && inlinePrograms(words, at).some(program => PRODUCT_MARKS.some(mark => normalised(program).includes(mark))));

/** Nested shell strings decoded at most this deep; deeper is not decoded: the card stays. */
const PAYLOAD_DEPTH = 4;
/** Decoding the shell would do but the strict scanner does not: ANSI-C/locale quoting (`$'…'`, `$"…"`), brace expansion, globbing. */
const UNDECODED = /\$['"]|\{[^{}]*(?:,|\.\.)[^{}]*\}/u;
/** A glob turns into file names the scanner does not know (`deckent s*t grant`, `unbuffer deckent [s]ecret grant`): undecoded in any launcher argument. */
const GLOB = /[*?[]/u;
/** A word another shell (or `expect`) may parse again: quotes, escapes, separators or blanks inside it. */
const REPARSED = /[\s'"\\;&|<>()`$]/u;
/** A redirection token (`3<>/dev/tcp/…`, `>&3`, `2>`, `<<<`); a bare operator also takes the next token as its target. */
const REDIRECTION = /^\d*(?:<>|>>|>&|<&|&>|>\||<<<|<<|[<>])/u, BARE_REDIRECTION = /^\d*(?:<>|>>|>&|<&|&>|>\||<<<|<<|[<>])$/u;
/** Reads its program from stdin when it has no non-option argument (`… | bash`, `… | sh -s`). */
const readsProgramFromStdin = (name: string, args: readonly string[]) => INTERPRETER_PROGRAMS.has(name) && args.every(arg => arg.startsWith('-'));
/**
 * The undecodable fallback (the strict scanner refused the command): whether some command position really launches a program through a launcher —
 * a launcher word followed by a program word (redirections removed: `exec 3<>/dev/tcp/…` only opens a descriptor, runs nothing), or a shell that
 * reads its program from a pipe. Tokens are cut on the shell's separators; quotes and escapes are dropped from the head only to name it.
 */
function launchesProgram(command: string): boolean {
  for (const list of command.split(/\|\||&&|[;&\n()]/u)) {
    for (const [index, stage] of list.split('|').entries()) {
      const tokens: string[] = [], raw = stage.trim().split(/\s+/u).filter(Boolean);
      for (let at = 0; at < raw.length; at++) { if (REDIRECTION.test(raw[at]!)) { if (BARE_REDIRECTION.test(raw[at]!)) at++; continue; } tokens.push(raw[at]!); }
      while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[0]!)) tokens.shift();
      const name = tokens.length ? programName(tokens[0]!.replace(/['"\\]/gu, '')) : '';
      if (!LAUNCHERS.has(name) && !isProductProgram(name)) continue;
      // Fail closed: any launcher at a command position keeps the card — except a redirection-only `exec` (it opens descriptors, runs nothing).
      if (name !== 'exec' || tokens.length > 1 || index > 0) return true;
    }
  }
  return false;
}
/**
 * Astra REVISE 2702 P1-A: a stage run by the product or a launcher is decided on its decoded argv (the scanner's quote removal), and every argument
 * another shell may parse again (a `-c` string, `script -c`, `watch`, `expect -c`, …) is decoded the same way, recursively. Whatever the scanner
 * cannot decode exactly as the shell would — an expansion or a substitution (the scanner refuses it), `$'…'`, brace expansion, a glob, or nesting
 * past `PAYLOAD_DEPTH` — keeps the card when a launcher or the product runs it.
 */
function runsAuthority(command: string, depth: number): boolean {
  const scan = scanPosixCommand(command);
  if (!scan.ok) return launchesProgram(command) || names(command) || PTY_WORD.test(command);
  for (const [index, stage] of scan.pipelines.flatMap(pipeline => pipeline.map((each, at) => [at, each] as const))) {
    const head = stage.words[0];
    if (!head) continue;
    if (inlineNamesProduct(stage.words.map(word => word.text))) return true;
    // A stage headed by the product itself (a path, its entry script, a suffixed name) is decided like a launcher's (FIX2b, fail closed).
    if (!LAUNCHERS.has(programName(head.text)) && !isProductProgram(head.text)) continue;
    const rest = stage.words.slice(1);
    // A shell fed by a pipe runs whatever the pipe carries: never decoded here, the card stays.
    // An input redirection (`<`, `0<`, a here-document) feeds the program the same way.
    const argv = rest.map(word => word.text), fed = index > 0 || stage.inputPaths.length > 0;
    if (fed && (readsProgramFromStdin(programName(head.text), argv) || (HANDS_ON.has(programName(head.text)) && stdinInterpreterAfter(argv)))) return true;
    // `expect` runs Tcl, not a shell: its payload is never decoded here, so it always keeps the card.
    if (programName(head.text) === 'expect') return true;
    if (names(stage.words.map(word => word.text).join(' ')) || productArgvRunsAuthority(stage.words.map(word => word.text))) return true;
    // `$` the scanner kept (`$'…'`), brace expansion or a glob: the shell would run another argv than the one decoded here.
    if (rest.some(word => !word.quoted && UNDECODED.test(word.text)) || rest.some(word => word.text.includes('$'))) return true;
    if (rest.some(word => !word.quoted && GLOB.test(word.text))) return true;
    for (const word of rest) {
      if (!REPARSED.test(word.text)) continue;
      if (depth + 1 >= PAYLOAD_DEPTH || runsAuthority(word.text, depth + 1)) return true;
    }
  }
  return false;
}
