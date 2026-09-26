import { scanPosixCommand, type ShellReasonCode, type ShellStage } from './scanner.js';
import { EVAL_PROGRAMS, INTERPRETER_PROGRAMS, PRIVILEGE_PROGRAMS, PROGRAM_ALIASES, PROGRAMS, TEE_PROGRAMS, VERSION_FLAGS, VERSION_ONLY_PROGRAMS,
  XARGS_PROGRAMS, type ShellReadRisk } from './programs.js';
import { checkFind, checkGit, checkPositionals, stageFail, walkOptions, type ShellPathContext, type StageVerdict } from './grammar.js';

export type ShellDialect = 'posix' | 'powershell';
export interface ShellReadOnlyVerdict {
  readonly readOnly: boolean;
  /** `none`: bounded local reads; `low`: traversal or environment exposure; null when not read-only. */
  readonly risk: ShellReadRisk | null;
  readonly reasonCode: ShellReasonCode;
  /** Canonical program per stage, as far as classified. */
  readonly programs: readonly string[];
  readonly stageCount: number;
  /** The technical token behind a refusal (program, flag or path); never prose. */
  readonly detail?: string;
}

function programFailure(name: string): StageVerdict | null {
  if (PRIVILEGE_PROGRAMS.has(name)) return stageFail('PRIVILEGE_ESCALATION', name);
  if (INTERPRETER_PROGRAMS.has(name)) return stageFail('INTERPRETER', name);
  if (EVAL_PROGRAMS.has(name)) return stageFail('EVAL', name);
  if (XARGS_PROGRAMS.has(name)) return stageFail('XARGS', name);
  if (TEE_PROGRAMS.has(name)) return stageFail('OUTPUT_TEE', name);
  return null;
}

async function classifyStage(stage: ShellStage, paths: ShellPathContext): Promise<{ readonly program: string; readonly verdict: StageVerdict }> {
  const [head, ...args] = stage.words;
  if (head === undefined) return { program: '', verdict: stageFail('UNPARSEABLE') };
  if (!head.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(head.text)) return { program: head.text, verdict: stageFail('ENV_ASSIGNMENT', head.text) };
  const raw = head.text;
  if (raw.includes('/') || raw.includes('\\')) return { program: raw, verdict: stageFail('PROGRAM_PATH', raw) };
  const name = PROGRAM_ALIASES[raw] ?? raw;
  for (const input of stage.inputPaths) {
    const verdict = await paths.check(input, true);
    if (!verdict.ok) return { program: name, verdict: stageFail(verdict.reasonCode, verdict.detail) };
  }
  if (VERSION_ONLY_PROGRAMS.has(name) && args.length === 1 && VERSION_FLAGS.has(args[0]!.text)) return { program: name, verdict: { ok: true, risk: 'none' } };
  const failure = programFailure(name);
  if (failure) return { program: name, verdict: failure };
  if (name === 'find') return { program: name, verdict: await checkFind(args, paths) };
  if (name === 'git') return { program: name, verdict: await checkGit(args, paths) };
  const spec = PROGRAMS[name];
  if (spec === undefined) return { program: name, verdict: stageFail('PROGRAM_NOT_ALLOWLISTED', name) };
  if (name === 'env' && args.some(arg => !arg.text.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(arg.text))) return { program: name, verdict: stageFail('EVAL', 'env') };
  const walk = await walkOptions(spec, name === 'env' ? args.filter(arg => arg.text.startsWith('-')) : args, paths);
  if (walk.verdict) return { program: name, verdict: walk.verdict };
  return { program: name, verdict: await checkPositionals(spec, walk, paths) };
}

/**
 * Whether a shell command string is read-only (T-L4 slice 3a; legacy `classifyReadOnlyShellCommand` @a8b67e2a1, POSIX only).
 * Allowlist and fail closed: read-only only when every stage of every pipeline is an allowlisted program with allowlisted options,
 * every path argument passes the workspace check, and no construct can run code or write bytes. The PowerShell dialect is not
 * ported: every PowerShell command is `UNSUPPORTED_DIALECT` (not read-only, so the owner is asked).
 */
export async function classifyReadOnlyShellCommand(command: string, paths: ShellPathContext, dialect: ShellDialect = 'posix'): Promise<ShellReadOnlyVerdict> {
  const refuse = (reasonCode: ShellReasonCode, detail?: string, programs: readonly string[] = [], stageCount = 0): ShellReadOnlyVerdict =>
    Object.freeze({ readOnly: false, risk: null, reasonCode, programs, stageCount, ...(detail === undefined ? {} : { detail }) });
  if (dialect !== 'posix') return refuse('UNSUPPORTED_DIALECT', dialect);
  if (typeof command !== 'string' || command.trim().length === 0) return refuse('EMPTY_COMMAND');
  const scan = scanPosixCommand(command);
  if (!scan.ok) return refuse(scan.reasonCode, scan.detail);
  if (scan.pipelines.length === 0) return refuse('EMPTY_COMMAND');
  const programs: string[] = [];
  let risk: ShellReadRisk = 'none', stageCount = 0;
  for (const pipeline of scan.pipelines) {
    for (const stage of pipeline) {
      stageCount++;
      const outcome = await classifyStage(stage, paths);
      if (outcome.program.length > 0) programs.push(outcome.program);
      if (!outcome.verdict.ok) return refuse(outcome.verdict.reasonCode, outcome.verdict.detail, programs, stageCount);
      if (outcome.verdict.risk === 'low') risk = 'low';
    }
  }
  return Object.freeze({ readOnly: true, risk, reasonCode: 'READ_ONLY' as const, programs, stageCount });
}
