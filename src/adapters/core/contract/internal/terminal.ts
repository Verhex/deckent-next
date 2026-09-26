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
    /** Message window of the plain line mode only; the agent conversation is measured and compacted by the runtime (T-L5). */
    historyMessages: z.number().int().min(2).max(1_000).default(40),
  }).strict().optional(),
  /** The agent's host shell (T-L4 slice 3c): its per-command deadline, and variable names copied from the service environment in
   * addition to the built-in allowlist (credentials never pass unless named here). */
  shell: z.object({
    schemaVersion: z.literal(1),
    timeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
    environment: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(64).default([]),
  }).strict().optional(),
}).strict();

export type TerminalConfig = z.infer<typeof terminalConfigSchema>;
export type TerminalChatConfig = NonNullable<TerminalConfig['chat']>;

export function readTerminalChatConfig(config: Record<string, unknown>): TerminalChatConfig | null {
  const section = config['terminal'];
  if (section === undefined) return null;
  return terminalConfigSchema.parse(section).chat ?? null;
}

export type TerminalShellConfig = { readonly timeoutMs: number; readonly environment: readonly string[] };
/** The shell section, or its defaults when absent. */
export function readTerminalShellConfig(config: Record<string, unknown>): TerminalShellConfig {
  const shell = config['terminal'] === undefined ? undefined : terminalConfigSchema.parse(config['terminal']).shell;
  return Object.freeze({ timeoutMs: shell?.timeoutMs ?? 300_000, environment: Object.freeze([...(shell?.environment ?? [])]) });
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
