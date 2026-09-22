import type { TerminalChatBackend } from './turn.js';
import { resolveConfiguredChatBackend } from './config.js';

/** Env-only view of configured backend (no `terminal.chat` section). Product default is `invoke_model`. */
export function resolveTerminalChatBackend(env: Record<string, string | undefined> = process.env): TerminalChatBackend {
  return resolveConfiguredChatBackend(null, env);
}
