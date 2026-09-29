import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { ErrorRegistry, emit, formatValue, loadConfig, resolveLocale, type ConfigLoadOptions } from '#platform/index.js';
import { isSecretName } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';

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
async function readPiped(stdin: Input): Promise<string> {
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
function readHidden(stdin: Input, stderr: Sink, name: string): Promise<string> {
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

/**
 * `deckent secret list [--json]` (SECRET-K1): the names the active backend holds, never a value.
 * `deckent secret set <NAME> [--scope <id>] [--json]` / `deckent secret delete <NAME> [--scope <id>] [--json]` (SECRET-WRITE, owner
 * 2026-09-29 option A): the change goes to the runtime service, which decides it on the `secret` policy cell for the socket peer and audits
 * it. The value comes only from piped stdin or a hidden prompt — a value on argv (an extra argument, a flag, `NAME=value`) is a usage
 * refusal and no argument is ever echoed.
 */
export async function secretCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const action = argv[1];
  if (action !== 'list' && action !== 'set' && action !== 'delete') throw ErrorRegistry.createError('CLI_USAGE');
  const name = action === 'list' ? undefined : argv[2];
  if (action !== 'list' && (!name || name.startsWith('-'))) throw ErrorRegistry.createError('CLI_USAGE');
  // Checked before stdin is read: `NAME=value` on argv is refused as a name, and the argument is never echoed.
  if (name !== undefined && !isSecretName(name)) throw ErrorRegistry.createError('SECRET_NAME_INVALID');
  let json = false, language: string | undefined, scope: string | undefined;
  for (let i = action === 'list' ? 2 : 3; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = () => { const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); return value; };
    if (flag === '--json' && !json) json = true;
    else if (flag === '--lang' && language === undefined) language = next();
    else if (flag === '--scope' && action !== 'list' && scope === undefined) scope = next();
    else throw ErrorRegistry.createError('CLI_USAGE');
  }
  const root = context.root ?? process.cwd(), env = context.env ?? process.env;
  context.onLocale?.(resolveLocale(language, env));
  const sinks = { json, render: (data: unknown) => formatValue(data), ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (action === 'list') {
    if (!context.listSecretNames) throw ErrorRegistry.createError('CLI_USAGE');
    // The handler checks the local person's assurance with the installation's `enforce_principal_assurance` (as doctor does).
    emit(await context.listSecretNames(root, { env }), sinks);
    return;
  }
  const { setSecret, deleteSecret } = context;
  if (action === 'set' ? !setSecret : !deleteSecret) throw ErrorRegistry.createError('CLI_USAGE');
  const configured = scope ?? ((await loadConfig(root, { env }))['terminal'] as { scopeId?: unknown } | undefined)?.scopeId;
  if (typeof configured !== 'string' || !configured) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  if (action === 'delete') { emit(await deleteSecret!(root, { schemaVersion: 1, scopeId: configured, name: name! }, { env }), sinks); return; }
  const stdin = (context.stdin ?? process.stdin) as Input;
  const value = stdin.isTTY ? await readHidden(stdin, context.stderr ?? process.stderr, name!) : await readPiped(stdin);
  if (!value || Buffer.byteLength(value, 'utf8') > VALUE_MAX_BYTES) throw ErrorRegistry.createError('SECRET_VALUE_INVALID');
  emit(await setSecret!(root, { schemaVersion: 1, scopeId: configured, name: name!, value }, { env }), sinks);
}
