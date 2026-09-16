import type { Environment } from './env.js';
export type DetectedEnv = 'vscode' | 'cursor' | 'codex' | 'gemini' | 'tmux' | 'shell';
export function detectEnvironment(env: Environment = process.env): DetectedEnv {
  if (env['VSCODE_PID'] || env['VSCODE_CWD'] || env['TERM_PROGRAM'] === 'vscode') return 'vscode';
  if (env['CURSOR_SESSION'] || env['TERM_PROGRAM'] === 'cursor') return 'cursor';
  if (env['CODEX_SESSION']) return 'codex';
  if (env['GEMINI_CLI']) return 'gemini';
  return env['TMUX'] ? 'tmux' : 'shell';
}
