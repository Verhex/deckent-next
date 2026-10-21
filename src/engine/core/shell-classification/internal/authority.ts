import { scanPosixCommand } from './scanner.js';
import { EVAL_PROGRAMS, INTERPRETER_PROGRAMS, PRIVILEGE_PROGRAMS, PRODUCT_AUTHORITY_COMMANDS, PROGRAM_ALIASES, PTY_WRAPPER_PROGRAMS, XARGS_PROGRAMS } from './programs.js';
import { PACKAGE_PROGRAMS } from './mutation.js';

/** The product's authority subcommands as they appear in any command text (the program may be `deckent`, a path to it, `node …/entry.js` or `npx`). */
const AUTHORITY_TEXT: readonly RegExp[] = [/\bsecret\s+(?:grant|revoke|set|delete|handover|store)\b/u, /\bapproval\s+decide\b/u, /\binit\s+policy\b[^;&|\n]*?\s--(?:apply|modes)\b/u];
const LAUNCHERS = new Set([...Object.keys(PRODUCT_AUTHORITY_COMMANDS), ...INTERPRETER_PROGRAMS, ...EVAL_PROGRAMS, ...PTY_WRAPPER_PROGRAMS, ...XARGS_PROGRAMS,
  ...PACKAGE_PROGRAMS, ...PRIVILEGE_PROGRAMS]);
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
/** Nested shell strings decoded at most this deep; deeper is not decoded: the card stays. */
const PAYLOAD_DEPTH = 4;
/** Decoding the shell would do but the strict scanner does not: ANSI-C/locale quoting (`$'…'`, `$"…"`), brace expansion, globbing. */
const UNDECODED = /\$['"]|\{[^{}]*(?:,|\.\.)[^{}]*\}/u;
/** A glob can turn into an authority word only from file names; it is undecoded where the product itself runs (`deckent s*t grant`). */
const GLOB = /[*?[]/u;
/** A word another shell (or `expect`) may parse again: quotes, escapes, separators or blanks inside it. */
const REPARSED = /[\s'"\\;&|<>()`$]/u;
const tokenNames = (text: string) => text.split(/[\s;&|()<>]+/u).map(token => programName(token.replace(/['"\\]/gu, ''))).filter(Boolean);
/**
 * Astra REVISE 2702 P1-A: a stage run by the product or a launcher is decided on its decoded argv (the scanner's quote removal), and every argument
 * another shell may parse again (a `-c` string, `script -c`, `watch`, `expect -c`, …) is decoded the same way, recursively. Whatever the scanner
 * cannot decode exactly as the shell would — an expansion or a substitution (the scanner refuses it), `$'…'`, brace expansion, a glob, or nesting
 * past `PAYLOAD_DEPTH` — keeps the card when a launcher or the product runs it.
 */
function runsAuthority(command: string, depth: number): boolean {
  const scan = scanPosixCommand(command), launched = tokenNames(command).some(name => LAUNCHERS.has(name));
  if (!scan.ok) return launched || names(command) || PTY_WORD.test(command);
  for (const stage of scan.pipelines.flat()) {
    const head = stage.words[0];
    if (!head || !LAUNCHERS.has(programName(head.text))) continue;
    const rest = stage.words.slice(1);
    // `expect` runs Tcl, not a shell: its payload is never decoded here, so it always keeps the card.
    if (programName(head.text) === 'expect') return true;
    if (names(rest.map(word => word.text).join(' '))) return true;
    // `$` the scanner kept (`$'…'`), brace expansion or a glob: the shell would run another argv than the one decoded here.
    if (rest.some(word => !word.quoted && UNDECODED.test(word.text)) || rest.some(word => word.text.includes('$'))) return true;
    if (Object.hasOwn(PRODUCT_AUTHORITY_COMMANDS, programName(head.text)) && rest.some(word => !word.quoted && GLOB.test(word.text))) return true;
    for (const word of rest) {
      if (!REPARSED.test(word.text)) continue;
      if (depth + 1 >= PAYLOAD_DEPTH || runsAuthority(word.text, depth + 1)) return true;
    }
  }
  return false;
}
