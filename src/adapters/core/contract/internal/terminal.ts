import { z } from 'zod';
import { modelReferenceSchema } from '#domain/index.js';
import { CONFIG_CONTRACT_SINCE, registerConfigSection } from '#platform/index.js';

/**
 * Operator terminal chat is a governed model invocation: the section names a declared catalog model;
 * catalog revision and binding are read fresh per turn and enforced by the model invocation service.
 */
export const terminalConfigSchema = z.object({
  /** Scope the interactive terminal (`deckent` with no arguments) works in; `--scope` overrides it. */
  scopeId: z.string().min(1).max(128).optional(),
  /** Keep the composer's visible input history across sessions in this project (private file; pastes never stored). */
  persistHistory: z.boolean().default(true),
  /** Interactive terminals start the runtime service when none is running (owner 2026-09-23); false only connects. */
  autostartService: z.boolean().default(true),
  /** Deadline for an automatically started runtime service to answer on its endpoint. */
  serviceStartTimeoutMs: z.number().int().min(1_000).max(120_000).default(20_000),
  chat: z.object({
    schemaVersion: z.literal(1),
    reference: modelReferenceSchema,
    maxCompletionTokens: z.number().int().positive().safe(),
    historyMessages: z.number().int().min(2).max(1_000).default(40),
  }).strict().optional(),
}).strict();

export type TerminalConfig = z.infer<typeof terminalConfigSchema>;
export type TerminalChatConfig = NonNullable<TerminalConfig['chat']>;

export function readTerminalChatConfig(config: Record<string, unknown>): TerminalChatConfig | null {
  const section = config['terminal'];
  if (section === undefined) return null;
  return terminalConfigSchema.parse(section).chat ?? null;
}

export function readTerminalConfig(config: Record<string, unknown>): TerminalConfig {
  return terminalConfigSchema.parse(config['terminal'] ?? {});
}

export function registerTerminalConfig(): void {
  registerConfigSection('terminal', terminalConfigSchema, {
    optional: true,
    secretReferences: 'forbid',
    metadata: { descriptionKey: 'config.field.terminal', tier: 'core', since: CONFIG_CONTRACT_SINCE },
  });
}
