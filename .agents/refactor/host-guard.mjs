#!/usr/bin/env node
// Vendor-neutral development guardrails for the Next checkout.
// Host tooling only: never part of the product, never a product authority.
// Reads one hook event as JSON on stdin, writes one decision as JSON on stdout.
// Exit code is always 0 (fail-open): a crash or unknown event never blocks work;
// only an explicit, reason-bearing deny/block in the JSON does.
//
// Usage: node host-guard.mjs <event> [--root <checkout>] [--legacy <dir>]
//   event: pre-tool | post-tool | session-start
// Input shape (Claude Code hook JSON): { tool_name, tool_input: { command | file_path }, ... }
// Other harnesses (Codex/Cursor) can call the same script by adapting their event payload.
//
// Command analysis works per shell segment (split on newline ; && || |) and looks at the
// verb and its arguments, so a path or word that merely appears inside an echo/grep string
// never triggers a denial (false-block cases are covered by host-guard.test.mjs).

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_VERBS = new Set(['node', 'bash', 'sh', 'zsh', 'tsx', 'deno', 'bun', 'source', '.']);
const PKG_VERBS = new Set(['npm', 'npx', 'pnpm', 'yarn']);
const CONTAINER_VERBS = new Set(['docker', 'docker-compose', 'podman']);
const NEXT_BINS = new Set(['deckent', 'deckent-mcp']);
const MEMORY_DIR = ['.deckent', 'docs', 'core-memory'].join(sep);
const LINE_CAP = 70;

function segments(command) {
  return command.split(/\r?\n|&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean).map(s => {
    const tokens = s.split(/\s+/).map(t => t.replace(/^['"]|['"]$/g, ''));
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
    if (tokens[0] === 'sudo' || tokens[0] === 'env' || tokens[0] === 'time') tokens.shift();
    return tokens;
  }).filter(t => t.length);
}

export function legacyExecution(command, legacy) {
  const isLegacy = t => t.includes(legacy) || /(^|\/)deckent-dev(\/|$)/.test(t);
  let cwdLegacy = false;
  for (const tokens of segments(command)) {
    const verb = tokens[0];
    const args = tokens.slice(1);
    if (verb === 'cd' || verb === 'pushd') { cwdLegacy = args[0] ? isLegacy(args[0]) : false; continue; }
    const firstPath = args.find(t => !t.startsWith('-'));
    if (SCRIPT_VERBS.has(verb)) {
      if (firstPath && (isLegacy(firstPath) || (cwdLegacy && !firstPath.startsWith('/')))) return true;
    } else if (PKG_VERBS.has(verb)) {
      if (cwdLegacy) return true;
      const i = args.findIndex(t => t === '--prefix' || t === '-C');
      if (i >= 0 && args[i + 1] && isLegacy(args[i + 1])) return true;
    } else if (CONTAINER_VERBS.has(verb)) {
      if (cwdLegacy || args.some(isLegacy)) return true;
    } else if (NEXT_BINS.has(verb)) {
      if (cwdLegacy) return true;
    } else if ((verb.startsWith('/') || verb.startsWith('./')) && (isLegacy(verb) || (cwdLegacy && verb.startsWith('./')))) {
      return true;
    }
  }
  return false;
}

export function recursiveRm(command) {
  return segments(command).some(([verb, ...args]) => verb === 'rm' && args.some(a => a === '--recursive' || (/^-[a-zA-Z]+$/.test(a) && /[rR]/.test(a))));
}

export function buildCommand(command) {
  return segments(command).some(([verb, ...args]) => {
    if (verb === 'npm' || verb === 'pnpm' || verb === 'yarn') return args[0] === 'run' ? ['build', 'verify'].includes(args[1]) : ['build', 'verify'].includes(args[0]);
    if (verb === 'node') return args.some(a => a.endsWith('scripts/build.mjs'));
    if (verb === 'tsc' || verb === 'npx' && args[0] === 'tsc') return !args.includes('--noEmit');
    return false;
  });
}

export function guard(event, input, ctx) {
  const root = resolve(ctx.root);
  const legacy = resolve(ctx.legacy);
  const tool = input?.tool_name ?? '';
  const command = typeof input?.tool_input?.command === 'string' ? input.tool_input.command : '';
  const filePath = typeof input?.tool_input?.file_path === 'string' ? resolve(root, input.tool_input.file_path) : '';
  const inside = (p, dir) => p === dir || p.startsWith(dir + sep);

  if (event === 'pre-tool') {
    if (tool === 'Bash' && command) {
      if (legacyExecution(command, legacy)) return deny('deckent-dev is a frozen read-only reference (CLAUDE.md). Executing its runtime/workers is not allowed; read it with cat/grep/git instead.');
      if (recursiveRm(command)) return deny('Recursive rm is reserved for the owner (memory: owner runs blocked rm). Ask the owner to run it or move the path to the scratchpad.');
      if (buildCommand(command) && ctx.vitestRunning()) return deny('A vitest suite is running (CLAUDE.md: no build during an active test suite). Wait for it to finish, then build or verify.');
      return pass();
    }
    if ((tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') && filePath && inside(filePath, legacy)) {
      return deny('deckent-dev is read-only legacy evidence (CLAUDE.md); write into deckent-next instead.');
    }
    return pass();
  }

  if (event === 'post-tool') {
    if (!filePath) return pass();
    const rel = filePath.startsWith(root + sep) ? filePath.slice(root.length + 1) : null;
    if (rel === 'CLAUDE.md' || rel === 'AGENTS.md') {
      const lines = ctx.readLines(filePath);
      if (lines > LINE_CAP) return block(`${rel} has ${lines} lines; CLAUDE.md requires at or below ${LINE_CAP}. Trim it before continuing.`);
      return pass();
    }
    if (rel && rel.startsWith(MEMORY_DIR + sep) && rel.endsWith('.md')) {
      const result = ctx.refreshMemoryManifest();
      return context('PostToolUse', `core-memory manifest refresh (${MEMORY_DIR}): ${result}`);
    }
    return pass();
  }

  if (event === 'session-start') {
    return context('SessionStart', ctx.sessionSummary());
  }
  return pass();
}

export function defaultContext(root, legacy) {
  const vitestRunning = () => {
    try { return execFileSync('pgrep', ['-f', 'vitest'], { encoding: 'utf8' }).trim().length > 0; } catch { return false; }
  };
  return {
    root,
    legacy,
    vitestRunning,
    readLines: (p) => readFileSync(p, 'utf8').split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').length,
    refreshMemoryManifest: () => {
      const script = resolve(root, 'scripts', 'lint-core-memory.mjs');
      if (!existsSync(script)) return 'skipped (scripts/lint-core-memory.mjs not found)';
      try { execFileSync('node', [script, '--write'], { cwd: root, encoding: 'utf8', timeout: 10_000 }); return 'refreshed via scripts/lint-core-memory.mjs --write'; }
      catch (e) { return `failed: ${String(e.stderr || e.message).trim().slice(0, 300)}`; }
    },
    sessionSummary: () => {
      const git = (args) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5_000 }).trim(); } catch { return 'unavailable'; } };
      const head = git(['rev-parse', '--short', 'HEAD']);
      const dirty = git(['status', '--short']).split('\n').filter(Boolean);
      const shown = dirty.slice(0, 20).join(', ') || 'none';
      return `deckent-next HEAD ${head}; dirty paths (${dirty.length}): ${shown}${dirty.length > 20 ? ', …' : ''}; vitest running: ${vitestRunning() ? 'yes (no build until it ends)' : 'no'}. Preserve other contributors' WIP; deckent-dev is read-only.`;
    },
  };
}

const pass = () => ({});
const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const block = (reason) => ({ decision: 'block', reason });
const context = (hookEventName, text) => ({ hookSpecificOutput: { hookEventName, additionalContext: text } });

function readStdin() {
  try { const raw = readFileSync(0, 'utf8'); return raw.trim() ? JSON.parse(raw) : {}; } catch { return {}; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [event, ...rest] = process.argv.slice(2);
  const opt = (name, fallback) => { const i = rest.indexOf(name); return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback; };
  const root = opt('--root', process.cwd());
  const legacy = opt('--legacy', resolve(root, '..', 'deckent-dev'));
  let out;
  try { out = guard(event, readStdin(), defaultContext(root, legacy)); } catch (e) { out = { systemMessage: `host-guard error (fail-open): ${e.message}` }; }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
