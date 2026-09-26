/**
 * POSIX `sh -c` scanner for read-only classification (T-L4 slice 3a; legacy `shell-readonly-classifier.ts` @a8b67e2a1, MASTER 7111).
 * It splits a command into pipelines of stages of words and rejects, with a typed reason, every construct that could run code or
 * write bytes: redirections other than to /dev/null or between stdout/stderr, substitutions, expansions, subshells, braces,
 * heredocs, background jobs. Quoting only affects word splitting: the program receives the resolved text.
 */
export type ShellReasonCode =
  | 'READ_ONLY' | 'EMPTY_COMMAND' | 'UNPARSEABLE' | 'UNSUPPORTED_DIALECT' | 'OUTPUT_REDIRECTION' | 'INPUT_REDIRECTION_UNSAFE' | 'HEREDOC'
  | 'PIPE_STDERR' | 'BACKGROUND_JOB' | 'COMMAND_SUBSTITUTION' | 'PROCESS_SUBSTITUTION' | 'VARIABLE_EXPANSION' | 'SUBSHELL' | 'BRACE_EXPANSION'
  | 'ENV_ASSIGNMENT' | 'PRIVILEGE_ESCALATION' | 'INTERPRETER' | 'EVAL' | 'XARGS' | 'OUTPUT_TEE' | 'PROGRAM_NOT_ALLOWLISTED' | 'PROGRAM_PATH'
  | 'FLAG_NOT_ALLOWLISTED' | 'MUTATING_FLAG' | 'SCRIPT_UNSAFE' | 'SCRIPT_UNPARSEABLE' | 'GIT_SUBCOMMAND_NOT_READ_ONLY' | 'OUTPUT_FILE_POSITIONAL'
  | 'PATH_OUTSIDE_ROOT' | 'PATH_PROTECTED' | 'PATH_UNRESOLVED' | 'GLOB_EXPANSION' | 'GLOB_UNSUPPORTED';

/** One argv word: its resolved text, whether any part was quoted, and whether it carries an unquoted glob or a leading `~`. */
export interface ShellWord { readonly text: string; readonly quoted: boolean; readonly glob: boolean; readonly tilde: boolean }
export interface ShellStage { readonly words: readonly ShellWord[]; readonly inputPaths: readonly ShellWord[] }
export type ShellScan = { readonly ok: true; readonly pipelines: readonly (readonly ShellStage[])[] }
  | { readonly ok: false; readonly reasonCode: ShellReasonCode; readonly detail?: string };

const EXPANSION_START = /[A-Za-z_{(0-9@*#?!$-]/u;
const DEV_NULL = '/dev/null';
const isMeta = (char: string) => /\s/u.test(char) || '|;&<>()'.includes(char);
const reject = (reasonCode: ShellReasonCode, detail?: string): ShellScan => detail === undefined ? { ok: false, reasonCode } : { ok: false, reasonCode, detail };

function readToken(command: string, from: number, stopAt: (char: string) => boolean) {
  let end = from, text = '';
  while (end < command.length && !stopAt(command[end]!)) text += command[end++];
  return { text, end };
}

type Building = { text: string; quoted: boolean; glob: boolean; tilde: boolean };

export function scanPosixCommand(command: string): ShellScan {
  const pipelines: ShellStage[][] = [];
  let words: ShellWord[] = [], inputPaths: ShellWord[] = [], pipeline: ShellStage[] = [];
  let word: Building | null = null, quote: "'" | '"' | null = null, escaped = false;
  const start = (): Building => (word ??= { text: '', quoted: false, glob: false, tilde: false });
  const append = (char: string, quoted = false) => { const current = start(); current.text += char; if (quoted) current.quoted = true; };
  const flushWord = () => { if (word) words.push(Object.freeze({ ...word })); word = null; };
  const endStage = () => { flushWord(); pipeline.push(Object.freeze({ words, inputPaths })); words = []; inputPaths = []; };
  const endPipeline = () => { endStage(); pipelines.push(pipeline); pipeline = []; };
  /** An adjacent unquoted digit-only word directly before an operator is a file-descriptor prefix. */
  const takeFdPrefix = (): string | null => {
    const active = word as Building | null;
    if (active && !active.quoted && /^\d+$/u.test(active.text)) { word = null; return active.text; }
    return null;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (escaped) { append(char, true); escaped = false; continue; }
    if (quote === "'") { if (char === "'") quote = null; else append(char, true); continue; }
    if (quote === '"') {
      if (char === '"') { quote = null; continue; }
      if (char === '\\') { escaped = true; start().quoted = true; continue; }
      if (char === '`') return reject('COMMAND_SUBSTITUTION', '`');
      if (char === '$') {
        const next = command[index + 1] ?? '';
        if (next === '(') return reject('COMMAND_SUBSTITUTION', '$(');
        if (EXPANSION_START.test(next)) return reject('VARIABLE_EXPANSION', `$${next}`);
      }
      append(char, true);
      continue;
    }
    switch (char) {
      case '\\': escaped = true; start().quoted = true; continue;
      case "'": case '"': quote = char; start().quoted = true; continue;
      case '`': return reject('COMMAND_SUBSTITUTION', '`');
      case '$': {
        const next = command[index + 1] ?? '';
        if (next === '(') return reject('COMMAND_SUBSTITUTION', '$(');
        if (EXPANSION_START.test(next)) return reject('VARIABLE_EXPANSION', `$${next}`);
        append(char);
        continue;
      }
      case '|': {
        const next = command[index + 1] ?? '';
        if (next === '&') return reject('PIPE_STDERR', '|&');
        if (next === '|') { endPipeline(); index++; continue; }
        endStage();
        continue;
      }
      case ';': case '\n': endPipeline(); continue;
      case '&': {
        const next = command[index + 1] ?? '';
        if (next === '&') { endPipeline(); index++; continue; }
        return next === '>' ? reject('OUTPUT_REDIRECTION', '&>') : reject('BACKGROUND_JOB', '&');
      }
      case '>': {
        const fd = takeFdPrefix();
        let operator = '>', cursor = index + 1;
        if (command[cursor] === '>' || command[cursor] === '&' || command[cursor] === '|') operator += command[cursor++];
        while (command[cursor] === ' ' || command[cursor] === '\t') cursor++;
        const target = readToken(command, cursor, isMeta);
        const stderrToStdout = fd === '2' && operator === '>&' && target.text === '1';
        const stdoutToStderr = (fd === null || fd === '1') && operator === '>&' && target.text === '2';
        if (!stderrToStdout && !stdoutToStderr && !(operator === '>' && target.text === DEV_NULL)) return reject('OUTPUT_REDIRECTION', `${fd ?? ''}${operator}${target.text}`);
        flushWord();
        index = target.end - 1;
        continue;
      }
      case '<': {
        takeFdPrefix();
        const next = command[index + 1] ?? '';
        if (next === '<') return reject('HEREDOC', command[index + 2] === '<' ? '<<<' : '<<');
        if (next === '(') return reject('PROCESS_SUBSTITUTION', '<(');
        if (next === '&' || next === '>') return reject('INPUT_REDIRECTION_UNSAFE', `<${next}`);
        let cursor = index + 1;
        while (command[cursor] === ' ' || command[cursor] === '\t') cursor++;
        const target = readToken(command, cursor, isMeta);
        if (target.text.length === 0 || /["'`$\\~{}]/u.test(target.text)) return reject('INPUT_REDIRECTION_UNSAFE', `<${target.text}`);
        flushWord();
        inputPaths.push(Object.freeze({ text: target.text, quoted: false, glob: /[*?[]/u.test(target.text), tilde: false }));
        index = target.end - 1;
        continue;
      }
      case '(': case ')': return reject('SUBSHELL', char);
      case '{': case '}': return reject('BRACE_EXPANSION', char);
      case '#':
        if (word === null) { index = readToken(command, index, next => next === '\n').end - 1; continue; }
        append(char);
        continue;
      case '~':
        if (word === null) start().tilde = true;
        append(char);
        continue;
      case '*': case '?': case '[':
        start().glob = true;
        append(char);
        continue;
      default:
        if (/\s/u.test(char)) { flushWord(); continue; }
        append(char);
    }
  }
  if (quote !== null || escaped) return reject('UNPARSEABLE');
  endPipeline();
  return { ok: true, pipelines: pipelines.filter(stages => stages.some(stage => stage.words.length > 0 || stage.inputPaths.length > 0)) };
}
