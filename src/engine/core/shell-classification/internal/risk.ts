import type { ShellReadOnlyVerdict } from './classify.js';

export type ShellRisk = 'safe-read' | 'modify' | 'destructive';
export interface ShellRiskClassification { readonly risk: ShellRisk; readonly reason: string }

/*
 * Risk tiers of a shell command (legacy `shell-risk.ts` @a8b67e2a1, kept as is): a lenient segment scanner exposes every compound
 * part and command substitution; the worst part wins; the destructive table (rm -r/-f, rmdir, git push --force, reset --hard,
 * clean -f, chmod/chown -R, dd, mkfs, shred, truncate, kill, docker rm/rmi/system prune, deckent kill/cleanup/recover) is the
 * always-ask floor that no mode lowers; output redirection, tee and anything unparseable are `modify`. `safe-read` is owned by the
 * read-only classifier alone: the scanner here can never promote a command to it.
 */
interface ShellScan {
  segments: string[];
  outputRedirect: boolean;
  malformed: boolean;
}

const RISK_WEIGHT: Record<ShellRisk, number> = {
  'safe-read': 0,
  modify: 1,
  destructive: 2,
};

const SIMPLE_READ_BINARIES = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'grep', 'rg', 'wc', 'stat', 'file', 'pwd',
  'which', 'whoami', 'du', 'df', 'ps', 'echo', 'printenv',
]);

const GIT_READ_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show']);
const GIT_BRANCH_FLAG_WITH_VALUE = new Set([
  '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format',
  '--sort',
]);
const GIT_BRANCH_READ_FLAGS = new Set([
  '-a', '-r', '-v', '-vv', '--all', '--remotes', '--verbose', '--show-current',
  '--color', '--no-color', '--column', '--no-column', '--ignore-case',
]);

function commandName(token: string): string {
  const normalized = token.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

function combine(current: ShellRiskClassification, candidate: ShellRiskClassification): ShellRiskClassification {
  return RISK_WEIGHT[candidate.risk] > RISK_WEIGHT[current.risk] ? candidate : current;
}

/**
 * Split shell control operators while respecting quotes, and recursively expose
 * command substitutions as independent segments. The scanner intentionally does
 * not try to execute or expand shell syntax: malformed input remains conservative.
 */
function scanShell(command: string): ShellScan {
  const scan: ShellScan = { segments: [], outputRedirect: false, malformed: false };
  let segment = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = (): void => {
    if (segment.trim() !== '') scan.segments.push(segment.trim());
    segment = '';
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (escaped) {
      segment += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      segment += char;
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      segment += char;
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      segment += char;
      continue;
    }

    if (quote !== "'" && char === '$' && command[index + 1] === '(') {
      let depth = 1;
      let innerQuote: "'" | '"' | null = null;
      let innerEscaped = false;
      let end = index + 2;
      for (; end < command.length; end++) {
        const nested = command[end]!;
        if (innerEscaped) { innerEscaped = false; continue; }
        if (nested === '\\' && innerQuote !== "'") { innerEscaped = true; continue; }
        if (nested === "'" && innerQuote !== '"') { innerQuote = innerQuote === "'" ? null : "'"; continue; }
        if (nested === '"' && innerQuote !== "'") { innerQuote = innerQuote === '"' ? null : '"'; continue; }
        if (innerQuote === null && nested === '(') depth++;
        if (innerQuote === null && nested === ')' && --depth === 0) break;
      }
      if (depth !== 0 || innerQuote !== null || innerEscaped) {
        scan.malformed = true;
        segment += command.slice(index);
        break;
      }
      const nested = scanShell(command.slice(index + 2, end));
      scan.segments.push(...nested.segments);
      scan.outputRedirect ||= nested.outputRedirect;
      scan.malformed ||= nested.malformed;
      segment += '__shell_substitution__';
      index = end;
      continue;
    }

    if (quote !== "'" && char === '`') {
      let end = index + 1;
      let innerEscaped = false;
      for (; end < command.length; end++) {
        const nested = command[end]!;
        if (innerEscaped) { innerEscaped = false; continue; }
        if (nested === '\\') { innerEscaped = true; continue; }
        if (nested === '`') break;
      }
      if (end >= command.length) {
        scan.malformed = true;
        segment += command.slice(index);
        break;
      }
      const nested = scanShell(command.slice(index + 1, end));
      scan.segments.push(...nested.segments);
      scan.outputRedirect ||= nested.outputRedirect;
      scan.malformed ||= nested.malformed;
      segment += '__shell_substitution__';
      index = end;
      continue;
    }

    if (quote === null && char === '>') {
      scan.outputRedirect = true;
      segment += char;
      continue;
    }
    if (quote === null && (char === ';' || char === '|' || char === '\n')) {
      flush();
      if (command[index + 1] === char && char === '|') index++;
      continue;
    }
    if (quote === null && char === '&') {
      flush();
      if (command[index + 1] === '&') index++;
      else scan.malformed = true;
      continue;
    }
    segment += char;
  }

  if (quote !== null || escaped) scan.malformed = true;
  flush();
  return scan;
}

function shellWords(segment: string): string[] | null {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const flush = (): void => {
    if (started) words.push(word);
    word = '';
    started = false;
  };

  for (const char of segment) {
    if (escaped) { word += char; started = true; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (char === "'" && quote !== '"') { quote = quote === "'" ? null : "'"; started = true; continue; }
    if (char === '"' && quote !== "'") { quote = quote === '"' ? null : '"'; started = true; continue; }
    if (quote === null && /\s/.test(char)) { flush(); continue; }
    word += char;
    started = true;
  }
  if (quote !== null || escaped) return null;
  flush();
  return words;
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
  if (binary === 'deckent' && args.some((arg) => arg === 'kill' || arg === 'cleanup' || arg === 'recover')) return 'shell.destructive.deckent-lifecycle';
  return null;
}

function isReadOnlyGitBranch(args: string[]): boolean {
  if (args.length === 0) return true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--list') continue;
    if (GIT_BRANCH_READ_FLAGS.has(arg)) continue;
    if (GIT_BRANCH_FLAG_WITH_VALUE.has(arg)) {
      if (index + 1 >= args.length) return false;
      index++;
      continue;
    }
    if ([...GIT_BRANCH_FLAG_WITH_VALUE].some((flag) => arg.startsWith(`${flag}=`))) continue;
    // Patterns following --list are filters, not branch creation.
    if (args.includes('--list')) continue;
    return false;
  }
  return true;
}

function classifySegment(segment: string): ShellRiskClassification {
  const words = shellWords(segment);
  if (!words || words.length === 0) return { risk: 'modify', reason: 'shell.modify.unparseable' };
  const binary = commandName(words[0]!);
  const args = words.slice(1);
  const destructive = destructiveReason(words);
  if (destructive) return { risk: 'destructive', reason: destructive };
  if (binary === 'tee') return { risk: 'modify', reason: 'shell.modify.output-redirection' };
  if (SIMPLE_READ_BINARIES.has(binary)) return { risk: 'safe-read', reason: `shell.safe-read.${binary}` };
  if (binary === 'find') {
    if (args.some((arg) => arg === '-delete' || arg === '-exec' || arg === '-execdir')) return { risk: 'modify', reason: 'shell.modify.find-action' };
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
    const subcommandIndex = args.findIndex((arg) => GIT_READ_SUBCOMMANDS.has(arg) || arg === 'branch');
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

/** The risk of a command given its read-only verdict: destructive and modify from the scan are never demoted by the classifier. */
export function classifyShellRisk(command: string, readOnly: ShellReadOnlyVerdict): ShellRiskClassification {
  const scan = scanShell(command);
  let result: ShellRiskClassification = { risk: 'safe-read', reason: 'shell.safe-read.compound' };
  if (scan.segments.length === 0) result = { risk: 'modify', reason: 'shell.modify.empty-command' };
  for (const segment of scan.segments) result = combine(result, classifySegment(segment));
  if (scan.malformed) result = combine(result, { risk: 'modify', reason: 'shell.modify.unparseable' });
  if (scan.outputRedirect) result = combine(result, { risk: 'modify', reason: 'shell.modify.output-redirection' });
  if (result.risk !== 'safe-read') return Object.freeze(result);
  if (readOnly.readOnly) return Object.freeze({ risk: 'safe-read', reason: `shell.safe-read.${readOnly.programs[0] ?? 'compound'}` });
  return Object.freeze({ risk: 'modify', reason: `shell.modify.${readOnly.reasonCode.toLowerCase().replace(/_/gu, '-')}` });
}
