import { z } from 'zod';
import { identitySchema, modelActivationBindingSchema, modelReferenceSchema } from '#domain/index.js';
import type { TerminalChatBackend } from './turn.js';

export const terminalChatSectionSchema = z.object({
  schemaVersion: z.literal(1),
  backend: z.enum(['inference_http', 'invoke_model']).optional(),
  reference: modelReferenceSchema.optional(),
  catalogRevision: identitySchema.optional(),
  expectedBinding: modelActivationBindingSchema.optional(),
}).strict();

export type TerminalChatSection = z.infer<typeof terminalChatSectionSchema>;

export function readTerminalChatSection(config: Record<string, unknown>): TerminalChatSection | null {
  const raw = config['terminal'] as { chat?: unknown } | undefined;
  const chat = raw?.chat;
  if (!chat || typeof chat !== 'object') return null;
  const parsed = terminalChatSectionSchema.safeParse(chat);
  return parsed.success ? parsed.data : null;
}

export function invokeModelConfigReady(section: TerminalChatSection | null): boolean {
  if (!section) return false;
  return Boolean(section.reference && section.catalogRevision && section.expectedBinding);
}

export function resolveConfiguredChatBackend(section: TerminalChatSection | null,
  env: Record<string, string | undefined>): TerminalChatBackend {
  if (section?.backend) return section.backend;
  const raw = env['DECKENT_TERMINAL_CHAT_BACKEND']?.trim().toLowerCase();
  if (raw === 'inference_http' || raw === 'http') return 'inference_http';
  if (raw === 'invoke_model' || raw === 'invoke') return 'invoke_model';
  return 'invoke_model';
}
