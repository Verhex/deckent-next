import { lenientShellScan, type ShellCommandScan } from './scan.js';
import { FIND_ACTIONS, GIT_BRANCH_FLAGS, GIT_READ_SUBCOMMANDS } from './tables.js';
import { PROGRAMS } from './programs.js';
import type { ShellReadOnlyVerdict } from './classify.js';
import { registeredDestructiveReason } from './destructive-commands.js';

export type ShellRisk = 'safe-read' | 'modify' | 'destructive';
export interface ShellRiskClassification { readonly risk: ShellRisk; readonly reason: string }

/*
 * Risk tiers of a shell command (legacy `shell-risk.ts` @a8b67e2a1, kept as is): a lenient segment scanner exposes every compound
 * part and command substitution; the worst part wins; the destructive table (rm -r/-f, rmdir, git push --force, reset --hard,
 * clean -f, chmod/chown -R, dd, mkfs, shred, truncate, kill, docker rm/rmi/system prune, deckent kill/cleanup/recover) is the
 * always-ask floor that full-auto never lowers; find -delete, moves and truncating output redirection are also destructive. Appending redirection (to anything but /dev/null or a descriptor), tee and anything unparseable are `modify`. `safe-read` is owned by the
 * read-only classifier alone: the scanner here can never promote a command to it.
 */
const RISK_WEIGHT: Record<ShellRisk, number> = {
  'safe-read': 0,
  modify: 1,
  destructive: 2,
};

function commandName(token: string): string {
  const normalized = token.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

function combine(current: ShellRiskClassification, candidate: ShellRiskClassification): ShellRiskClassification {
  return RISK_WEIGHT[candidate.risk] > RISK_WEIGHT[current.risk] ? candidate : current;
}

function hasAnyOption(tokens: string[], shortOptions: string[], longOptions: string[]): boolean {
  return tokens.some((token) => {
    if (longOptions.includes(token)) return true;
    if (!/^-[^-]/.test(token)) return false;
    return shortOptions.some((option) => token.slice(1).includes(option));
  });
}

function destructiveReason(words: string[]): string | null {
  const binary = commandName(words[0] ?? '');
  const args = words.slice(1);
  if (binary === 'rm' && hasAnyOption(args, ['r', 'R', 'f'], ['--recursive', '--force'])) return 'shell.destructive.rm-recursive-or-force';
  if (binary === 'find' && args.includes('-delete')) return 'shell.destructive.find-delete';
  // A move removes source names and can overwrite destinations, including outside the project.
  if (binary === 'mv') return 'shell.destructive.move';
  if (binary === 'rmdir') return 'shell.destructive.rmdir';
  if (binary === 'git') {
    const pushIndex = args.indexOf('push');
    if (pushIndex >= 0 && hasAnyOption(args.slice(pushIndex + 1), ['f'], ['--force', '--force-with-lease', '--force-if-includes'])) return 'shell.destructive.git-force-push';
    const resetIndex = args.indexOf('reset');
    if (resetIndex >= 0 && args.slice(resetIndex + 1).includes('--hard')) return 'shell.destructive.git-reset-hard';
    const cleanIndex = args.indexOf('clean');
    if (cleanIndex >= 0 && hasAnyOption(args.slice(cleanIndex + 1), ['f'], ['--force'])) return 'shell.destructive.git-clean-force';
  }
  if ((binary === 'chmod' || binary === 'chown') && hasAnyOption(args, ['R'], ['--recursive'])) return `shell.destructive.${binary}-recursive`;
  if (binary === 'dd') return 'shell.destructive.dd';
  if (binary === 'mkfs' || binary.startsWith('mkfs.')) return 'shell.destructive.mkfs';
  if (binary === 'shred') return 'shell.destructive.shred';
  if (binary === 'truncate') return 'shell.destructive.truncate';
  if (binary === 'kill' || binary === 'pkill' || binary === 'killall') return `shell.destructive.${binary}`;
  if (binary === 'docker') {
    if (args.includes('rm')) return 'shell.destructive.docker-rm';
    if (args.includes('rmi')) return 'shell.destructive.docker-rmi';
    const systemIndex = args.indexOf('system');
    if (systemIndex >= 0 && args[systemIndex + 1] === 'prune') return 'shell.destructive.docker-system-prune';
  }
  return registeredDestructiveReason(binary, args);
}

function isReadOnlyGitBranch(args: string[]): boolean {
  if (args.length === 0) return true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--list') continue;
    if (GIT_BRANCH_FLAGS[arg]?.legacyRisk && !GIT_BRANCH_FLAGS[arg]?.value) continue;
    if (GIT_BRANCH_FLAGS[arg]?.value) {
      if (index + 1 >= args.length) return false;
      index++;
      continue;
    }
    if (Object.entries(GIT_BRANCH_FLAGS).some(([flag, rule]) => rule.value && arg.startsWith(`${flag}=`))) continue;
    // Patterns following --list are filters, not branch creation.
    if (args.includes('--list')) continue;
    return false;
  }
  return true;
}

function classifySegment(words: string[] | null): ShellRiskClassification {
  if (!words || words.length === 0) return { risk: 'modify', reason: 'shell.modify.unparseable' };
  const binary = commandName(words[0]!);
  const args = words.slice(1);
  const destructive = destructiveReason(words);
  if (destructive) return { risk: 'destructive', reason: destructive };
  if (binary === 'tee') return { risk: 'modify', reason: 'shell.modify.output-redirection' };
  if (PROGRAMS[binary]?.legacyRiskRead === true) return { risk: 'safe-read', reason: `shell.safe-read.${binary}` };
  if (binary === 'find') {
    if (args.some((arg) => FIND_ACTIONS[arg]?.riskAction)) return { risk: 'modify', reason: 'shell.modify.find-action' };
    return { risk: 'safe-read', reason: 'shell.safe-read.find' };
  }
  if (binary === 'env') {
    const onlyEnvironmentReads = args.every((arg) => arg.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(arg));
    return onlyEnvironmentReads
      ? { risk: 'safe-read', reason: 'shell.safe-read.env' }
      : { risk: 'modify', reason: 'shell.modify.env-command' };
  }
  if (binary === 'node' || binary === 'npm' || binary === 'npx') {
    return args.length === 1 && (args[0] === '--version' || args[0] === '-v')
      ? { risk: 'safe-read', reason: `shell.safe-read.${binary}-version` }
      : { risk: 'modify', reason: `shell.modify.${binary}-execution` };
  }
  if (binary === 'git') {
    const subcommandIndex = args.findIndex((arg) => GIT_READ_SUBCOMMANDS[arg]?.legacyRisk || arg === 'branch');
    if (subcommandIndex >= 0) {
      const subcommand = args[subcommandIndex]!;
      if (subcommand !== 'branch' || isReadOnlyGitBranch(args.slice(subcommandIndex + 1))) {
        return { risk: 'safe-read', reason: `shell.safe-read.git-${subcommand}` };
      }
    }
    return { risk: 'modify', reason: 'shell.modify.git-command' };
  }
  return { risk: 'modify', reason: 'shell.modify.unknown-command' };
}

/** The risk of a command given its read-only verdict: destructive and modify from the scan are never demoted by the classifier.
 * R9 (`readOnlyOwnsRead`, a Run worker only): a program the legacy segment list does not know but the strict read-only classifier admitted
 * (`od`, `sha256sum`, `test`, `sed -n`…) is not `modify` on that ground alone; every destructive and redirection signal still counts. */
export function classifyShellRisk(command: string, readOnly: ShellReadOnlyVerdict, readOnlyOwnsRead = false, shared?: ShellCommandScan): ShellRiskClassification {
  const scan = lenientShellScan(command, shared);
  let result: ShellRiskClassification = { risk: 'safe-read', reason: 'shell.safe-read.compound' };
  if (scan.segments.length === 0) result = { risk: 'modify', reason: 'shell.modify.empty-command' };
  for (const words of scan.words) { const part = classifySegment(words); if (!(readOnlyOwnsRead && readOnly.readOnly && part.reason === 'shell.modify.unknown-command')) result = combine(result, part); }
  if (scan.malformed) result = combine(result, { risk: 'modify', reason: 'shell.modify.unparseable' });
  if (scan.truncatingRedirect) result = combine(result, { risk: 'destructive', reason: 'shell.destructive.output-truncation' });
  if (scan.outputRedirect) result = combine(result, { risk: 'modify', reason: 'shell.modify.output-redirection' });
  if (result.risk !== 'safe-read') return Object.freeze(result);
  if (readOnly.readOnly) return Object.freeze({ risk: 'safe-read', reason: `shell.safe-read.${readOnly.programs[0] ?? 'compound'}` });
  return Object.freeze({ risk: 'modify', reason: `shell.modify.${readOnly.reasonCode.toLowerCase().replace(/_/gu, '-')}` });
}
