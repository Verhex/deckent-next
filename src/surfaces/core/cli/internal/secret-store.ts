import { createInterface } from 'node:readline/promises';
import type { Readable } from 'node:stream';
import { ErrorRegistry, emit, formatValue, loadConfig, resolveLocale, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { isSecretStoreDowngrade } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';

/** The registered stores and the installation's selection, for the picker (store ids only; never a secret name or value). */
export interface SecretStoresView { readonly schemaVersion: 1; readonly current: string; readonly stores: readonly string[] }
export type SecretStoresHandler = (root: string, options: ConfigLoadOptions) => Promise<SecretStoresView>;
/** What the runtime service answers for a store switch (v24): store ids and counts only. */
export interface SecretStoreSwitchView {
  readonly schemaVersion: 1; readonly scopeId: string; readonly status: 'switched' | 'current'; readonly from: string; readonly to: string;
  readonly entries: number; readonly downgrade: boolean; readonly cleaned: boolean;
}
export type SecretStoreSwitchHandler = (root: string, input: { readonly schemaVersion: 1; readonly scopeId: string; readonly to: string; readonly confirmDowngrade: boolean },
  options: ConfigLoadOptions) => Promise<SecretStoreSwitchView>;
type Input = Readable & { isTTY?: boolean };
type Sink = { write(text: string): unknown };

/** A numbered choice on the terminal (stderr; stdout stays the result): the store is picked, never typed (owner 2026-10-08). */
async function pick(stdin: Input, stderr: Sink, view: SecretStoresView, locale: Locale): Promise<string> {
  stderr.write(`${t('cli.secret.store.pickTitle', { current: view.current }, locale)}\n`);
  view.stores.forEach((id, index) => stderr.write(`  ${index + 1}. ${id}${id === view.current ? ` ${t('cli.secret.store.currentMark', {}, locale)}` : ''}\n`));
  const answer = await ask(stdin, stderr, t('cli.secret.store.pickPrompt', { count: view.stores.length }, locale));
  const index = /^[0-9]+$/.test(answer) ? Number(answer) - 1 : -1;
  if (index < 0 || index >= view.stores.length) throw ErrorRegistry.createError('SECRET_INPUT_CANCELLED');
  return view.stores[index]!;
}
async function ask(stdin: Input, stderr: Sink, prompt: string): Promise<string> {
  const reader = createInterface({ input: stdin, output: stderr as NodeJS.WritableStream, terminal: false });
  try { return (await reader.question(`${prompt} `)).trim(); } finally { reader.close(); }
}

/**
 * `deckent secret store [--to <store>] [--confirm-downgrade] [--list] [--scope <id>] [--json]` (SECRET-STORE-SWITCH, owner 2026-10-08, option B):
 * moves every secret into another registered store and selects it, through the runtime service (`secret`/`switch` cell, audited). On a terminal
 * the store is chosen from a numbered list and a move to a weaker store asks yes/no; without a terminal `--to` names a registered store and a
 * downgrade needs `--confirm-downgrade`. `--list` shows the stores and the selection only.
 */
export async function secretStoreCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  let json = false, list = false, confirm = false, language: string | undefined, scope: string | undefined, to: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = () => { const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); return value; };
    if (flag === '--json' && !json) json = true;
    else if (flag === '--list' && !list) list = true;
    else if (flag === '--confirm-downgrade' && !confirm) confirm = true;
    else if (flag === '--lang' && language === undefined) language = next();
    else if (flag === '--scope' && scope === undefined) scope = next();
    else if (flag === '--to' && to === undefined) to = next();
    else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (list && (to !== undefined || confirm)) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, locale = resolveLocale(language, env);
  context.onLocale?.(locale);
  const sinks = { json, render: (data: unknown) => formatValue(data), ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (!context.listSecretStores) throw ErrorRegistry.createError('CLI_USAGE');
  const view = await context.listSecretStores(root, { env });
  if (list) { emit(view, sinks); return; }
  if (!context.switchSecretStore) throw ErrorRegistry.createError('CLI_USAGE');
  const stdin = (context.stdin ?? process.stdin) as Input, stderr = context.stderr ?? process.stderr;
  const terminal = Boolean(stdin.isTTY) && to === undefined;
  if (!terminal && to === undefined) throw ErrorRegistry.createError('CLI_USAGE');
  const target = to ?? await pick(stdin, stderr, view, locale);
  if (!view.stores.includes(target)) throw ErrorRegistry.createError('SECRET_STORE_UNKNOWN', { params: { backend: target } });
  if (terminal && !confirm && target !== view.current && isSecretStoreDowngrade(view.current, target)) {
    const answer = await ask(stdin, stderr, t('cli.secret.store.downgradePrompt', { from: view.current, to: target }, locale));
    confirm = /^(y|yes|e|evet)$/i.test(answer);
    if (!confirm) throw ErrorRegistry.createError('SECRET_STORE_DOWNGRADE_UNCONFIRMED', { params: { from: view.current, to: target } });
  }
  const configured = scope ?? ((await loadConfig(root, { env }))['terminal'] as { scopeId?: unknown } | undefined)?.scopeId;
  if (typeof configured !== 'string' || !configured) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  emit(await context.switchSecretStore(root, { schemaVersion: 1, scopeId: configured, to: target, confirmDowngrade: confirm }, { env }), sinks);
}
