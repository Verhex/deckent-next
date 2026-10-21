import { scanPosixCommand } from './scanner.js';
import { AWK_PROGRAMS, EVAL_PROGRAMS, INLINE_PROGRAM_FLAGS, INTERPRETER_PROGRAMS, PRIVILEGE_PROGRAMS, PRODUCT_AUTHORITY_COMMANDS, PRODUCT_PROGRAM_NAMES, PROGRAM_ALIASES, PTY_WRAPPER_PROGRAMS,
  SHELL_PROGRAMS, TRANSPARENT_PROGRAMS, XARGS_PROGRAMS } from './programs.js';
import { PACKAGE_PROGRAMS } from './mutation.js';

/** The product's authority subcommands as they appear in any command text (the program may be `deckent`, a path to it, `node …/entry.js` or `npx`). */
const AUTHORITY_TEXT: readonly RegExp[] = [/\bsecret\s+(?:grant|revoke|set|delete|handover|store)\b/u, /\bapproval\s+decide\b/u, /\binit\s+policy\b[^;&|\n]*?\s--(?:apply|modes)\b/u];
const LAUNCHERS = new Set([...Object.keys(PRODUCT_AUTHORITY_COMMANDS), ...INTERPRETER_PROGRAMS, ...EVAL_PROGRAMS, ...PTY_WRAPPER_PROGRAMS, ...XARGS_PROGRAMS,
  ...PACKAGE_PROGRAMS, ...PRIVILEGE_PROGRAMS, ...TRANSPARENT_PROGRAMS]);
/** A prefix that hands its stdin to a later program word (`… | command bash`, `env -u X bash < f`). */
const HANDS_ON = new Set([...TRANSPARENT_PROGRAMS, ...PRIVILEGE_PROGRAMS, ...EVAL_PROGRAMS]);
/** Whether some later word is a shell or interpreter that reads its program from stdin (only options after it). */
const stdinInterpreterAfter = (args: readonly string[]) => args.some((arg, at) => readsProgramFromStdin(programName(arg), args.slice(at + 1)));
const PTY_WORD = new RegExp(`(?:^|[\\s;&|(\`$"'])(?:${[...PTY_WRAPPER_PROGRAMS].join('|')})(?=[\\s"']|$)`, 'u');
const programName = (word: string) => { const name = PROGRAM_ALIASES[word] ?? word; return (name.split('/').pop() ?? name).toLowerCase(); };
const names = (text: string) => AUTHORITY_TEXT.some(pattern => pattern.test(text));

/**
 * Lead decision 2026-10-21 (PRE-8 finding, law audit MAJOR 2; owner rules "AI cannot approve", "the hard floor stays closed in full access"): whether a
 * shell command runs one of the product's authority commands — `secret grant|revoke|set|delete|handover|store`, `approval decide`, `init policy … --apply|--modes`
 * — directly, through the product's own entry, a launcher (interpreter, `-c` string, eval, package runner, privilege) or a pty wrapper (`script`, `unbuffer`,
 * `expect`: they forge the terminal witness). A pty wrapper whose payload cannot be read (an expansion), or a command the strict scanner cannot read that
 * names a pty wrapper, counts too: when it cannot be told what runs, the card stays. The answer is the `authority` tier — the `edit-authority` cell, kept in
 * full access. Text that only mentions the words (`echo`, a commit message) does not count.
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
  ...Object.values(PRODUCT_AUTHORITY_COMMANDS).flatMap(groups => Object.entries(groups).flatMap(([group, actions]) => actions.map(action => normalised(`${group}${action}`)))),
  normalised('approval decide'), normalised('init policy')]);
const INLINE_INTERPRETER = (name: string) => (INTERPRETER_PROGRAMS.has(name) && !SHELL_PROGRAMS.has(name)) || AWK_PROGRAMS.has(name);
/** The inline programs of an interpreter word at `at` (its flag's operand, an attached `-e…`, awk's first operand); none for a program file. */
function inlinePrograms(words: readonly string[], at: number): readonly string[] {
  const name = programName(words[at]!), args = words.slice(at + 1), out: string[] = [];
  if (AWK_PROGRAMS.has(name)) { const program = args.find((arg, index) => !arg.startsWith('-') && !['-F', '-v', '-f'].includes(args[index - 1] ?? '')); return program ? [program] : []; }
  args.forEach((arg, index) => {
    if (INLINE_PROGRAM_FLAGS.has(arg) && args[index + 1] !== undefined) out.push(args[index + 1]!);
    else if (/^-[ecrEpx]./u.test(arg) && !arg.startsWith('--')) out.push(arg.slice(2));
  });
  return out;
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
      if (!LAUNCHERS.has(name)) continue;
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
    if (!LAUNCHERS.has(programName(head.text))) continue;
    const rest = stage.words.slice(1);
    // A shell fed by a pipe runs whatever the pipe carries: never decoded here, the card stays.
    // An input redirection (`<`, `0<`, a here-document) feeds the program the same way.
    const argv = rest.map(word => word.text), fed = index > 0 || stage.inputPaths.length > 0;
    if (fed && (readsProgramFromStdin(programName(head.text), argv) || (HANDS_ON.has(programName(head.text)) && stdinInterpreterAfter(argv)))) return true;
    // `expect` runs Tcl, not a shell: its payload is never decoded here, so it always keeps the card.
    if (programName(head.text) === 'expect') return true;
    if (names(rest.map(word => word.text).join(' '))) return true;
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
