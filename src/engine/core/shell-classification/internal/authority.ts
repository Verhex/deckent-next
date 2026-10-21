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
  if (typeof command !== 'string' || command.length === 0) return false;
  const scan = scanPosixCommand(command);
  if (!scan.ok) return names(command) || PTY_WORD.test(command);
  for (const stage of scan.pipelines.flat()) {
    const head = stage.words[0];
    if (!head) continue;
    const name = programName(head.text), rest = stage.words.slice(1);
    if (LAUNCHERS.has(name) && names(rest.map(word => word.text).join(' '))) return true;
    if (PTY_WRAPPER_PROGRAMS.has(name) && rest.some(word => /[$`]/u.test(word.text))) return true;
    if (INTERPRETER_PROGRAMS.has(name) && rest.some(word => PTY_WORD.test(word.text) && /[$`]/u.test(word.text))) return true;
  }
  return false;
}
