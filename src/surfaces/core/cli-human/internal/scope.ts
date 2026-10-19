import { ErrorRegistry, t, terminalSafeText, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { CliCardRequest } from './card.js';

/** Where the scope of a command came from: typed `--scope`, the configured `terminal.scopeId` (reads only), or the person's TTY choice. */
export type ScopeResolution = Readonly<{ scopeId: string; source: 'flag' | 'default' | 'picked' }>;
/** The person's choice on a TTY card (the CLI card launcher); null = cancelled. */
export type ScopePick = (request: CliCardRequest) => Promise<string | null>;

/**
 * The scope rule (CLI review "Scope"): a read uses `--scope` or the configured default and says which; a change never takes a silent
 * default. Without one, a person on a terminal picks from the valid scopes (configured default preselected, Enter confirms) and anyone
 * else (pipe, agent, CI) gets `CLI_SCOPE_REQUIRED` (exit 2) naming the valid scopes, before anything is written. A cancelled pick is null:
 * the caller applies nothing. A person on a terminal in a folder with no installation gets the list's `CLI_INSTALLATION_MISSING` (exit 2,
 * names only `deckent init`); with an installation but no scope to pick, `TERMINAL_SCOPE_REQUIRED` (exit 2). The application still
 * authorizes the scope it receives.
 */
export async function resolveCommandScope(input: Readonly<{ command: string; locale: Locale; explicit?: string | undefined; configured?: string | undefined;
  mutating: boolean; interactive: boolean; listScopes: () => Promise<readonly string[]>; pick?: ScopePick }>): Promise<ScopeResolution | null> {
  if (input.explicit) return { scopeId: input.explicit, source: 'flag' };
  if (!input.mutating && input.configured) return { scopeId: input.configured, source: 'default' };
  const person = input.interactive && input.pick !== undefined;
  // J2d: the scope list says "no installation here" once (CLI_INSTALLATION_MISSING); a person on a terminal gets it as is, anyone else
  // keeps the unchanged CLI_SCOPE_REQUIRED (`--scope`), so `deckent init --yes` and agents see no change.
  const scopes = [...new Set(await input.listScopes().catch((error: unknown) => {
    if (!person && (error as { code?: unknown } | null)?.code === 'CLI_INSTALLATION_MISSING') return [];
    throw error;
  }))];
  // J2c: an installation with no scope this person may read: the same typed setup step as bare `deckent`.
  if (input.interactive && input.pick && scopes.length === 0) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  if (!input.interactive || !input.pick || scopes.length === 0) {
    throw ErrorRegistry.createError('CLI_SCOPE_REQUIRED', { params: { command: terminalSafeText(input.command),
      scopes: scopes.map(scope => terminalSafeText(scope)).join(', ') || '-' } });
  }
  const { locale } = input;
  const chosen = await input.pick({ title: t('cli.human.scope.pickTitle', { command: input.command }, locale),
    body: [input.mutating ? t('cli.human.scope.pickBody', {}, locale) : t('cli.human.scope.pickBodyRead', {}, locale)],
    options: scopes.map(scope => ({ id: scope, label: scope === input.configured ? t('cli.human.scope.defaultOption', { scope }, locale) : scope })),
    ...(input.configured && scopes.includes(input.configured) ? { initial: input.configured } : {}) });
  return chosen !== null && scopes.includes(chosen) ? { scopeId: chosen, source: 'picked' } : null;
}

/** The line a command prints first so the person always sees which scope answered: `scope: live (default)`. */
export function scopeNotice(resolution: ScopeResolution, locale: Locale): string {
  const scope = terminalSafeText(resolution.scopeId);
  return resolution.source === 'default' ? t('cli.human.scope.noticeDefault', { scope }, locale) : t('cli.human.scope.notice', { scope }, locale);
}

type ScopeChoiceSource = (root: string, options: ConfigLoadOptions) => { list(source: 'scopes', keyPath: string): Promise<readonly { readonly value: unknown }[]> };
/** The scope list a person may pick from: the same query `/config` uses for `terminal.scopeId` (installation scopes the caller may read). */
export function scopeLister(context: Readonly<{ configChoiceSources?: ScopeChoiceSource }>, root: string, options: ConfigLoadOptions): () => Promise<readonly string[]> {
  return async () => context.configChoiceSources
    ? (await context.configChoiceSources(root, options).list('scopes', 'terminal.scopeId')).map(choice => choice.value).filter((value): value is string => typeof value === 'string')
    : [];
}
