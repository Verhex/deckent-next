import type { TerminalChatBackend } from './turn.js';
import type { TerminalChatSection } from './config.js';
import { invokeModelConfigReady } from './config.js';

export const TERMINAL_CHAT_INVOKE_BINDING_REQUIRED = 'TERMINAL_CHAT_INVOKE_BINDING_REQUIRED';
export const TERMINAL_CHAT_INVOKE_PAYLOAD_MISSING = 'TERMINAL_CHAT_INVOKE_PAYLOAD_MISSING';

export function terminalChatBlockCode(backend: TerminalChatBackend, section: TerminalChatSection | null): string | undefined {
  if (backend !== 'invoke_model') return undefined;
  if (!invokeModelConfigReady(section)) return TERMINAL_CHAT_INVOKE_BINDING_REQUIRED;
  return undefined;
}

export function assertTerminalChatPlanReady(backend: TerminalChatBackend, section: TerminalChatSection | null,
  modelInvocation?: unknown): void {
  const block = terminalChatBlockCode(backend, section);
  if (block) throw new Error(block);
  if (backend === 'invoke_model' && !modelInvocation) throw new Error(TERMINAL_CHAT_INVOKE_PAYLOAD_MISSING);
}
