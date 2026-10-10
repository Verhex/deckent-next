import { createInterface } from 'node:readline/promises';
import { IDENTITY_PROFILE_LIMITS } from '#domain/index.js';
import { ErrorRegistry, emit, resolveLocale, t, type ConfigLoadOptions } from '#platform/index.js';
import type { IdentityDistributionPreview, IdentityProfileDistributionApplication } from '#engine/index.js';
import { readJsonInput, type CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import { renderIdentityPreview } from './render.js';

type Choices = Awaited<ReturnType<IdentityProfileDistributionApplication['choices']>>;
export interface IdentityDistributionContext extends CliBaseContext {
  listIdentityDistributionChoices?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<Choices>;
  previewIdentityDistribution?: (root: string, selection: unknown, options: ConfigLoadOptions) => Promise<IdentityDistributionPreview>;
  applyIdentityDistribution?: (root: string, submission: unknown, expect: string, options: ConfigLoadOptions) => Promise<{
    readonly schemaVersion: 1; readonly profile: { readonly id: string; readonly version: number }; readonly digest: string;
    readonly outcome: import('#engine/index.js').EffectOutcome }>;
}
const safe = (value: string) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
export async function identityDistributionCommand(argv: readonly string[], context: IdentityDistributionContext) {
  const values = new Map<string, string>(); let apply = false, json = false;
  const usage = () => ErrorRegistry.createError('CLI_USAGE');
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--apply' && !apply && argv[1] === 'distribute') { apply = true; continue; }
    if (flag === '--no-color') continue;
    if (!['--scope', '--lang', '--input', '--expect'].includes(flag) || values.has(flag)) throw usage();
    const value = argv[++i]; if (!value || value.startsWith('--')) throw usage(); values.set(flag, value);
  }
  const env = context.env ?? process.env, locale = resolveLocale(values.get('--lang'), env); context.onLocale?.(locale);
  const root = context.root ?? process.cwd(), options = { env }, stdin = context.stdin ?? process.stdin, stderr = context.stderr ?? process.stderr;
  const sinks = { json, ...(context.stdout ? { stdout: context.stdout } : {}), stderr };
  const scope = values.get('--scope'), path = values.get('--input'), expect = values.get('--expect');
  if (argv[1] === 'choices') {
    if (!scope || apply || path || expect || !context.listIdentityDistributionChoices) throw usage();
    const choices = await context.listIdentityDistributionChoices(root, scope, options);
    emit(choices, { ...sinks, render: value => [...value.profiles.map(item => `${item.definition.id}@${item.definition.version}: ${item.definition.roleTemplates.map(role => role.id).join(', ')}`),
      ...value.principals.map(item => `${safe(item.id)}: ${safe(item.label)}`), ...value.scopeIds.map(safe)].join('\n') }); return;
  }
  if (!context.previewIdentityDistribution || !context.applyIdentityDistribution || (expect && !apply)) throw usage();
  if (path) {
    if (scope || (apply && !expect)) throw usage();
    const body = await readJsonInput(path, IDENTITY_PROFILE_LIMITS.maxInputBytes,
      { limit: 'IDENTITY_PREVIEW_LIMIT', invalid: 'IDENTITY_PREVIEW_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'IDENTITY_PREVIEW_UNAVAILABLE' }, stdin);
    if (apply) {
      emit(await context.applyIdentityDistribution(root, body, expect!, options), { ...sinks, render: result => t('identity.distributionResult', { status: result.outcome.status }, locale) }); return;
    }
    emit(await context.previewIdentityDistribution(root, body, options), { ...sinks, render: result => `${renderIdentityPreview(result.preview, locale)}\n${t('identity.distributionExpect', { digest: result.digest }, locale)}` }); return;
  }
  // Every interactive input is a bounded numbered selection. No fallback accepts a typed principal, role or policy.
  if (!stdin.isTTY || !scope || expect || !context.listIdentityDistributionChoices) throw usage();
  const choices = await context.listIdentityDistributionChoices(root, scope, options), prompt = createInterface({ input: stdin, output: stderr as NodeJS.WritableStream });
  try {
    const pick = async <T>(rows: readonly T[], label: (row: T) => string): Promise<T> => {
      if (!rows.length) throw ErrorRegistry.createError('IDENTITY_PREVIEW_UNAVAILABLE');
      rows.forEach((row, i) => stderr.write(`${i + 1}. ${safe(label(row))}\n`));
      const answer = await prompt.question(t('identity.selectNumber', {}, locale));
      if (!/^[1-9][0-9]*$/.test(answer) || !rows[Number(answer) - 1]) throw usage();
      return rows[Number(answer) - 1]!;
    };
    const profile = await pick(choices.profiles, entry => `${entry.definition.id}@${entry.definition.version}`);
    const principal = await pick(choices.principals, entry => entry.label);
    const role = await pick(profile.definition.roleTemplates, entry => entry.id);
    const project = await pick(choices.scopeIds, id => id);
    const prepared = await context.previewIdentityDistribution(root, { schemaVersion: 1, profile: { id: profile.definition.id, version: profile.definition.version },
      scopeId: scope, assignments: [{ principalId: principal.id, roleId: role.id, scopeIds: [project] }], removeBindingIds: [] }, options);
    if (!apply) { emit(prepared, { ...sinks, render: result => `${renderIdentityPreview(result.preview, locale)}\n${t('identity.distributionExpect', { digest: result.digest }, locale)}` }); return; }
    stderr.write(`${renderIdentityPreview(prepared.preview, locale)}\n${t('identity.distributionExpect', { digest: prepared.digest }, locale)}\n`);
    if (await pick([false, true], choice => choice ? t('identity.approveDistribution', {}, locale) : t('identity.cancelDistribution', {}, locale))) {
      emit(await context.applyIdentityDistribution(root, prepared.submission, prepared.digest, options), { ...sinks, render: result => t('identity.distributionResult', { status: result.outcome.status }, locale) });
    }
  } finally { prompt.close(); }
}
