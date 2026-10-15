import { auditVerifyQuerySchema, type AuditVerifyQuery, type AuditVerification } from '#domain/index.js';
import { renderAuditStatus, renderAuditReason } from '#surfaces/core/doctor/index.js';
import { emit, ErrorRegistry, EXIT_CODES, loadConfig, resolveLocale, t, type ConfigLoadOptions, type ExitCode } from '#platform/index.js';
import { readJsonInput } from '#surfaces/core/cli-kit/index.js';
import { createInterface } from 'node:readline';
import type { CommandContext } from './kernel-commands.js';
export type AuditVerifyHandler = (root: string, query: AuditVerifyQuery, options: ConfigLoadOptions) => Promise<AuditVerification>;
export type AuditRebaselineHandler = (root: string, input: unknown, options: ConfigLoadOptions, confirm: (current: AuditVerification) => Promise<boolean>) => Promise<AuditVerification | null>;
/** One card, one explicit y; EOF, blank input and every other answer decline. */
async function askRebaseline(card: string, prompt: string, context: CommandContext): Promise<boolean> {
  const output = context.stderr ?? process.stderr; output.write(card + '\n');
  const reader = createInterface({ input: context.stdin ?? process.stdin, terminal: false });
  try {
    return await new Promise<boolean>(resolve => {
      reader.once('close', () => resolve(false)); output.write(prompt); reader.once('line', line => resolve(line.trim().toLowerCase() === 'y'));
    });
  } finally { reader.close(); }
}
/** Pull export is stdout JSON, so the caller owns destination custody; no server-selected filesystem path. Anything but `match` exits non-zero. */
export async function auditCommand(argv: readonly string[], context: CommandContext): Promise<ExitCode> {
  if (argv[1] === 'rebaseline') return rebaselineCommand(argv, context);
  if (argv[1] !== 'verify' || !context.verifyAudit) throw ErrorRegistry.createError('CLI_USAGE');
  const values = new Map<string, string>(); let json = false, exporting = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--export-checkpoint' && !exporting) { exporting = true; continue; }
    if (arg === '--no-color') continue;
    if (!['--scope', '--lang', '--checkpoint'].includes(arg) || values.has(arg)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(arg, value);
  }
  if (exporting && values.has('--checkpoint')) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, config = await loadConfig(root, { env });
  const locale = resolveLocale(values.get('--lang'), env, config.language); context.onLocale?.(locale);
  const scopeId = values.get('--scope') ?? (config.terminal as { scopeId?: string } | undefined)?.scopeId;
  if (!scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  const source = values.get('--checkpoint'), witness = source ? await readJsonInput(source, config.cli.graphInputMaxBytes,
    { limit: 'CLI_USAGE', invalid: 'CLI_USAGE', tty: 'CLI_USAGE', unavailable: 'CLI_USAGE' }, context.stdin) : undefined;
  const parsed = auditVerifyQuerySchema.safeParse({ schemaVersion: 1, scopeId, ...(source ? { witness } : {}) });
  if (!parsed.success) throw ErrorRegistry.createError('CLI_USAGE');
  const query = parsed.data;
  const result = await context.verifyAudit(root, query, { env });
  emit(exporting ? result.checkpoint : result, { json: exporting || json, ...(context.stdout ? { stdout: context.stdout } : {}),
    ...(context.stderr ? { stderr: context.stderr } : {}), render: () => t('cli.audit.result', { scope: result.scopeId,
      status: renderAuditStatus(result.status, locale), reason: renderAuditReason(result.reason, locale) }, locale) });
  return result.status === 'match' ? EXIT_CODES.success : EXIT_CODES.error;
}

/** `deckent audit rebaseline --scope <id> --reason <text>`: shows the current state and the reason, then one y/N; declining writes nothing. */
async function rebaselineCommand(argv: readonly string[], context: CommandContext): Promise<ExitCode> {
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
  const locale = resolveLocale(values.get('--lang'), env, config.language); context.onLocale?.(locale);
  const scopeId = values.get('--scope') ?? (config.terminal as { scopeId?: string } | undefined)?.scopeId, reason = values.get('--reason');
  if (!scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  if (!reason?.trim()) throw ErrorRegistry.createError('CLI_USAGE');
  const result = await context.rebaselineAudit(root, { schemaVersion: 1, scopeId, reason }, { env }, current => askRebaseline(t('cli.audit.rebaseline.card', { scope: scopeId,
    status: renderAuditStatus(current.status, locale), reason: renderAuditReason(current.reason, locale), text: reason }, locale), t('cli.audit.rebaseline.prompt', {}, locale), context));
  const sink = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (!result) { emit(t('cli.audit.rebaseline.declined', {}, locale), { level: 'error', ...sink }); return EXIT_CODES.error; }
  emit(result, { json, ...sink, render: () => t('cli.audit.rebaseline.done', { scope: result.scopeId, sequence: result.checkpoint?.checkpoint.sequence ?? 0,
    head: result.head?.sequence ?? 0 }, locale) });
  return result.status === 'match' ? EXIT_CODES.success : EXIT_CODES.error;
}
