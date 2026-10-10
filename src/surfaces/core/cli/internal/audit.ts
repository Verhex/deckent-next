import { auditCheckpointVerifyCommandSchema, type AuditCheckpointVerifyCommand } from '#domain/index.js';
import type { AuditCheckpointVerification } from '#engine/index.js';
import { emit, ErrorRegistry, formatValue, loadConfigLanguage, resolveLocale, t, type ConfigLoadOptions } from '#platform/index.js';
import type { CommandContext } from './kernel-commands.js';
export type AuditCheckpointVerifyHandler = (root: string, input: AuditCheckpointVerifyCommand, options: ConfigLoadOptions) => Promise<AuditCheckpointVerification>;
export async function auditCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  if (argv[1] !== 'verify') throw ErrorRegistry.createError('CLI_USAGE');
  let scopeId: string | undefined, sequence: number | undefined, digest: string | undefined, language: string | undefined, json = false;
  for (let i = 2; i < argv.length; i++) {
    const next = () => { const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); return value; };
    const flag = argv[i];
    if (flag === '--scope' && scopeId === undefined) scopeId = next();
    else if (flag === '--anchor-sequence' && sequence === undefined) sequence = Number(next());
    else if (flag === '--anchor-digest' && digest === undefined) digest = next();
    else if (flag === '--lang' && language === undefined) language = next();
    else if (flag === '--json' && !json) json = true;
    else throw ErrorRegistry.createError('CLI_USAGE');
  }
  const parsed = auditCheckpointVerifyCommandSchema.safeParse({ schemaVersion: 1, scopeId,
    ...(sequence !== undefined || digest !== undefined ? { anchor: { sequence, digest } } : {}) });
  if (!parsed.success || !context.verifyAuditCheckpoints) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), options = { ...(context.env ? { env: context.env } : {}) };
  const locale = resolveLocale(language, context.env, await loadConfigLanguage(root, options).catch(() => undefined)); context.onLocale?.(locale);
  const result = await context.verifyAuditCheckpoints(root, parsed.data, options);
  emit(result, { json, render: data => (data.status === 'verified' ? t('cli.audit.verified', {}, locale) : t('cli.audit.missing', {}, locale)) + '\n' + formatValue(data),
    ...(context.stdout ? { stdout: context.stdout } : {}) });
  if (result.status === 'missing-checkpoint') throw ErrorRegistry.createError('AUDIT_CHECKPOINT_MISSING');
}
