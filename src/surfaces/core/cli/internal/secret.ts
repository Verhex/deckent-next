import { ErrorRegistry, emit, formatValue, resolveLocale, type ConfigLoadOptions } from '#platform/index.js';
import type { CommandContext } from './kernel-commands.js';

/** The installation's secret store as `doctor` shows it (SECRET-K1, owner S1): the active backend and whether it can be read now. */
export interface SecretStoreDoctorView {
  readonly schemaVersion: 1; readonly backend: string; readonly writable: boolean; readonly enumerable: boolean;
  readonly status: 'ready' | 'unavailable' | 'unsafe' | 'corrupt'; readonly code: string | null;
}
export type SecretStoreInspectHandler = (root: string, options: ConfigLoadOptions) => Promise<SecretStoreDoctorView>;
export type SecretNamesHandler = (root: string, options: ConfigLoadOptions) => Promise<{ readonly schemaVersion: 1; readonly backend: string; readonly names: readonly string[] }>;

/**
 * `deckent secret list [--json]` (SECRET-K1): the names the active backend holds, never a value. `secret set|delete` are not wired in this
 * slice (authority checkpoint: which policy cell governs a secret change is an owner decision); they stay a usage refusal and no argument
 * after the action is read, stored or echoed.
 */
export async function secretCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  if (argv[1] !== 'list') throw ErrorRegistry.createError('CLI_USAGE');
  let json = false, language: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--json' && !json) json = true;
    else if (flag === '--lang' && language === undefined) { const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); language = value; }
    else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (!context.listSecretNames) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env;
  context.onLocale?.(resolveLocale(language, env));
  // The handler checks the local person's assurance with the installation's `enforce_principal_assurance` (as doctor does).
  const view = await context.listSecretNames(root, { env });
  emit(view, { json, render: data => formatValue(data), ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
}
