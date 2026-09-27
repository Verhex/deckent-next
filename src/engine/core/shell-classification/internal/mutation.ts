import { scanPosixCommand, type ShellReasonCode, type ShellStage, type ShellWord } from './scanner.js';
import { EVAL_PROGRAMS, INTERPRETER_PROGRAMS, PRIVILEGE_PROGRAMS, PROGRAM_ALIASES, TEE_PROGRAMS, XARGS_PROGRAMS } from './programs.js';
import type { ShellDialect, ShellReadOnlyVerdict } from './classify.js';
import type { ShellPathContext, ShellPathVerdict } from './grammar.js';
import type { ShellRiskClassification } from './risk.js';

/**
 * Narrow mutating tier (T-L4 slice 4a, owner 2026-09-27 q1). A separate layer beside the read-only classifier: it recognizes the
 * few programs that change workspace files in a checkable way (`mkdir`, `touch`, `cp`, `mv`), each with a small option grammar and
 * every path checked — sources through the read check, targets through the write check (inside the workspace, not denied, not on
 * the write floor, parent a real directory, target absent or a single-link regular file). It never demotes anything: the always-ask
 * floor (interpreters, privilege, eval, xargs, tee, package managers, network tools, any construct the strict scanner refuses,
 * PowerShell) is decided first and a narrow stage cannot override it. `rm` is deliberately not narrow (deletion, not modification).
 */
export type ShellWriteKind = 'new-directory' | 'file' | 'existing-file';
/** Write-target check (port; the composition implements it over the workspace scope and the write floor). */
export interface ShellWritePathContext { checkWrite(word: ShellWord, kind: ShellWriteKind): Promise<ShellPathVerdict> }
export type ShellMutationReason = ShellReasonCode | 'NARROW' | 'PACKAGE_MANAGER' | 'NETWORK_TOOL' | 'NOT_NARROW';
export interface ShellMutationVerdict {
  readonly tier: 'narrow' | 'always-ask' | 'unrecognized';
  readonly reasonCode: ShellMutationReason;
  readonly detail?: string;
}

export const PACKAGE_PROGRAMS: ReadonlySet<string> = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'corepack', 'pip', 'pip3', 'pipx', 'uv', 'poetry', 'conda', 'mamba',
  'cargo', 'rustup', 'gem', 'bundle', 'go', 'composer', 'apt', 'apt-get', 'dpkg', 'snap', 'brew', 'dnf', 'yum', 'rpm', 'apk', 'pacman', 'zypper', 'nix', 'nix-env']);
export const NETWORK_PROGRAMS: ReadonlySet<string> = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp',
  'http', 'https', 'aria2c', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']);

type Narrow = { readonly switches: string; readonly long: readonly string[];
  readonly positionals: (words: readonly ShellWord[]) => readonly { readonly word: ShellWord; readonly role: 'read' | ShellWriteKind }[] | null };
const NARROW_PROGRAMS: Readonly<Record<string, Narrow>> = {
  mkdir: { switches: 'pv', long: ['--parents', '--verbose'], positionals: words => words.length ? words.map(word => ({ word, role: 'new-directory' as const })) : null },
  touch: { switches: 'c', long: ['--no-create'], positionals: words => words.length ? words.map(word => ({ word, role: 'file' as const })) : null },
  cp: { switches: 'nv', long: ['--no-clobber', '--verbose'],
    positionals: words => words.length === 2 ? [{ word: words[0]!, role: 'read' as const }, { word: words[1]!, role: 'file' as const }] : null },
  mv: { switches: 'nv', long: ['--no-clobber', '--verbose'],
    positionals: words => words.length === 2 ? [{ word: words[0]!, role: 'existing-file' as const }, { word: words[1]!, role: 'file' as const }] : null },
};
const verdict = (tier: ShellMutationVerdict['tier'], reasonCode: ShellMutationReason, detail?: string): ShellMutationVerdict =>
  Object.freeze(detail === undefined ? { tier, reasonCode } : { tier, reasonCode, detail });

function alwaysAsk(name: string): ShellMutationVerdict | null {
  if (PRIVILEGE_PROGRAMS.has(name)) return verdict('always-ask', 'PRIVILEGE_ESCALATION', name);
  if (INTERPRETER_PROGRAMS.has(name)) return verdict('always-ask', 'INTERPRETER', name);
  if (EVAL_PROGRAMS.has(name)) return verdict('always-ask', 'EVAL', name);
  if (XARGS_PROGRAMS.has(name)) return verdict('always-ask', 'XARGS', name);
  if (TEE_PROGRAMS.has(name)) return verdict('always-ask', 'OUTPUT_TEE', name);
  if (PACKAGE_PROGRAMS.has(name)) return verdict('always-ask', 'PACKAGE_MANAGER', name);
  if (NETWORK_PROGRAMS.has(name)) return verdict('always-ask', 'NETWORK_TOOL', name);
  return null;
}

async function classifyStage(stage: ShellStage, reads: ShellPathContext, writes: ShellWritePathContext): Promise<ShellMutationVerdict> {
  const [head, ...args] = stage.words;
  if (head === undefined) return verdict('always-ask', 'UNPARSEABLE');
  if (!head.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(head.text)) return verdict('always-ask', 'ENV_ASSIGNMENT', head.text);
  if (head.text.includes('/') || head.text.includes('\\')) return verdict('always-ask', 'PROGRAM_PATH', head.text);
  const name = PROGRAM_ALIASES[head.text] ?? head.text;
  const floor = alwaysAsk(name.toLowerCase());
  if (floor) return floor;
  const spec = NARROW_PROGRAMS[name];
  if (!spec || stage.inputPaths.length > 0) return verdict('unrecognized', 'NOT_NARROW', name);
  const positional: ShellWord[] = [];
  let ended = false;
  for (const word of args) {
    if (ended || !word.text.startsWith('-') || word.text === '-') { positional.push(word); continue; }
    if (word.text === '--') { ended = true; continue; }
    if (word.text.startsWith('--') ? !spec.long.includes(word.text) : [...word.text.slice(1)].some(flag => !spec.switches.includes(flag))) {
      return verdict('unrecognized', 'FLAG_NOT_ALLOWLISTED', word.text);
    }
  }
  const roles = spec.positionals(positional);
  if (!roles) return verdict('unrecognized', 'NOT_NARROW', name);
  for (const { word, role } of roles) {
    // A path is exactly the text the program receives: no glob, no `~`, no leading `-` (a file named like an option), no `..`.
    if (word.glob || word.tilde || word.text.startsWith('-') || /(?:^|\/)\.\.(?:\/|$)/u.test(word.text)) return verdict('unrecognized', 'NOT_NARROW', word.text);
    const checked = role === 'read' ? await reads.check(word, true) : await writes.checkWrite(word, role);
    if (!checked.ok) return verdict('unrecognized', checked.reasonCode, checked.detail);
  }
  return verdict('narrow', 'NARROW', name);
}

/**
 * Whether a command is in the narrow mutating set: exactly one simple command — one pipeline of one stage, no `&&`, `;`, `||`, newline or
 * pipe — that is a recognized narrow program with checked paths. Its paths are checked on the file system as it is before the command
 * runs, which is what the program then meets only when no earlier part of the same command ran first (Astra 2133: `mkdir out && cp
 * package.json out` passed as an absent copy target, then the copy wrote `out/package.json` on the write floor). `always-ask` names the
 * floor that no mode lowers (decided over every part of any command first); `unrecognized` is any other modifying command (it asks).
 */
export async function classifyShellMutation(command: string, reads: ShellPathContext, writes: ShellWritePathContext,
  dialect: ShellDialect = 'posix'): Promise<ShellMutationVerdict> {
  if (dialect !== 'posix') return verdict('always-ask', 'UNSUPPORTED_DIALECT', dialect);
  if (typeof command !== 'string' || command.trim().length === 0) return verdict('always-ask', 'EMPTY_COMMAND');
  const scan = scanPosixCommand(command);
  if (!scan.ok) return verdict('always-ask', scan.reasonCode, scan.detail);
  if (scan.pipelines.length === 0) return verdict('always-ask', 'EMPTY_COMMAND');
  // The floor is decided over every stage first, so a narrow stage never hides an always-ask one.
  const stages = scan.pipelines.flat();
  for (const stage of stages) {
    const name = stage.words[0]?.text;
    const floor = name === undefined ? null : alwaysAsk((PROGRAM_ALIASES[name] ?? name).toLowerCase());
    if (floor) return floor;
  }
  if (scan.pipelines.length !== 1) return verdict('unrecognized', 'NOT_NARROW', ';');
  const [only, ...piped] = scan.pipelines[0]!;
  if (only === undefined || piped.length > 0) return verdict('unrecognized', 'NOT_NARROW', '|');
  return classifyStage(only, reads, writes);
}

/** The permission tier of a shell command (what the mode decision sees as the call's cell); worst wins, destructive first. */
export type ShellPermissionTier = 'read-none' | 'read-low' | 'narrow-mutating' | 'destructive' | 'always-ask' | 'other-modify';
export function shellPermissionTier(risk: ShellRiskClassification, readOnly: ShellReadOnlyVerdict, mutation: ShellMutationVerdict): ShellPermissionTier {
  if (risk.risk === 'destructive') return 'destructive';
  if (readOnly.readOnly) {
    if (risk.risk !== 'safe-read') return 'other-modify';
    return readOnly.risk === 'none' ? 'read-none' : 'read-low';
  }
  if (mutation.tier === 'always-ask') return 'always-ask';
  return mutation.tier === 'narrow' && risk.risk === 'modify' ? 'narrow-mutating' : 'other-modify';
}
