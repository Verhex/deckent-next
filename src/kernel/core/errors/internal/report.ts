import { mkdir, open, rename, unlink, readdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PACKAGE_VERSION } from '#kernel/core/common/index.js';
import { DeckentError } from './error.js';
import { ErrorRegistry } from './registry.js';
import { exitCodeFor, type ExitCode } from './exit-codes.js';
import { colorTier, type ColorOptions } from '#kernel/core/output/index.js';
import { emit, type OutputSink } from '#kernel/core/output/index.js';
import { t, resolveLocale, type Locale } from '#kernel/core/i18n/index.js';
import { resolveDeckentHome } from '#kernel/core/platform/index.js';
import type { Environment } from '#kernel/core/platform/index.js';

export function redactSensitive(value: string): string {
  return value.replace(/\b(?:sk-(?:ant-)?[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/(:\/\/[^:/?#\s]+:)[^@\s]+(@)/g, '$1[REDACTED]$2')
    .replace(/((?:[\w-]*(?:password|passwd|token|secret|api[_-]?key|private[_-]?key))["']?\s*(?:=|:|\s)\s*)["']?[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[REDACTED]');
}
export function formatHumanError(error: DeckentError, options: ColorOptions & { locale?: Locale } = {}): string {
  const locale = options.locale ?? resolveLocale();
  const localized = error.localize?.(locale);
  let heading = t('error.heading', { message: localized?.message ?? error.message, code: error.code }, locale);
  if (colorTier(options) !== 'none') heading = `\x1b[31m${heading}\x1b[0m`;
  const lines = [heading];
  const suggestion = localized?.suggestion ?? error.suggestion;
  if (suggestion) lines.push(t('error.suggestion', { text: suggestion }, locale));
  const whatHappened = localized?.whatHappened ?? error.whatHappened;
  const why = localized?.why ?? error.why;
  const howToFix = localized?.howToFix ?? error.howToFix;
  if (whatHappened) lines.push(t('error.what', { text: whatHappened }, locale));
  if (why) lines.push(t('error.why', { text: why }, locale));
  if (howToFix?.length) lines.push(t('error.fix', { text: howToFix.join('\n') }, locale));
  if (error.docLink) lines.push(t('error.docs', { text: error.docLink }, locale));
  return redactSensitive(lines.join('\n'));
}
export interface CrashArtifactV1 { schemaVersion: 1; timestamp: string; pid: number; command: string; deckentVersion: string; projectRootDigest: string; name: string; message: string; stack: string | null }
export function buildCrashArtifact(error: unknown, root: string, argv: readonly string[]): CrashArtifactV1 {
  return { schemaVersion: 1, timestamp: new Date().toISOString(), pid: process.pid,
    command: redactSensitive(argv.join(' ')), deckentVersion: PACKAGE_VERSION,
    projectRootDigest: createHash('sha256').update(root).digest('hex').slice(0, 16),
    name: error instanceof Error ? error.name : 'Error', message: redactSensitive(error instanceof Error ? error.message : String(error)),
    stack: error instanceof Error && error.stack ? redactSensitive(error.stack) : null };
}
function retention(env: Environment, key: string, fallback: number): number {
  const value = Number(env[key]); return Number.isFinite(value) && value > 0 ? value : fallback;
}
async function pruneCrashes(directory: string, env: Environment): Promise<void> {
  const maxAge = retention(env, 'DECKENT_CRASH_RETENTION_MAX_AGE_DAYS', 30) * 86400_000;
  const maxCount = retention(env, 'DECKENT_CRASH_RETENTION_MAX_COUNT', 200);
  const maxBytes = retention(env, 'DECKENT_CRASH_RETENTION_MAX_SIZE_MB', 50) * 1024 ** 2;
  const entries = await Promise.all((await readdir(directory)).filter(name => /^crash-\d+-\d+-[a-f0-9-]{36}\.json$/.test(name)).map(async name => {
    const path = join(directory, name), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
    try {
      const artifact = JSON.parse(await readFile(path, 'utf8')) as Partial<CrashArtifactV1>;
      if (artifact.schemaVersion !== 1 || typeof artifact.timestamp !== 'string' || typeof artifact.message !== 'string') return null;
      return { path, stat };
    } catch { return null; }
  }));
  let bytes = 0, count = 0;
  for (const entry of entries.filter(e => e !== null).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)) {
    count++; bytes += entry.stat.size;
    if (Date.now() - entry.stat.mtimeMs > maxAge || count > maxCount || bytes > maxBytes) await unlink(entry.path);
  }
}
export async function writeCrashArtifact(error: unknown, root: string, argv: readonly string[] = process.argv, env: Environment = process.env): Promise<string | null> {
  let temp: string | undefined;
  try {
    const directory = join(resolveDeckentHome(root, { env }), 'crashes');
    await mkdir(directory, { recursive: true });
    if ((await lstat(directory)).isSymbolicLink()) return null;
    const target = join(directory, `crash-${Date.now()}-${process.pid}-${randomUUID()}.json`);
    temp = `${target}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(buildCrashArtifact(error, root, argv))); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, target); temp = undefined;
    await pruneCrashes(directory, env);
    return target;
  } catch { return null; }
  finally { if (temp) await unlink(temp).catch(() => {}); }
}
/** Fatal path is best effort, including broken stderr and hostile error objects. */
export async function reportFatal(error: unknown, options: { root?: string; argv?: readonly string[]; env?: Environment; stderr?: OutputSink; json?: boolean; locale?: Locale } = {}): Promise<ExitCode> {
  let code: ExitCode = 1;
  try {
    code = error === undefined ? 1 : exitCodeFor(error);
    const typed = error instanceof DeckentError ? error : ErrorRegistry.createError('UNKNOWN', { message: error instanceof Error ? error.message : String(error) });
    const locale = options.locale ?? resolveLocale(undefined, options.env);
    emit({ code: typed.code, ...(typed.params && Object.keys(typed.params).length ? { params: Object.fromEntries(Object.entries(typed.params).map(([key, value]) => [key, typeof value === 'string' ? redactSensitive(value) : value])) } : {}), message: redactSensitive(typed.localize?.(locale).message ?? typed.message) }, { level: 'critical', ...(options.json === undefined ? {} : { json: options.json }),
      ...(options.stderr ? { stderr: options.stderr } : {}), render: () => formatHumanError(typed, { ...(options.locale ? { locale: options.locale } : {}), env: options.env ?? process.env, isTTY: process.stderr.isTTY ?? false }) });
  } catch { /* No second failure may escape the fatal boundary. */ }
  try {
    if (!(error instanceof DeckentError)) await writeCrashArtifact(error, options.root ?? process.cwd(), options.argv, options.env);
  } catch { /* Artifact persistence is independent of stderr availability. */ }
  return code;
}
