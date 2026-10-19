import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { ErrorRegistry, EXIT_CODES, emit, loadConfig, loadGlobalConfig, resolveConfigSecrets, t, terminalSafeText, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import { isSecretName } from '#engine/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { cliTableStyle, renderCliTable, resolveCommandScope, scopeLister, scopeNotice } from '#surfaces/core/cli-human/index.js';
import type { AdminCommandContext } from './context.js';
import { adminInteractive, adminSinks, askAdminCard, confirmOptions, reportCancelled } from './io.js';
import { secretStoreCommand, storeLabel } from './secret-store.js';

/** The installation's secret store as `doctor` shows it (SECRET-K1, owner S1): the active backend and whether it can be read now. */
export interface SecretStoreDoctorView {
  readonly schemaVersion: 1; readonly backend: string; readonly writable: boolean; readonly enumerable: boolean;
  readonly status: 'ready' | 'unavailable' | 'unsafe' | 'corrupt'; readonly code: string | null;
}
export type SecretStoreInspectHandler = (root: string, options: ConfigLoadOptions) => Promise<SecretStoreDoctorView>;
export type SecretNamesHandler = (root: string, options: ConfigLoadOptions) => Promise<{ readonly schemaVersion: 1; readonly backend: string; readonly names: readonly string[] }>;
/** What the runtime service answers for a change (SECRET-WRITE): never a value. */
export interface SecretChangeView {
  readonly schemaVersion: 1; readonly scopeId: string; readonly name: string; readonly action: 'set' | 'delete'; readonly backend: string; readonly removed: boolean | null;
}
export type SecretSetHandler = (root: string, input: { readonly schemaVersion: 1; readonly scopeId: string; readonly name: string; readonly value: string },
  options: ConfigLoadOptions) => Promise<SecretChangeView>;
export type SecretDeleteHandler = (root: string, input: { readonly schemaVersion: 1; readonly scopeId: string; readonly name: string },
  options: ConfigLoadOptions) => Promise<SecretChangeView>;

/** The port's value bound; a longer value is refused, never cut. */
const VALUE_MAX_BYTES = 65_536;
type Input = Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
type Sink = { write(text: string): unknown };

/**
 * Piped stdin: the bytes as given, bounded, with exactly one trailing line ending (`\n` or `\r\n`) dropped — the `echo value |` form and a
 * file saved by an editor keep working; `printf %s` stays byte-exact. Anything else (inner or repeated newlines, spaces) is the value.
 */
export async function readPiped(stdin: Input): Promise<string> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of stdin as AsyncIterable<Uint8Array | string>) {
    const buffer = Buffer.from(chunk); bytes += buffer.byteLength;
    // Room for one trailing CRLF; the value itself is bounded after it is dropped.
    if (bytes > VALUE_MAX_BYTES + 2) throw ErrorRegistry.createError('SECRET_VALUE_INVALID');
    chunks.push(buffer);
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw ErrorRegistry.createError('SECRET_VALUE_INVALID'); }
  return text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text;
}

/**
 * A terminal: a no-echo prompt on stderr (stdout stays the result). Raw mode turns echo and Ctrl-C's signal off, so the reader handles
 * Enter (end), Backspace/Delete (erase one character), Ctrl-C (cancel, nothing sent) and Ctrl-D on an empty line (end); raw mode is always
 * restored. The typed characters are never written anywhere.
 */
export function readHidden(stdin: Input, stderr: Sink, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // A multi-byte character split across two reads stays one character.
    let value = ''; const decoder = new StringDecoder('utf8');
    const finish = (error: unknown, result?: string) => {
      stdin.off('data', onData); stdin.setRawMode?.(false); stdin.pause(); stderr.write('\n');
      if (error) reject(error instanceof Error ? error : new Error(String(error))); else resolve(result ?? '');
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of typeof chunk === 'string' ? chunk : decoder.write(chunk)) {
        if (char === '\r' || char === '\n') { finish(null, value); return; }
        if (char === '\u0003') { finish(ErrorRegistry.createError('SECRET_INPUT_CANCELLED')); return; }
        if (char === '\u0004') { if (!value) { finish(null, value); return; } continue; }
        if (char === '\u007f' || char === '\b') { value = [...value].slice(0, -1).join(''); continue; }
        value += char;
        if (Buffer.byteLength(value, 'utf8') > VALUE_MAX_BYTES) { finish(ErrorRegistry.createError('SECRET_VALUE_INVALID')); return; }
      }
    };
    stderr.write(`${name}: `);
    stdin.setRawMode?.(true); stdin.on('data', onData); stdin.resume();
  });
}

/** The scheduled backup's fixed key name (composition `BACKUP_SCHEDULE_SECRET`); provisioned with `secret set`. */
const BACKUP_SECRET = 'BACKUP_PASSPHRASE';
/**
 * Who uses each key, from the installation's own config layer (the only layer that may hold `$DECK:NAME`): the config field that names it,
 * plus the scheduled backup's fixed passphrase. Read in memory with the shared reference grammar; no store is opened, no value is read.
 */
export async function secretUsers(root: string, options: ConfigLoadOptions, locale: Locale): Promise<Map<string, string[]>> {
  const users = new Map<string, string[]>(), add = (name: string, user: string) => users.set(name, [...(users.get(name) ?? []), user]);
  const global = await loadGlobalConfig(options).catch(() => null);
  if (global) {
    const marker = '\u0000deckent-secret-reference:';
    const resolved = await resolveConfigSecrets(global, async name => `${marker}${name}`);
    for (const pointer of resolved.secretPaths) {
      const segments = pointer.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
      const value = segments.reduce<unknown>((node, key) => node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined, resolved.config);
      if (typeof value === 'string' && value.startsWith(marker)) add(value.slice(marker.length), t('cli.secret.usedBy.config', { field: segments.join('.') }, locale));
    }
  }
  if (await loadConfig(root, options).then(config => config.backup.schedule !== 'off', () => false)) add(BACKUP_SECRET, t('cli.secret.usedBy.backup', {}, locale));
  return users;
}

/**
 * `deckent secret list [--json]` (SECRET-K1): the names the active store holds, who uses each, never a value. `deckent secret set [<NAME>]` /
 * `deckent secret delete <NAME>` (SECRET-WRITE, owner 2026-09-29 option A): the change goes to the runtime service, which decides it on the
 * `secret` policy cell for the socket peer and audits it. The value comes only from piped stdin or a hidden prompt — a value on argv is a usage
 * refusal and no argument is ever echoed. Owner CLI review 2026-10-19: a change takes no silent scope (off a terminal `--scope` is required);
 * on a terminal `set` without a name offers the names the config references but the store lacks, and `delete` shows who uses the key first.
 */
export async function secretCommand(argv: readonly string[], context: AdminCommandContext): Promise<void | ExitCode> {
  const action = argv[1];
  if (action === 'store') return secretStoreCommand(argv, context);
  if (action !== 'list' && action !== 'set' && action !== 'delete') throw ErrorRegistry.createError('CLI_USAGE');
  let name = action === 'list' || argv[2]?.startsWith('-') ? undefined : argv[2];
  if (action === 'delete' && !name) throw ErrorRegistry.createError('CLI_USAGE');
  // Checked before stdin is read: `NAME=value` on argv is refused as a name, and the argument is never echoed.
  if (name !== undefined && !isSecretName(name)) throw ErrorRegistry.createError('SECRET_NAME_INVALID');
  let json = false, language: string | undefined, scope: string | undefined;
  for (let i = name === undefined ? 2 : 3; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = () => { const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); return value; };
    if (flag === '--json' && !json) json = true;
    else if (flag === '--lang' && language === undefined) language = next();
    else if (flag === '--scope' && action !== 'list' && scope === undefined) scope = next();
    else if (flag !== '--no-color') throw ErrorRegistry.createError('CLI_USAGE');
  }
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, options = { env }, locale = commandLocale(context, language);
  const sinks = { json, ...adminSinks(context) }, interactive = adminInteractive(context, json);
  if (action === 'list') {
    if (!context.listSecretNames) throw ErrorRegistry.createError('CLI_USAGE');
    // The handler checks the local person's assurance with the installation's `enforce_principal_assurance` (as doctor does).
    const view = await context.listSecretNames(root, options), users = await secretUsers(root, options, locale);
    emit(view, { ...sinks, render: () => renderNames(view, users, locale, cliTableStyle(context)) });
    return;
  }
  const { setSecret, deleteSecret } = context;
  if (action === 'set' ? !setSecret : !deleteSecret) throw ErrorRegistry.createError('CLI_USAGE');
  const cancelled = () => { reportCancelled(context, locale); return EXIT_CODES.error; };
  if (!name) {
    // A person on a terminal picks a name the config already references but the store lacks; anyone else names the key.
    if (!interactive || !context.listSecretNames) throw ErrorRegistry.createError('CLI_USAGE');
    const stored = new Set((await context.listSecretNames(root, options)).names), users = await secretUsers(root, options, locale);
    const needed = [...users.keys()].filter(item => !stored.has(item)).sort();
    if (!needed.length) throw ErrorRegistry.createError('SECRET_NAME_REQUIRED');
    name = await askAdminCard(context, locale, { title: t('cli.secret.card.setTitle', {}, locale),
      options: needed.map(item => ({ id: item, label: `${item} · ${(users.get(item) ?? []).join(', ')}` })) }) ?? undefined;
    if (!name) return cancelled();
  }
  const configured = await loadConfig(root, options).then(config => (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId, () => undefined);
  const resolved = await resolveCommandScope({ command: `deckent secret ${action}`, locale, explicit: scope, configured: typeof configured === 'string' ? configured : undefined,
    mutating: true, interactive, listScopes: () => scopeLister(context, root, options)().catch(() => []), pick: request => askAdminCard(context, locale, request) });
  if (!resolved) return cancelled();
  const notice = () => { if (!json) emit(scopeNotice(resolved, locale), adminSinks(context)); };
  const render = (view: SecretChangeView) => view.action === 'set' ? t('cli.secret.done.set', { name: view.name, store: storeLabel(view.backend, locale) }, locale)
    : view.removed === false ? t('cli.secret.done.absent', { name: view.name }, locale) : t('cli.secret.done.deleted', { name: view.name, store: storeLabel(view.backend, locale) }, locale);
  if (action === 'delete') {
    if (interactive) {
      const users = (await secretUsers(root, options, locale)).get(name) ?? [];
      const answer = await askAdminCard(context, locale, { title: t('cli.secret.card.deleteTitle', { name }, locale),
        body: [users.length ? t('cli.secret.card.deleteUsers', { users: users.join(', ') }, locale) : t('cli.secret.card.deleteUnused', {}, locale)], options: confirmOptions(locale) });
      if (answer !== 'apply') return cancelled();
    }
    const removed = await deleteSecret!(root, { schemaVersion: 1, scopeId: resolved.scopeId, name }, options);
    notice(); emit(removed, { ...sinks, render });
    return;
  }
  const stdin = (context.stdin ?? process.stdin) as Input;
  const value = stdin.isTTY ? await readHidden(stdin, context.stderr ?? process.stderr, name) : await readPiped(stdin);
  if (!value || Buffer.byteLength(value, 'utf8') > VALUE_MAX_BYTES) throw ErrorRegistry.createError('SECRET_VALUE_INVALID');
  const stored = await setSecret!(root, { schemaVersion: 1, scopeId: resolved.scopeId, name, value }, options);
  notice(); emit(stored, { ...sinks, render });
}

/** Owner CLI review 2026-10-19 (`secret`): name · used by · store; a referenced key the store lacks is listed as missing. Never a value. */
function renderNames(view: Awaited<ReturnType<SecretNamesHandler>>, users: ReadonlyMap<string, readonly string[]>, locale: Locale, style: ReturnType<typeof cliTableStyle>): string {
  const store = storeLabel(view.backend, locale), stored = new Set(view.names);
  const names = [...new Set([...view.names, ...[...users.keys()].filter(name => !stored.has(name))])].sort();
  const rows = names.map(name => [name, (users.get(name) ?? []).join(', ') || t('cli.secret.usedBy.none', {}, locale),
    stored.has(name) ? store : t('cli.secret.list.missing', { name }, locale)]);
  const columns = [t('cli.secret.list.column.name', {}, locale), t('cli.secret.list.column.usedBy', {}, locale), t('cli.secret.list.column.store', {}, locale)].map(header => ({ header }));
  return [t('cli.secret.list.title', { store: terminalSafeText(view.backend), count: view.names.length }, locale),
    ...(rows.length ? ['', renderCliTable(columns, rows, style)] : [t('cli.secret.list.empty', {}, locale)]), '', t('cli.secret.list.never', {}, locale)].join('\n');
}
