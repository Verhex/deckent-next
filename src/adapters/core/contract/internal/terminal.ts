import { isIP } from 'node:net';
import { z } from 'zod';
import { modelReferenceSchema, type ModelReference } from '#domain/index.js';
import { CONFIG_CONTRACT_SINCE, ConfigValidationError, isRecord, registerConfigSection } from '#platform/index.js';

/** T2 presentation vocabularies (first entry = default); the workline's own copy (`TERMINAL_THEME_SETTINGS`) is tested equal. */
export const TERMINAL_THEMES = ['auto', 'dark', 'light', 'dark-daltonized', 'light-daltonized', 'ansi'] as const;
export const TERMINAL_BANNERS = ['full', 'compact', 'off'] as const;

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
  /** T2 (T-READABLE): the workline's colour theme. `auto` follows a background the terminal reports (COLORFGBG) and otherwise keeps the
   * terminal's own 16 colours; `ansi` always does; the daltonized themes keep success and failure on the blue/orange axis. */
  theme: z.enum(TERMINAL_THEMES).default(TERMINAL_THEMES[0]),
  /** T2 (T-STARTUP): the opening banner — the Deckent mark with version, project, model, mode and a hint (`full`), one line (`compact`), or none. */
  banner: z.enum(TERMINAL_BANNERS).default(TERMINAL_BANNERS[0]),
  /** T2 (T-STARTUP): clear the visible screen (never the scrollback) when the interactive workline opens on a terminal. */
  clearOnStart: z.boolean().default(true),
  /** T4-B (owner 2026-10-08, Jev d84b248d): the person's own default terminal model — an exact catalog reference, nothing else. Only the user
   * (global) layer may hold it; precedence is in {@link resolveTerminalModel}. Additive optional key (the `readResultMaxBytes` pattern). */
  defaultModel: modelReferenceSchema.optional(),
  chat: z.object({
    schemaVersion: z.literal(1),
    reference: modelReferenceSchema,
    maxCompletionTokens: z.number().int().positive().safe(),
    /** Message window of the plain line mode only; the agent conversation is measured and compacted by the runtime (T-L5). */
    historyMessages: z.number().int().min(2).max(1_000).default(40),
    /** Byte ceiling of one agent tool result (T-L5c, owner 2026-09-28): the workspace-read adapter's own default (64 KiB)
     * applies when absent; an additive field, `chat.schemaVersion` stays 1 (same pattern as `historyMessages`). */
    readResultMaxBytes: z.number().int().min(1_024).max(1_048_576).default(65_536),
  }).strict().optional(),
  /** The agent's host shell (T-L4 slice 3c): its per-command deadline, and variable names copied from the service environment in
   * addition to the built-in allowlist (credentials never pass unless named here). */
  shell: z.object({
    schemaVersion: z.literal(1),
    timeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
    realm: z.enum(['require-sandbox', 'prefer-sandbox', 'host']).default('prefer-sandbox'),
    environment: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(64).default([]),
  }).strict().optional(),
  /** The agent's scratch area (SCR-A, owner 2026-09-28): per-write, per-session and installation-wide byte ceilings of the layout's
   * `scratch` resource, how many days an unused session area is kept, and how often the running service sweeps. Data, not code. */
  scratch: z.object({
    schemaVersion: z.literal(1),
    writeMaxBytes: z.number().int().min(1_024).max(1_048_576).default(1_048_576),
    sessionMaxBytes: z.number().int().min(1_024).max(1_073_741_824).default(67_108_864),
    installationMaxBytes: z.number().int().min(1_024).max(17_179_869_184).default(536_870_912),
    retentionDays: z.number().int().min(1).max(365).default(7),
    sweepIntervalMs: z.number().int().min(60_000).max(86_400_000).default(3_600_000),
  }).strict().optional(),
  /** The agent's `fetch_url` (FETCH S6, owner 2026-09-28): `none` (default: no tool, no network), `allowlist` (only the listed hosts),
   * `approval` (listed hosts at once, any other host asks the owner). Hosts are exact lowercase DNS names (no wildcard, no IP). No proxy. */
  fetch: z.object({
    schemaVersion: z.literal(1),
    egress: z.enum(['none', 'allowlist', 'approval']).default('none'),
    allowedHosts: z.array(z.string().max(253).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u)
      .refine(host => isIP(host) === 0, 'FETCH_HOST_IS_IP')).max(256).default([]),
    maxBytes: z.number().int().min(1_024).max(67_108_864).default(4_194_304),
    timeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
    maxRedirects: z.number().int().min(0).max(10).default(3),
  }).strict().optional(),
}).strict();

export type TerminalConfig = z.infer<typeof terminalConfigSchema>;
export type TerminalChatConfig = NonNullable<TerminalConfig['chat']>;

export function readTerminalChatConfig(config: Record<string, unknown>): TerminalChatConfig | null {
  const section = config['terminal'];
  if (section === undefined) return null;
  return terminalConfigSchema.parse(section).chat ?? null;
}

export type TerminalShellConfig = { readonly realm: 'require-sandbox' | 'prefer-sandbox' | 'host'; readonly timeoutMs: number; readonly environment: readonly string[] };
/** The shell section, or its defaults when absent. */
export function readTerminalShellConfig(config: Record<string, unknown>): TerminalShellConfig {
  const shell = config['terminal'] === undefined ? undefined : terminalConfigSchema.parse(config['terminal']).shell;
  return Object.freeze({ realm: shell?.realm ?? 'prefer-sandbox', timeoutMs: shell?.timeoutMs ?? 300_000, environment: Object.freeze([...(shell?.environment ?? [])]) });
}

export type TerminalScratchConfig = { readonly writeMaxBytes: number; readonly sessionMaxBytes: number; readonly installationMaxBytes: number;
  readonly retentionDays: number; readonly sweepIntervalMs: number };
/** The scratch section, or its defaults when absent (1 MiB write, 64 MiB session, 512 MiB installation, 7 days, hourly sweep). */
export function readTerminalScratchConfig(config: Record<string, unknown>): TerminalScratchConfig {
  const scratch = config['terminal'] === undefined ? undefined : terminalConfigSchema.parse(config['terminal']).scratch;
  const { writeMaxBytes, sessionMaxBytes, installationMaxBytes, retentionDays, sweepIntervalMs } = scratch
    ?? terminalConfigSchema.shape.scratch.unwrap().parse({ schemaVersion: 1 });
  return Object.freeze({ writeMaxBytes, sessionMaxBytes, installationMaxBytes, retentionDays, sweepIntervalMs });
}

export type TerminalFetchConfig = { readonly egress: 'none' | 'allowlist' | 'approval'; readonly allowedHosts: readonly string[]; readonly maxBytes: number;
  readonly timeoutMs: number; readonly maxRedirects: number };
/** The fetch section, or its defaults when absent (egress none, no hosts, 4 MiB, 30 s, 3 redirects). */
export function readTerminalFetchConfig(config: Record<string, unknown>): TerminalFetchConfig {
  const fetch = config['terminal'] === undefined ? undefined : terminalConfigSchema.parse(config['terminal']).fetch;
  const { egress, allowedHosts, maxBytes, timeoutMs, maxRedirects } = fetch ?? terminalConfigSchema.shape.fetch.unwrap().parse({ schemaVersion: 1 });
  return Object.freeze({ egress, allowedHosts: Object.freeze([...allowedHosts]), maxBytes, timeoutMs, maxRedirects });
}

/** Which setting chose the terminal's model: the session's pin, the project's `terminal.chat.reference`, the user's `terminal.defaultModel`, or the
 * user layer's own `terminal.chat.reference` (the installation-configured model). */
export type TerminalModelSource = 'session' | 'project' | 'user-default' | 'user';
export type TerminalModelChoice = Readonly<{ reference: ModelReference; source: TerminalModelSource }>;
const authoredReference = (value: unknown): ModelReference | null => { const parsed = modelReferenceSchema.safeParse(value); return parsed.success ? parsed.data : null; };
const authoredTerminal = (layer: unknown): Record<string, unknown> => isRecord(layer) && isRecord(layer['terminal']) ? layer['terminal'] : {};
/**
 * The one precedence of the terminal's model (T4-B D1, Jev d84b248d): session pin > project-authored `terminal.chat.reference` (an explicit
 * project choice) > the user's `terminal.defaultModel` > the user layer's `terminal.chat.reference`. Pure over the two authored layer documents
 * (never the merged config: a merged value cannot say which layer wrote it). Null: no layer names a model.
 */
export function resolveTerminalModel(layers: Readonly<{ global: unknown; project: unknown }>, pin?: ModelReference | null): TerminalModelChoice | null {
  if (pin) return Object.freeze({ reference: pin, source: 'session' });
  const project = authoredTerminal(layers.project), global = authoredTerminal(layers.global);
  const projectChat = authoredReference(isRecord(project['chat']) ? project['chat']['reference'] : undefined);
  if (projectChat) return Object.freeze({ reference: projectChat, source: 'project' });
  const preferred = authoredReference(global['defaultModel']);
  if (preferred) return Object.freeze({ reference: preferred, source: 'user-default' });
  const userChat = authoredReference(isRecord(global['chat']) ? global['chat']['reference'] : undefined);
  return userChat ? Object.freeze({ reference: userChat, source: 'user' }) : null;
}

export function readTerminalConfig(config: Record<string, unknown>): TerminalConfig {
  return terminalConfigSchema.parse(config['terminal'] ?? {});
}

export function registerTerminalConfig(): void {
  registerConfigSection('terminal', terminalConfigSchema, {
    optional: true,
    secretReferences: 'forbid',
    metadata: { descriptionKey: 'config.field.terminal', tier: 'core', since: CONFIG_CONTRACT_SINCE, binding: { state: 'bound', consumers: ['src/adapters/core/contract'] }, apply: 'restart' },
    // The user's default is the person's own setting: a project document never carries it (it would silently apply to everyone in the project).
    validateLayers: (_global, project) => {
      if (isRecord(project) && project['defaultModel'] !== undefined) throw new ConfigValidationError([{ path: 'terminal.defaultModel', reason: 'TERMINAL_DEFAULT_MODEL_PROJECT_LAYER' }]);
    },
  });
}
