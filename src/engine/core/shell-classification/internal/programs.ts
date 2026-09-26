import type { ShellReasonCode } from './scanner.js';
import { checkAwkProgram, checkSedScript } from './scripts.js';

/** `none`: a bounded local read; `low`: repository-wide traversal or environment exposure. */
export type ShellReadRisk = 'none' | 'low';

/**
 * The read-only program allowlist (legacy @a8b67e2a1, POSIX programs kept as is): per program its option grammar (switches,
 * value options and their kinds, denied mutating options), positional shape, risk and whether it reads file contents. A program
 * or option not listed here is not read-only. Data, not policy: which read-only commands run silently is still the policy's call.
 */
export type ValueKind = 'any' | 'path' | 'number' | 'script';

export interface OptionGrammar {
  /** Bundlable single-char switches. */
  readonly shortSwitches?: string;
  /** Single-char options that consume a value (attached or next token). */
  readonly shortValues?: Readonly<Record<string, ValueKind>>;
  readonly longSwitches?: readonly string[];
  readonly longValues?: Readonly<Record<string, ValueKind>>;
  /** Rejected with MUTATING_FLAG. */
  readonly deniedShort?: string;
  readonly deniedLong?: readonly string[];
  /** `-5` style count shorthands (head/tail/grep). */
  readonly numericShort?: boolean;
  /** Whether unknown long options are tolerated as switches (ls). */
  readonly permissiveLong?: boolean;
}

export type PositionalKind =
  | 'paths'
  | 'first-script-then-paths'
  | 'first-pattern-then-paths'
  | 'any'
  | 'none';

export interface ProgramSpec {
  readonly id: string;
  readonly risk: ShellReadRisk;
  readonly readsContent: boolean;
  readonly grammar: OptionGrammar;
  readonly positional: PositionalKind;
  /** Upper bound on positionals (e.g. uniq's second positional is an OUTPUT). */
  readonly maxPositionals?: number;
  /** Script check for the first positional / script-valued options. */
  readonly script?: (script: string) => ShellReasonCode | null;
  /** Options that carry the script (so the first positional becomes a path). */
  readonly scriptOptions?: readonly string[];
  /** Traversal flags that raise the stage risk to `low`. */
  readonly traversalFlags?: readonly string[];
}

const COMMON_LONG_HELP = ['--help', '--version'];

export const PROGRAMS: Readonly<Record<string, ProgramSpec>> = {
  cat: {
    id: 'cat', risk: 'none', readsContent: true, positional: 'paths',
    grammar: { shortSwitches: 'AbeEnstTuv', longSwitches: ['--show-all', '--number-nonblank', '--show-ends', '--number', '--squeeze-blank', '--show-tabs', '--show-nonprinting', ...COMMON_LONG_HELP] },
  },
  tac: { id: 'tac', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'brs', shortValues: { s: 'any' }, longSwitches: ['--before', '--regex'], longValues: { '--separator': 'any' } } },
  head: {
    id: 'head', risk: 'none', readsContent: true, positional: 'paths',
    grammar: { shortSwitches: 'qvz', shortValues: { n: 'number', c: 'number' }, numericShort: true, longSwitches: ['--quiet', '--silent', '--verbose', '--zero-terminated', ...COMMON_LONG_HELP], longValues: { '--lines': 'number', '--bytes': 'number' } },
  },
  tail: {
    id: 'tail', risk: 'none', readsContent: true, positional: 'paths',
    grammar: { shortSwitches: 'qvzfF', shortValues: { n: 'number', c: 'number', s: 'number' }, numericShort: true, longSwitches: ['--quiet', '--silent', '--verbose', '--zero-terminated', '--follow', '--retry', ...COMMON_LONG_HELP], longValues: { '--lines': 'number', '--bytes': 'number', '--sleep-interval': 'number', '--pid': 'number', '--max-unchanged-stats': 'number', '--follow': 'any' } },
  },
  less: { id: 'less', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'NnSFXRrEeMmqQsiIgGwJ', longSwitches: ['--LINE-NUMBERS', '--quit-if-one-screen', '--no-init', '--RAW-CONTROL-CHARS', '--chop-long-lines', ...COMMON_LONG_HELP] } },
  more: { id: 'more', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'dlfpcsu', numericShort: true } },
  sed: {
    id: 'sed', risk: 'none', readsContent: true, positional: 'first-script-then-paths',
    script: checkSedScript, scriptOptions: ['-e', '--expression'],
    grammar: {
      shortSwitches: 'nrEszu', shortValues: { e: 'script', l: 'number' }, deniedShort: 'if',
      longSwitches: ['--quiet', '--silent', '--regexp-extended', '--separate', '--null-data', '--unbuffered', '--posix', '--debug', '--sandbox', '--follow-symlinks', ...COMMON_LONG_HELP],
      longValues: { '--expression': 'script', '--line-length': 'number' },
      deniedLong: ['--in-place', '--file'],
    },
  },
  awk: {
    id: 'awk', risk: 'none', readsContent: true, positional: 'first-script-then-paths',
    script: checkAwkProgram, scriptOptions: ['-e', '--source'],
    grammar: {
      shortValues: { F: 'any', v: 'any', e: 'script' }, deniedShort: 'filEdoDLpPMSbcrnNOtgRWs',
      longSwitches: ['--sandbox', '--posix', '--traditional', '--lint', '--characters-as-bytes', '--bignum', '--re-interval', ...COMMON_LONG_HELP],
      longValues: { '--field-separator': 'any', '--assign': 'any', '--source': 'script' },
      deniedLong: ['--file', '--include', '--load', '--exec', '--profile', '--dump-variables', '--debug', '--gen-pot', '--pretty-print', '--optimize', '--non-decimal-data'],
    },
  },
  grep: {
    id: 'grep', risk: 'none', readsContent: true, positional: 'first-pattern-then-paths',
    scriptOptions: ['-e', '--regexp', '-f', '--file'], traversalFlags: ['-r', '-R', '--recursive', '--dereference-recursive'],
    grammar: {
      shortSwitches: 'EFGPiyvwxclLoqsbHhnTZzaIUurR', shortValues: { e: 'any', f: 'path', m: 'number', A: 'number', B: 'number', C: 'number', d: 'any', D: 'any' }, numericShort: true,
      longSwitches: ['--extended-regexp', '--fixed-strings', '--basic-regexp', '--perl-regexp', '--ignore-case', '--no-ignore-case', '--invert-match', '--word-regexp', '--line-regexp', '--count', '--files-with-matches', '--files-without-match', '--only-matching', '--quiet', '--silent', '--no-messages', '--byte-offset', '--with-filename', '--no-filename', '--line-number', '--no-line-number', '--initial-tab', '--null', '--null-data', '--text', '--recursive', '--dereference-recursive', '--line-buffered', '--color', '--colour', '--no-color', ...COMMON_LONG_HELP],
      longValues: { '--regexp': 'any', '--file': 'path', '--max-count': 'number', '--after-context': 'number', '--before-context': 'number', '--context': 'number', '--include': 'any', '--exclude': 'any', '--exclude-dir': 'any', '--exclude-from': 'path', '--binary-files': 'any', '--directories': 'any', '--devices': 'any', '--label': 'any', '--color': 'any', '--colour': 'any', '--group-separator': 'any' },
    },
  },
  rg: {
    id: 'rg', risk: 'low', readsContent: true, positional: 'first-pattern-then-paths',
    scriptOptions: ['-e', '--regexp', '-f', '--file', '--files', '--type-list'],
    grammar: {
      shortSwitches: 'iSsvwxclLoqnNHUzaFPpu', shortValues: { e: 'any', f: 'path', m: 'number', A: 'number', B: 'number', C: 'number', t: 'any', T: 'any', g: 'any', r: 'any', E: 'any', M: 'number', j: 'number', d: 'number' },
      longSwitches: ['--ignore-case', '--smart-case', '--case-sensitive', '--invert-match', '--word-regexp', '--line-regexp', '--count', '--count-matches', '--files-with-matches', '--files-without-match', '--only-matching', '--quiet', '--line-number', '--no-line-number', '--with-filename', '--no-filename', '--column', '--no-column', '--heading', '--no-heading', '--json', '--multiline', '--multiline-dotall', '--fixed-strings', '--pcre2', '--no-pcre2', '--hidden', '--no-ignore', '--no-ignore-vcs', '--no-ignore-global', '--no-ignore-parent', '--no-ignore-dot', '--files', '--type-list', '--stats', '--trim', '--null', '--null-data', '--no-messages', '--no-config', '--text', '--crlf', '--debug', '--trace', '--no-unicode', '--unicode', '--auto-hybrid-regex', '--follow', '--no-follow', '--one-file-system', '--vimgrep', '--passthru', '--sort-files', ...COMMON_LONG_HELP],
      longValues: { '--regexp': 'any', '--file': 'path', '--max-count': 'number', '--after-context': 'number', '--before-context': 'number', '--context': 'number', '--type': 'any', '--type-not': 'any', '--glob': 'any', '--iglob': 'any', '--max-depth': 'number', '--max-columns': 'number', '--max-columns-preview': 'any', '--max-filesize': 'any', '--replace': 'any', '--encoding': 'any', '--engine': 'any', '--color': 'any', '--colors': 'any', '--sort': 'any', '--sortr': 'any', '--threads': 'number', '--ignore-file': 'path', '--type-add': 'any', '--type-clear': 'any', '--path-separator': 'any', '--field-context-separator': 'any', '--field-match-separator': 'any', '--context-separator': 'any', '--dfa-size-limit': 'any', '--regex-size-limit': 'any', '--generate': 'any' },
      deniedLong: ['--pre', '--pre-glob', '--search-zip'],
    },
  },
  wc: {
    id: 'wc', risk: 'none', readsContent: true, positional: 'paths',
    grammar: { shortSwitches: 'cmlLw', longSwitches: ['--bytes', '--chars', '--lines', '--max-line-length', '--words', ...COMMON_LONG_HELP], longValues: { '--total': 'any' }, deniedLong: ['--files0-from'] },
  },
  ls: {
    id: 'ls', risk: 'none', readsContent: false, positional: 'paths', traversalFlags: ['-R', '--recursive'],
    grammar: { shortSwitches: 'aAbBcCdDfFgGhHiklLmnNopqQrRsStTuUvxXZ1', shortValues: { I: 'any', T: 'number', w: 'number' }, permissiveLong: true, longValues: { '--block-size': 'any', '--color': 'any', '--format': 'any', '--hide': 'any', '--ignore': 'any', '--indicator-style': 'any', '--quoting-style': 'any', '--sort': 'any', '--time': 'any', '--time-style': 'any', '--width': 'number', '--tabsize': 'number', '--hyperlink': 'any' } },
  },
  find: { id: 'find', risk: 'low', readsContent: false, positional: 'paths', grammar: {} },
  stat: {
    id: 'stat', risk: 'none', readsContent: false, positional: 'paths',
    grammar: { shortSwitches: 'Lft', shortValues: { c: 'any' }, longSwitches: ['--dereference', '--file-system', '--terse', '--cached', ...COMMON_LONG_HELP], longValues: { '--format': 'any', '--printf': 'any', '--cached': 'any' } },
  },
  file: {
    id: 'file', risk: 'none', readsContent: true, positional: 'paths',
    grammar: { shortSwitches: 'bihLkNnprz0', shortValues: { e: 'any', F: 'any', P: 'any' }, deniedShort: 'Cmfs', longSwitches: ['--brief', '--mime', '--mime-type', '--mime-encoding', '--dereference', '--keep-going', '--no-pad', '--no-buffer', '--preserve-date', '--raw', '--uncompress', '--print0', ...COMMON_LONG_HELP], longValues: { '--exclude': 'any', '--separator': 'any', '--parameter': 'any' }, deniedLong: ['--compile', '--magic-file', '--files-from', '--special-files'] },
  },
  du: {
    id: 'du', risk: 'low', readsContent: false, positional: 'paths',
    grammar: { shortSwitches: 'abchkmsxLPDH0S', shortValues: { d: 'number', B: 'any', t: 'any', X: 'path' }, longSwitches: ['--all', '--apparent-size', '--bytes', '--total', '--dereference', '--dereference-args', '--human-readable', '--inodes', '--si', '--summarize', '--one-file-system', '--separate-dirs', '--count-links', '--null', '--time', ...COMMON_LONG_HELP], longValues: { '--max-depth': 'number', '--block-size': 'any', '--exclude': 'any', '--exclude-from': 'path', '--threshold': 'any', '--time': 'any', '--time-style': 'any' }, deniedLong: ['--files0-from'] },
  },
  tr: { id: 'tr', risk: 'none', readsContent: false, positional: 'any', grammar: { shortSwitches: 'cCdst', longSwitches: ['--complement', '--delete', '--squeeze-repeats', '--truncate-set1', ...COMMON_LONG_HELP] } },
  cut: {
    id: 'cut', risk: 'none', readsContent: true, positional: 'paths',
    grammar: { shortSwitches: 'nsz', shortValues: { b: 'any', c: 'any', f: 'any', d: 'any' }, longSwitches: ['--only-delimited', '--complement', '--zero-terminated', ...COMMON_LONG_HELP], longValues: { '--bytes': 'any', '--characters': 'any', '--fields': 'any', '--delimiter': 'any', '--output-delimiter': 'any' } },
  },
  sort: {
    id: 'sort', risk: 'none', readsContent: true, positional: 'paths',
    grammar: { shortSwitches: 'bdfgiMhnRrVsuzcC', shortValues: { k: 'any', t: 'any', S: 'any' }, deniedShort: 'oT', longSwitches: ['--ignore-leading-blanks', '--dictionary-order', '--ignore-case', '--general-numeric-sort', '--ignore-nonprinting', '--month-sort', '--human-numeric-sort', '--numeric-sort', '--random-sort', '--reverse', '--version-sort', '--stable', '--unique', '--zero-terminated', '--check', '--debug', ...COMMON_LONG_HELP], longValues: { '--key': 'any', '--field-separator': 'any', '--buffer-size': 'any', '--parallel': 'number', '--sort': 'any', '--check': 'any', '--random-source': 'path' }, deniedLong: ['--output', '--temporary-directory', '--files0-from', '--compress-program'] },
  },
  uniq: {
    id: 'uniq', risk: 'none', readsContent: true, positional: 'paths', maxPositionals: 1,
    grammar: { shortSwitches: 'cdDiuz', shortValues: { f: 'number', s: 'number', w: 'number' }, longSwitches: ['--count', '--repeated', '--all-repeated', '--ignore-case', '--unique', '--zero-terminated', ...COMMON_LONG_HELP], longValues: { '--skip-fields': 'number', '--skip-chars': 'number', '--check-chars': 'number', '--all-repeated': 'any', '--group': 'any' } },
  },
  nl: {
    id: 'nl', risk: 'none', readsContent: true, positional: 'paths',
    grammar: { shortSwitches: 'p', shortValues: { b: 'any', d: 'any', f: 'any', h: 'any', i: 'number', l: 'number', n: 'any', s: 'any', v: 'number', w: 'number' }, longSwitches: ['--no-renumber', ...COMMON_LONG_HELP], longValues: { '--body-numbering': 'any', '--section-delimiter': 'any', '--footer-numbering': 'any', '--header-numbering': 'any', '--line-increment': 'number', '--join-blank-lines': 'number', '--number-format': 'any', '--number-separator': 'any', '--starting-line-number': 'number', '--number-width': 'number' } },
  },
  jq: {
    id: 'jq', risk: 'none', readsContent: true, positional: 'first-script-then-paths', scriptOptions: ['-f', '--from-file'],
    grammar: { shortSwitches: 'rjaSCMcsenR', shortValues: { f: 'path', L: 'path' }, longSwitches: ['--raw-output', '--join-output', '--ascii-output', '--sort-keys', '--color-output', '--monochrome-output', '--compact-output', '--slurp', '--exit-status', '--null-input', '--raw-input', '--tab', '--stream', '--stream-errors', '--seq', '--args', '--jsonargs', '--raw-output0', '--unbuffered', ...COMMON_LONG_HELP], longValues: { '--indent': 'number', '--from-file': 'path', '--arg': 'any', '--argjson': 'any', '--slurpfile': 'any', '--rawfile': 'any' } },
  },
  git: { id: 'git', risk: 'low', readsContent: true, positional: 'any', grammar: {} },
  pwd: { id: 'pwd', risk: 'none', readsContent: false, positional: 'none', grammar: { shortSwitches: 'LP', longSwitches: ['--logical', '--physical', ...COMMON_LONG_HELP] } },
  whoami: { id: 'whoami', risk: 'none', readsContent: false, positional: 'none', grammar: { longSwitches: COMMON_LONG_HELP } },
  id: { id: 'id', risk: 'none', readsContent: false, positional: 'any', grammar: { shortSwitches: 'aZgGnruz', longSwitches: ['--context', '--group', '--groups', '--name', '--real', '--user', '--zero', ...COMMON_LONG_HELP] } },
  uname: { id: 'uname', risk: 'none', readsContent: false, positional: 'none', grammar: { shortSwitches: 'asnrvmpio', longSwitches: ['--all', '--kernel-name', '--nodename', '--kernel-release', '--kernel-version', '--machine', '--processor', '--hardware-platform', '--operating-system', ...COMMON_LONG_HELP] } },
  hostname: { id: 'hostname', risk: 'none', readsContent: false, positional: 'none', grammar: { shortSwitches: 'sfdiIaAy', longSwitches: ['--short', '--fqdn', '--long', '--domain', '--ip-address', '--all-ip-addresses', ...COMMON_LONG_HELP] } },
  which: { id: 'which', risk: 'none', readsContent: false, positional: 'any', grammar: { shortSwitches: 'as', longSwitches: ['--all', '--silent', '--skip-alias', '--skip-functions', ...COMMON_LONG_HELP] } },
  ps: { id: 'ps', risk: 'low', readsContent: false, positional: 'any', grammar: { permissiveLong: true, shortSwitches: 'aAdefFgGhHjlLmMnNopPqrRsStTuUvVwxXyZcCTe', shortValues: { o: 'any', p: 'any', u: 'any', U: 'any', g: 'any', G: 'any', s: 'any', t: 'any', C: 'any', q: 'any', w: 'any' } } },
  df: { id: 'df', risk: 'low', readsContent: false, positional: 'paths', grammar: { shortSwitches: 'aBhHiklPTvx', shortValues: { B: 'any', t: 'any', x: 'any' }, permissiveLong: true, longValues: { '--block-size': 'any', '--type': 'any', '--exclude-type': 'any', '--output': 'any' } } },
  echo: { id: 'echo', risk: 'none', readsContent: false, positional: 'any', grammar: { shortSwitches: 'neE' } },
  printf: { id: 'printf', risk: 'none', readsContent: false, positional: 'any', grammar: { shortSwitches: 'v', longSwitches: COMMON_LONG_HELP } },
  date: { id: 'date', risk: 'none', readsContent: false, positional: 'any', grammar: { shortSwitches: 'uRI', shortValues: { d: 'any', r: 'path', I: 'any' }, deniedShort: 's', longSwitches: ['--utc', '--universal', '--rfc-email', '--rfc-2822', '--debug', ...COMMON_LONG_HELP], longValues: { '--date': 'any', '--reference': 'path', '--iso-8601': 'any', '--rfc-3339': 'any', '--resolution': 'any' }, deniedLong: ['--set', '--file'] } },
  env: { id: 'env', risk: 'low', readsContent: false, positional: 'none', grammar: { shortSwitches: '0', longSwitches: ['--null', ...COMMON_LONG_HELP] } },
  printenv: { id: 'printenv', risk: 'low', readsContent: false, positional: 'any', grammar: { shortSwitches: '0', longSwitches: ['--null', ...COMMON_LONG_HELP] } },
  basename: { id: 'basename', risk: 'none', readsContent: false, positional: 'any', grammar: { shortSwitches: 'az', shortValues: { s: 'any' }, longSwitches: ['--multiple', '--zero', ...COMMON_LONG_HELP], longValues: { '--suffix': 'any' } } },
  dirname: { id: 'dirname', risk: 'none', readsContent: false, positional: 'any', grammar: { shortSwitches: 'z', longSwitches: ['--zero', ...COMMON_LONG_HELP] } },
  realpath: { id: 'realpath', risk: 'none', readsContent: false, positional: 'paths', grammar: { shortSwitches: 'eEmLPqsz', longSwitches: ['--canonicalize-existing', '--canonicalize-missing', '--logical', '--physical', '--quiet', '--strip', '--no-symlinks', '--zero', ...COMMON_LONG_HELP], longValues: { '--relative-to': 'path', '--relative-base': 'path' } } },
  readlink: { id: 'readlink', risk: 'none', readsContent: false, positional: 'paths', grammar: { shortSwitches: 'femnqsvz', longSwitches: ['--canonicalize', '--canonicalize-existing', '--canonicalize-missing', '--no-newline', '--quiet', '--silent', '--verbose', '--zero', ...COMMON_LONG_HELP] } },
  sha256sum: { id: 'sha256sum', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'bctwz', longSwitches: ['--binary', '--check', '--tag', '--text', '--zero', '--ignore-missing', '--quiet', '--status', '--strict', '--warn', ...COMMON_LONG_HELP] } },
  sha1sum: { id: 'sha1sum', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'bctwz', longSwitches: ['--binary', '--check', '--tag', '--text', '--zero', '--ignore-missing', '--quiet', '--status', '--strict', '--warn', ...COMMON_LONG_HELP] } },
  md5sum: { id: 'md5sum', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'bctwz', longSwitches: ['--binary', '--check', '--tag', '--text', '--zero', '--ignore-missing', '--quiet', '--status', '--strict', '--warn', ...COMMON_LONG_HELP] } },
  shasum: { id: 'shasum', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'bcpstwU0', shortValues: { a: 'number' }, longSwitches: ['--binary', '--check', '--portable', '--status', '--text', '--warn', '--strict', '--UNIVERSAL', ...COMMON_LONG_HELP], longValues: { '--algorithm': 'number' } } },
  cksum: { id: 'cksum', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'a', shortValues: { a: 'any' }, longSwitches: ['--untagged', '--tag', '--raw', '--base64', '--debug', ...COMMON_LONG_HELP], longValues: { '--algorithm': 'any', '--length': 'number' } } },
  diff: { id: 'diff', risk: 'none', readsContent: true, positional: 'paths', maxPositionals: 2, grammar: { shortSwitches: 'qsiEZbwBaTtdNrpylcuHeny', shortValues: { U: 'number', C: 'number', I: 'any', F: 'any', W: 'number', S: 'path', X: 'path', x: 'any', D: 'any', L: 'any' }, longSwitches: ['--brief', '--report-identical-files', '--ignore-case', '--ignore-tab-expansion', '--ignore-trailing-space', '--ignore-space-change', '--ignore-all-space', '--ignore-blank-lines', '--text', '--minimal', '--new-file', '--recursive', '--no-dereference', '--show-c-function', '--side-by-side', '--left-column', '--suppress-common-lines', '--expand-tabs', '--initial-tab', '--strip-trailing-cr', '--color', '--no-color', '--speed-large-files', '--normal', '--ed', '--rcs', ...COMMON_LONG_HELP], longValues: { '--unified': 'number', '--context': 'number', '--ignore-matching-lines': 'any', '--show-function-line': 'any', '--width': 'number', '--starting-file': 'path', '--exclude-from': 'path', '--exclude': 'any', '--ifdef': 'any', '--label': 'any', '--tabsize': 'number', '--color': 'any', '--palette': 'any', '--horizon-lines': 'number', '--line-format': 'any', '--old-line-format': 'any', '--new-line-format': 'any', '--unchanged-line-format': 'any', '--from-file': 'path', '--to-file': 'path' } } },
  cmp: { id: 'cmp', risk: 'none', readsContent: true, positional: 'paths', maxPositionals: 2, grammar: { shortSwitches: 'bls', shortValues: { i: 'any', n: 'number' }, longSwitches: ['--print-bytes', '--verbose', '--quiet', '--silent', ...COMMON_LONG_HELP], longValues: { '--ignore-initial': 'any', '--bytes': 'number' } } },
  comm: { id: 'comm', risk: 'none', readsContent: true, positional: 'paths', maxPositionals: 2, grammar: { shortSwitches: '123z', longSwitches: ['--check-order', '--nocheck-order', '--total', '--zero-terminated', ...COMMON_LONG_HELP], longValues: { '--output-delimiter': 'any' } } },
  paste: { id: 'paste', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'sz', shortValues: { d: 'any' }, longSwitches: ['--serial', '--zero-terminated', ...COMMON_LONG_HELP], longValues: { '--delimiters': 'any' } } },
  column: { id: 'column', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'tJxdeLnEHRWTh', shortValues: { s: 'any', c: 'number', o: 'any', N: 'any', R: 'any', W: 'any', H: 'any', T: 'any', E: 'any', l: 'number' }, permissiveLong: true, longValues: { '--separator': 'any', '--output-separator': 'any', '--output-width': 'number', '--table-columns': 'any', '--table-right': 'any', '--table-wrap': 'any', '--table-hide': 'any', '--table-truncate': 'any', '--table-noextreme': 'any', '--table-order': 'any', '--table-header-repeat': 'any', '--tree': 'any', '--tree-id': 'any', '--tree-parent': 'any', '--table-columns-limit': 'number' } } },
  fold: { id: 'fold', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'bs', shortValues: { w: 'number' }, longSwitches: ['--bytes', '--spaces', ...COMMON_LONG_HELP], longValues: { '--width': 'number' } } },
  expand: { id: 'expand', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'i', shortValues: { t: 'any' }, longSwitches: ['--initial', ...COMMON_LONG_HELP], longValues: { '--tabs': 'any' } } },
  unexpand: { id: 'unexpand', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'a', shortValues: { t: 'any' }, longSwitches: ['--all', '--first-only', ...COMMON_LONG_HELP], longValues: { '--tabs': 'any' } } },
  rev: { id: 'rev', risk: 'none', readsContent: true, positional: 'paths', grammar: { longSwitches: COMMON_LONG_HELP } },
  strings: { id: 'strings', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'afowTv', shortValues: { n: 'number', t: 'any', e: 'any', s: 'any', T: 'any' }, longSwitches: ['--all', '--data', '--print-file-name', '--include-all-whitespace', '--output-separator', '--unicode', ...COMMON_LONG_HELP], longValues: { '--bytes': 'number', '--radix': 'any', '--encoding': 'any', '--target': 'any', '--unicode': 'any', '--output-separator': 'any' } } },
  od: { id: 'od', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'abcdfiloxsvhDOXFIL', shortValues: { A: 'any', j: 'any', N: 'any', S: 'number', t: 'any', w: 'number' }, longSwitches: ['--output-duplicates', '--traditional', ...COMMON_LONG_HELP], longValues: { '--address-radix': 'any', '--skip-bytes': 'any', '--read-bytes': 'any', '--strings': 'number', '--format': 'any', '--width': 'number', '--endian': 'any' } } },
  hexdump: { id: 'hexdump', risk: 'none', readsContent: true, positional: 'paths', grammar: { shortSwitches: 'bcCdovx', shortValues: { e: 'any', n: 'number', s: 'any', L: 'any' }, deniedShort: 'f', longSwitches: ['--one-byte-octal', '--one-byte-char', '--canonical', '--two-bytes-decimal', '--two-bytes-octal', '--two-bytes-hex', '--no-squeezing', ...COMMON_LONG_HELP], longValues: { '--format': 'any', '--length': 'number', '--skip': 'any', '--color': 'any' }, deniedLong: ['--format-file'] } },
  xxd: { id: 'xxd', risk: 'none', readsContent: true, positional: 'paths', maxPositionals: 1, grammar: { shortSwitches: 'abEipruedh', shortValues: { c: 'number', g: 'number', l: 'number', s: 'any', o: 'any' } } },
  tree: { id: 'tree', risk: 'low', readsContent: false, positional: 'paths', grammar: { shortSwitches: 'adlfxpughDFqNsvtrCnAiSJXhQ', shortValues: { L: 'number', P: 'any', I: 'any', H: 'any', T: 'any' }, deniedShort: 'o', longSwitches: ['--noreport', '--charset', '--dirsfirst', '--filesfirst', '--prune', '--du', '--inodes', '--device', '--matchdirs', '--ignore-case', '--gitignore', ...COMMON_LONG_HELP], longValues: { '--filelimit': 'number', '--charset': 'any', '--sort': 'any', '--timefmt': 'any', '--fromfile': 'path', '--gitfile': 'path', '--info': 'any', '--infofile': 'path' } } },
  seq: { id: 'seq', risk: 'none', readsContent: false, positional: 'any', grammar: { shortSwitches: 'w', shortValues: { f: 'any', s: 'any' }, longSwitches: ['--equal-width', ...COMMON_LONG_HELP], longValues: { '--format': 'any', '--separator': 'any' } } },
  true: { id: 'true', risk: 'none', readsContent: false, positional: 'none', grammar: {} },
  false: { id: 'false', risk: 'none', readsContent: false, positional: 'none', grammar: {} },
};

export const PROGRAM_ALIASES: Readonly<Record<string, string>> = {
  gawk: 'awk', mawk: 'awk', nawk: 'awk', egrep: 'grep', fgrep: 'grep', ggrep: 'grep', gsed: 'sed', gtail: 'tail', ghead: 'head', gcat: 'cat', gfind: 'find', gsort: 'sort', gls: 'ls', gwc: 'wc', gdu: 'du', gstat: 'stat', ripgrep: 'rg', gdiff: 'diff', gdate: 'date', gecho: 'echo', gprintf: 'printf', gcut: 'cut', gtr: 'tr', guniq: 'uniq', gnl: 'nl', gtac: 'tac', gpaste: 'paste', gfold: 'fold', grev: 'rev', greadlink: 'readlink', grealpath: 'realpath', gbasename: 'basename', gdirname: 'dirname', gseq: 'seq', gsha256sum: 'sha256sum', gmd5sum: 'md5sum',
};

/** Version-only invocations are informational reads (`node --version`). */
export const VERSION_ONLY_PROGRAMS = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl', 'php', 'java', 'go', 'rustc', 'cargo', 'tsc', 'docker', 'gh']);
export const VERSION_FLAGS = new Set(['--version', '-v', '-V', 'version', '--v']);

export const PRIVILEGE_PROGRAMS = new Set(['sudo', 'doas', 'su', 'runas', 'pkexec']);
export const INTERPRETER_PROGRAMS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd', 'node', 'nodejs', 'python', 'python2', 'python3', 'perl', 'ruby', 'php', 'lua', 'tclsh', 'osascript', 'deno', 'bun', 'irb', 'ipython']);
export const EVAL_PROGRAMS = new Set(['eval', 'exec', 'source', '.', 'command', 'builtin', 'time', 'nice', 'nohup', 'timeout', 'watch', 'script', 'invoke-expression', 'iex', 'invoke-command', 'icm', 'start-process', 'saps', 'start', 'call']);
export const XARGS_PROGRAMS = new Set(['xargs', 'parallel', 'foreach-object', 'foreach', '%', 'where-object', 'where', '?']);
export const TEE_PROGRAMS = new Set(['tee', 'tee-object', 'out-file', 'set-content', 'add-content', 'sc', 'ac']);
