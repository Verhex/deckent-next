import type { ShellReasonCode, ShellWord } from './scanner.js';
import type { ProgramSpec, ShellReadRisk, ValueKind } from './programs.js';

/** A path argument checked against the workspace (see the adapter): inside, not denied, existing; globs expanded, each match checked. */
export type ShellPathVerdict = { readonly ok: true } | { readonly ok: false; readonly reasonCode: ShellReasonCode; readonly detail: string };
export interface ShellPathContext {
  /** `lexicalOnly`: git positionals are refs/pathspecs — only a lexical escape from the workspace is refused. */
  check(word: ShellWord, readsContent: boolean, lexicalOnly?: boolean): Promise<ShellPathVerdict>;
}
export type StageVerdict = { readonly ok: true; readonly risk: ShellReadRisk } | { readonly ok: false; readonly reasonCode: ShellReasonCode; readonly detail?: string };
export const stageFail = (reasonCode: ShellReasonCode, detail?: string): StageVerdict => (detail === undefined ? { ok: false, reasonCode } : { ok: false, reasonCode, detail });

/**
 * Option grammars of the allowlisted programs, `find` and `git` (legacy @a8b67e2a1, kept as is). Argv semantics: any word whose
 * resolved text starts with `-` is an option, whatever its quoting; the word `--` ends options.
 */
export interface WalkResult {
  readonly verdict: StageVerdict | null;
  readonly positionals: ShellWord[];
  readonly scriptSeen: boolean;
  readonly traversal: boolean;
}

export async function walkOptions(spec: ProgramSpec, args: readonly ShellWord[], paths: ShellPathContext): Promise<WalkResult> {
  const grammar = spec.grammar;
  const positionals: ShellWord[] = [];
  let scriptSeen = false;
  let traversal = false;
  let optionsEnded = false;
  const checkValue = async (kind: ValueKind, word: ShellWord, flag: string): Promise<StageVerdict | null> => {
    if (kind === 'path') {
      const verdict = await paths.check(word, spec.readsContent);
      return verdict.ok ? null : stageFail(verdict.reasonCode, verdict.detail);
    }
    if (kind === 'script') {
      scriptSeen = true;
      const failure = spec.script?.(word.text) ?? null;
      return failure === null ? null : stageFail(failure, flag);
    }
    if (kind === 'number' && !/^[+-]?\d+[kKmMgGbB]?$/u.test(word.text)) return stageFail('FLAG_NOT_ALLOWLISTED', `${flag}=${word.text}`);
    return null;
  };
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    const text = word.text;
    // Argv semantics: the program sees the resolved text, so a quoted/escaped
    // prefix never demotes an option to a positional, and the argv word `--`
    // (quoted or not) ends option parsing.
    if (optionsEnded || !text.startsWith('-') || text === '-') {
      positionals.push(word);
      continue;
    }
    if (text === '--') { optionsEnded = true; continue; }
    if (spec.traversalFlags?.includes(text)) traversal = true;
    if (text.startsWith('--')) {
      const eq = text.indexOf('=');
      const name = eq >= 0 ? text.slice(0, eq) : text;
      const attached = eq >= 0 ? text.slice(eq + 1) : null;
      if (grammar.deniedLong?.includes(name)) return { verdict: stageFail('MUTATING_FLAG', name), positionals, scriptSeen, traversal };
      if (spec.scriptOptions?.includes(name)) scriptSeen = true;
      const valueKind = grammar.longValues?.[name];
      if (valueKind !== undefined) {
        let value: ShellWord;
        if (attached !== null) value = { text: attached, quoted: word.quoted, glob: false, tilde: false };
        else if (i + 1 < args.length) value = args[++i]!;
        else return { verdict: stageFail('FLAG_NOT_ALLOWLISTED', name), positionals, scriptSeen, traversal };
        const failure = await checkValue(valueKind, value, name);
        if (failure) return { verdict: failure, positionals, scriptSeen, traversal };
        continue;
      }
      if (grammar.longSwitches?.includes(name) || grammar.permissiveLong === true) continue;
      return { verdict: stageFail('FLAG_NOT_ALLOWLISTED', name), positionals, scriptSeen, traversal };
    }
    if (grammar.numericShort && /^-\d+$/u.test(text)) continue;
    const cluster = text.slice(1);
    for (let c = 0; c < cluster.length; c++) {
      const flag = cluster[c]!;
      if (grammar.deniedShort?.includes(flag)) return { verdict: stageFail('MUTATING_FLAG', `-${flag}`), positionals, scriptSeen, traversal };
      if (spec.scriptOptions?.includes(`-${flag}`)) scriptSeen = true;
      const valueKind = grammar.shortValues?.[flag];
      if (valueKind !== undefined) {
        const rest = cluster.slice(c + 1);
        let value: ShellWord;
        if (rest.length > 0) value = { text: rest, quoted: word.quoted, glob: false, tilde: false };
        else if (i + 1 < args.length) value = args[++i]!;
        else return { verdict: stageFail('FLAG_NOT_ALLOWLISTED', `-${flag}`), positionals, scriptSeen, traversal };
        const failure = await checkValue(valueKind, value, `-${flag}`);
        if (failure) return { verdict: failure, positionals, scriptSeen, traversal };
        break;
      }
      if (grammar.shortSwitches?.includes(flag)) {
        if (spec.traversalFlags?.includes(`-${flag}`)) traversal = true;
        continue;
      }
      return { verdict: stageFail('FLAG_NOT_ALLOWLISTED', `-${flag}`), positionals, scriptSeen, traversal };
    }
  }
  return { verdict: null, positionals, scriptSeen, traversal };
}

export async function checkPositionals(spec: ProgramSpec, walk: WalkResult, context: ShellPathContext): Promise<StageVerdict> {
  let paths = walk.positionals;
  if (spec.positional === 'none') {
    return paths.length === 0 ? { ok: true, risk: spec.risk } : stageFail('FLAG_NOT_ALLOWLISTED', paths[0]!.text);
  }
  if (spec.positional === 'any') return { ok: true, risk: spec.risk };
  if (spec.positional === 'first-script-then-paths' && !walk.scriptSeen) {
    const script = paths[0];
    if (script === undefined) return stageFail('SCRIPT_UNPARSEABLE');
    const failure = spec.script?.(script.text) ?? null;
    if (failure !== null) return stageFail(failure, spec.id);
    paths = paths.slice(1);
  } else if (spec.positional === 'first-pattern-then-paths' && !walk.scriptSeen) {
    paths = paths.slice(1);
  }
  if (spec.maxPositionals !== undefined && paths.length > spec.maxPositionals) {
    return stageFail('OUTPUT_FILE_POSITIONAL', paths[spec.maxPositionals]!.text);
  }
  for (const word of paths) {
    const verdict = await context.check(word, spec.readsContent);
    if (!verdict.ok) return stageFail(verdict.reasonCode, verdict.detail);
  }
  return { ok: true, risk: walk.traversal ? 'low' : spec.risk };
}

const FIND_VALUE_PRIMARIES = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-lname', '-ilname', '-type', '-xtype', '-maxdepth', '-mindepth', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-size', '-perm', '-user', '-group', '-uid', '-gid', '-links', '-inum', '-regextype', '-printf', '-used', '-fstype', '-context', '-D']);
const FIND_PATH_PRIMARIES = new Set(['-newer', '-anewer', '-cnewer', '-samefile']);
const FIND_SWITCH_PRIMARIES = new Set(['-print', '-print0', '-ls', '-prune', '-quit', '-empty', '-readable', '-writable', '-executable', '-nouser', '-nogroup', '-false', '-true', '-not', '!', '-a', '-and', '-o', '-or', '-depth', '-d', '-follow', '-L', '-H', '-P', '-xdev', '-mount', '-noleaf', '-ignore_readdir_race', '-noignore_readdir_race', '-daystart', '(', ')', '-files0-from']);
const FIND_DENIED = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls', '-files0-from']);

export async function checkFind(args: readonly ShellWord[], paths: ShellPathContext): Promise<StageVerdict> {
  let i = 0;
  while (i < args.length) {
    const word = args[i]!;
    if (word.text.startsWith('-') || word.text === '!' || word.text === '(') break;
    const verdict = await paths.check(word, false);
    if (!verdict.ok) return stageFail(verdict.reasonCode, verdict.detail);
    i++;
  }
  for (; i < args.length; i++) {
    const token = (args[i]!).text;
    if (FIND_DENIED.has(token)) return stageFail('MUTATING_FLAG', token);
    if (FIND_SWITCH_PRIMARIES.has(token) || /^-O\d$/u.test(token)) continue;
    if (token.startsWith('-newer') && token.length > 6) {
      const value = args[++i];
      if (value === undefined) return stageFail('FLAG_NOT_ALLOWLISTED', token);
      if (/^-newer[abcm]t$/u.test(token)) continue;
      const verdict = await paths.check(value, false);
      if (!verdict.ok) return stageFail(verdict.reasonCode, verdict.detail);
      continue;
    }
    if (FIND_PATH_PRIMARIES.has(token)) {
      const value = args[++i];
      if (value === undefined) return stageFail('FLAG_NOT_ALLOWLISTED', token);
      const verdict = await paths.check(value, false);
      if (!verdict.ok) return stageFail(verdict.reasonCode, verdict.detail);
      continue;
    }
    if (FIND_VALUE_PRIMARIES.has(token)) {
      if (args[++i] === undefined) return stageFail('FLAG_NOT_ALLOWLISTED', token);
      continue;
    }
    return stageFail('FLAG_NOT_ALLOWLISTED', token);
  }
  return { ok: true, risk: 'low' };
}

// ─── git ────────────────────────────────────────────────────────────────────

const GIT_GLOBAL_SWITCHES = new Set(['--no-pager', '-P', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-replace-objects', '--version']);
const GIT_READ_SUBCOMMANDS = new Set(['status', 'log', 'shortlog', 'show', 'diff', 'diff-tree', 'diff-index', 'diff-files', 'blame', 'annotate', 'describe', 'name-rev', 'merge-base', 'cat-file', 'ls-tree', 'ls-files', 'rev-parse', 'rev-list', 'grep', 'count-objects', 'check-ignore', 'check-attr', 'var', 'version', 'whatchanged', 'cherry', 'range-diff', 'for-each-ref', 'show-ref', 'show-branch', 'reflog', 'stash', 'remote', 'tag', 'branch', 'config', 'worktree', 'submodule', 'symbolic-ref', 'rev-parse', 'log', 'fsck', 'verify-commit', 'verify-tag', 'get-tar-commit-id', 'diff-tree', 'help']);
/** Per-subcommand flags that disqualify read-only (write an output file, run
 *  an external program/pager/editor, or mutate refs). `*` applies to every
 *  read subcommand; branch/tag/config carry their own full grammars below. */
const GIT_DENIED_BY_SUBCOMMAND: Readonly<Record<string, readonly string[]>> = {
  '*': ['--output', '--ext-diff', '--open-files-in-pager', '--web', '--man', '--info', '--exec'],
  grep: ['-O'],
  'symbolic-ref': ['-d', '--delete', '-m'],
  'cat-file': ['--batch-command'],
};
const GIT_BRANCH_READ_FLAGS = new Set(['--list', '-l', '-a', '-r', '-v', '-vv', '--all', '--remotes', '--verbose', '--show-current', '--color', '--no-color', '--column', '--no-column', '--ignore-case', '--no-abbrev', '--abbrev']);
const GIT_BRANCH_VALUE_FLAGS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort']);
const GIT_TAG_READ_FLAGS = new Set(['--list', '-l', '-n', '--column', '--no-column', '--ignore-case', '-i', '--color']);
const GIT_TAG_VALUE_FLAGS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort']);
const GIT_CONFIG_READ_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--show-origin', '--show-scope', '-z', '--null', '--name-only', '--type', '--bool', '--int', '--path', '--global', '--system', '--local', '--worktree', '--includes', '--no-includes', '--default', '--fixed-value', 'get', 'list']);

async function gitSubcommandVerdict(sub: string, args: readonly ShellWord[], paths: ShellPathContext): Promise<StageVerdict> {
  const texts = args.map((w) => w.text);
  const flagName = (t: string): string => (t.includes('=') ? t.slice(0, t.indexOf('=')) : t);
  const denied = [...(GIT_DENIED_BY_SUBCOMMAND['*'] ?? []), ...(GIT_DENIED_BY_SUBCOMMAND[sub] ?? [])];
  for (const t of texts) {
    if (!t.startsWith('-')) continue;
    const name = flagName(t);
    if (denied.includes(name) || (sub === 'grep' && /^-O/u.test(t))) return stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', `${sub} ${t}`);
  }
  const positionals = args.filter((w) => !w.text.startsWith('-') || w.text === '-');
  const checkAllPositionals = async (words: readonly ShellWord[]): Promise<StageVerdict | null> => {
    for (const word of words) {
      if (word.text === '--' || word.text === '') continue;
      const verdict = await paths.check(word, true, true);
      if (!verdict.ok && verdict.reasonCode === 'PATH_OUTSIDE_ROOT') return stageFail(verdict.reasonCode, verdict.detail);
    }
    return null;
  };
  switch (sub) {
    case 'branch': {
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i]!;
        if (GIT_BRANCH_READ_FLAGS.has(t)) continue;
        if (GIT_BRANCH_VALUE_FLAGS.has(t)) { i++; continue; }
        if ([...GIT_BRANCH_VALUE_FLAGS].some((f) => t.startsWith(`${f}=`))) continue;
        if (t.startsWith('-')) return stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', `branch ${t}`);
        if (!texts.includes('--list') && !texts.includes('-l')) return stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', `branch ${t}`);
      }
      return { ok: true, risk: 'low' };
    }
    case 'tag': {
      const listing = texts.some((t) => GIT_TAG_READ_FLAGS.has(t) || t.startsWith('-n') || [...GIT_TAG_VALUE_FLAGS].some((f) => t.startsWith(f)));
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i]!;
        if (GIT_TAG_READ_FLAGS.has(t) || /^-n\d*$/u.test(t)) continue;
        if (GIT_TAG_VALUE_FLAGS.has(t)) { i++; continue; }
        if ([...GIT_TAG_VALUE_FLAGS].some((f) => t.startsWith(`${f}=`)) || t.startsWith('--color=')) continue;
        if (t.startsWith('-')) return stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', `tag ${t}`);
        if (!listing) return stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', `tag ${t}`);
      }
      return { ok: true, risk: 'low' };
    }
    case 'stash':
      return texts[0] === 'list' || texts[0] === 'show' ? { ok: true, risk: 'low' } : stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', `stash ${texts[0] ?? ''}`);
    case 'remote':
      return texts.length === 0 || (texts.length === 1 && (texts[0] === '-v' || texts[0] === '--verbose')) || texts[0] === 'get-url'
        ? { ok: true, risk: 'low' }
        : stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', `remote ${texts[0] ?? ''}`);
    case 'worktree':
      return texts[0] === 'list' ? { ok: true, risk: 'low' } : stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', `worktree ${texts[0] ?? ''}`);
    case 'submodule':
      return texts[0] === 'status' ? { ok: true, risk: 'low' } : stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', `submodule ${texts[0] ?? ''}`);
    case 'reflog':
      return texts.length === 0 || texts[0] === 'show' || (texts[0]!).startsWith('-') ? { ok: true, risk: 'low' } : stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', `reflog ${texts[0]}`);
    case 'symbolic-ref':
      return positionals.length <= 1 ? { ok: true, risk: 'low' } : stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', 'symbolic-ref');
    case 'config': {
      for (const t of texts) {
        if (t.startsWith('-') && !GIT_CONFIG_READ_FLAGS.has(flagName(t))) return stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', `config ${t}`);
      }
      const reading = texts.some((t) => t.startsWith('--get') || t === '--list' || t === '-l' || t === 'get' || t === 'list');
      const limit = reading ? 2 : 1;
      return positionals.length <= limit ? { ok: true, risk: 'low' } : stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', 'config');
    }
    case 'help':
      return stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', 'help');
    default: {
      const failure = await checkAllPositionals(positionals);
      return failure ?? { ok: true, risk: 'low' };
    }
  }
}

export async function checkGit(args: readonly ShellWord[], paths: ShellPathContext): Promise<StageVerdict> {
  let i = 0;
  for (; i < args.length; i++) {
    const t = (args[i]!).text;
    if (!t.startsWith('-')) break;
    if (GIT_GLOBAL_SWITCHES.has(t)) { if (t === '--version') return { ok: true, risk: 'none' }; continue; }
    if (t === '-C') {
      const value = args[++i];
      if (value === undefined) return stageFail('FLAG_NOT_ALLOWLISTED', '-C');
      const verdict = await paths.check(value, false);
      if (!verdict.ok) return stageFail(verdict.reasonCode, verdict.detail);
      continue;
    }
    return stageFail('FLAG_NOT_ALLOWLISTED', t);
  }
  const sub = args[i]?.text ?? '';
  if (sub === '') return stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', '');
  if (!GIT_READ_SUBCOMMANDS.has(sub)) return stageFail('GIT_SUBCOMMAND_NOT_READ_ONLY', sub);
  return gitSubcommandVerdict(sub, args.slice(i + 1), paths);
}
