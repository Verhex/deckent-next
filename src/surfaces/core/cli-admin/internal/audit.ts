import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { auditVerifyQuerySchema, type AuditVerifyQuery, type AuditVerification } from '#domain/index.js';
import { renderAuditStatus, renderAuditReason } from '#surfaces/core/doctor/index.js';
import { emit, ErrorRegistry, EXIT_CODES, loadConfig, t, terminalSafeText, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import { commandLocale, readJsonInput } from '#surfaces/core/cli-kit/index.js';
import { formatAgo } from '#surfaces/core/cli-human/index.js';
import type { AdminCommandContext } from './context.js';
import { adminSinks, askAdminCard } from './io.js';
export type AuditVerifyHandler = (root: string, query: AuditVerifyQuery, options: ConfigLoadOptions) => Promise<AuditVerification>;
export type AuditRebaselineView = AuditVerification & { readonly policyDigest: string; readonly producersDigest: string };
export type AuditRebaselineHandler = (root: string, input: unknown, options: ConfigLoadOptions, confirm: (current: AuditRebaselineView) => Promise<boolean>) => Promise<AuditVerification | null>;

/** Owner CLI review 2026-10-19 (`audit`): the result, the last checkpoint in human time, and what this check can and cannot show. */
function renderVerification(result: AuditVerification, locale: Locale, now: number): string {
  const checkpoint = result.checkpoint?.checkpoint;
  return [t('cli.audit.result', { scope: terminalSafeText(result.scopeId), status: renderAuditStatus(result.status, locale), reason: renderAuditReason(result.reason, locale) }, locale),
    checkpoint ? t('cli.audit.lastCheckpoint', { ago: formatAgo(checkpoint.atMs, now, locale), sequence: checkpoint.sequence }, locale) : t('cli.audit.noCheckpoint', {}, locale),
    t('cli.audit.limit', {}, locale)].join('\n');
}
/** The witness into a new private file the person named; an existing file is never overwritten. */
async function exportCheckpoint(path: string, witness: AuditVerification['checkpoint']): Promise<string> {
  if (!witness) throw ErrorRegistry.createError('AUDIT_CHECKPOINT_EXPORT_EMPTY');
  const target = resolve(path);
  const handle = await open(target, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    throw ErrorRegistry.createError(error.code === 'EEXIST' ? 'AUDIT_CHECKPOINT_EXPORT_EXISTS' : 'AUDIT_CHECKPOINT_EXPORT_FAILED', { params: { path: terminalSafeText(target) } }); });
  try { await handle.writeFile(`${JSON.stringify(witness)}\n`); await handle.sync(); } finally { await handle.close(); }
  return target;
}
/**
 * `deckent audit verify [--scope <id>] [--checkpoint <file|->] [--export-checkpoint [<file>]] [--json]`: read-only verification. A pull export
 * without a file is stdout JSON (the caller owns custody, as before); with a file it is written there (0600, never over an existing file) and
 * the path is reported. Anything but `match` exits non-zero.
 */
export async function auditCommand(argv: readonly string[], context: AdminCommandContext): Promise<ExitCode> {
  if (argv[1] === 'rebaseline') return rebaselineCommand(argv, context);
  if (argv[1] !== 'verify' || !context.verifyAudit) throw ErrorRegistry.createError('CLI_USAGE');
  const values = new Map<string, string>(); let json = false, exporting = false, exportFile: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--export-checkpoint' && !exporting) { exporting = true; const file = argv[i + 1]; if (file !== undefined && !file.startsWith('-')) { exportFile = file; i++; } continue; }
    if (arg === '--no-color') continue;
    if (!['--scope', '--lang', '--checkpoint'].includes(arg) || values.has(arg)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(arg, value);
  }
  if (exporting && values.has('--checkpoint')) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, config = await loadConfig(root, { env });
  const locale = commandLocale(context, values.get('--lang'));
  const scopeId = values.get('--scope') ?? (config.terminal as { scopeId?: string } | undefined)?.scopeId;
  if (!scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  const source = values.get('--checkpoint'), witness = source ? await readJsonInput(source, config.cli.graphInputMaxBytes,
    { limit: 'CLI_USAGE', invalid: 'CLI_USAGE', tty: 'CLI_USAGE', unavailable: 'CLI_USAGE' }, context.stdin) : undefined;
  const parsed = auditVerifyQuerySchema.safeParse({ schemaVersion: 1, scopeId, ...(source ? { witness } : {}) });
  if (!parsed.success) throw ErrorRegistry.createError('CLI_USAGE');
  const result = await context.verifyAudit(root, parsed.data, { env });
  if (exportFile !== undefined) {
    const saved = await exportCheckpoint(exportFile, result.checkpoint);
    emit({ schemaVersion: 1, exported: saved, sequence: result.checkpoint!.checkpoint.sequence }, { json, ...adminSinks(context),
      render: () => t('cli.audit.exported', { path: terminalSafeText(saved), sequence: result.checkpoint!.checkpoint.sequence }, locale) });
  } else emit(exporting ? result.checkpoint : result, { json: exporting || json, ...adminSinks(context), render: () => renderVerification(result, locale, Date.now()) });
  return result.status === 'match' ? EXIT_CODES.success : EXIT_CODES.error;
}

/** `deckent audit rebaseline --scope <id> --reason <text>`: one card shows the current state, the reason and what becomes the new baseline;
 * only an explicit "apply" writes. Composition refuses MCP, socket peers and any caller that is not an attested local terminal first. */
async function rebaselineCommand(argv: readonly string[], context: AdminCommandContext): Promise<ExitCode> {
  if (!context.rebaselineAudit) throw ErrorRegistry.createError('CLI_USAGE');
  const values = new Map<string, string>(); let json = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--no-color') continue;
    if (!['--scope', '--lang', '--reason'].includes(arg) || values.has(arg)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(arg, value);
  }
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, config = await loadConfig(root, { env });
  const locale = commandLocale(context, values.get('--lang'));
  const scopeId = values.get('--scope') ?? (config.terminal as { scopeId?: string } | undefined)?.scopeId, reason = values.get('--reason');
  if (!scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  if (!reason?.trim()) throw ErrorRegistry.createError('CLI_USAGE');
  const result = await context.rebaselineAudit(root, { schemaVersion: 1, scopeId, reason }, { env }, async current => {
    const [title, ...body] = t('cli.audit.rebaseline.card', { scope: terminalSafeText(scopeId), status: renderAuditStatus(current.status, locale), reason: renderAuditReason(current.reason, locale),
      text: terminalSafeText(reason), head: current.head?.sequence ?? 0, headDigest: current.head?.digest.slice(0, 12) ?? '—', policy: current.policyDigest.slice(0, 12),
      producers: current.producersDigest.slice(0, 12) }, locale).split('\n');
    return await askAdminCard(context, locale, { title: title!, body, options: [{ id: 'apply', label: t('cli.audit.rebaseline.apply', {}, locale), key: 'y' },
      { id: 'cancel', label: t('cli.admin.card.cancel', {}, locale), key: 'n' }] }) === 'apply';
  });
  if (!result) { emit(t('cli.audit.rebaseline.declined', {}, locale), { level: 'error', ...adminSinks(context) }); return EXIT_CODES.error; }
  emit(result, { json, ...adminSinks(context), render: () => t('cli.audit.rebaseline.done', { scope: terminalSafeText(result.scopeId), sequence: result.checkpoint?.checkpoint.sequence ?? 0,
    head: result.head?.sequence ?? 0 }, locale) });
  return result.status === 'match' ? EXIT_CODES.success : EXIT_CODES.error;
}
