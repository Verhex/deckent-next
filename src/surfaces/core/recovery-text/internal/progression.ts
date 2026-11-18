import { runProgressionDiagnosticSchema, type RunProgressionDiagnostic, type RunView } from '#engine/index.js';
import { t, terminalSafeText, type Locale } from '#platform/index.js';
/** Private presentation projection; the public RunView and its serialized form are unchanged. */
export type ObservedRun = RunView & { readonly progression?: RunProgressionDiagnostic | undefined };
export function readRunProgressionDiagnostic(run: Pick<RunView, 'runId' | 'scopeId' | 'revision'>, input: unknown, now = Date.now()): RunProgressionDiagnostic | undefined {
  const parsed = runProgressionDiagnosticSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  return value.runId === run.runId && value.scopeId === run.scopeId && value.revision === run.revision
    && value.observedAtMs <= now && now <= value.validUntilMs ? value : undefined;
}
export function runProgressionWord(input: RunProgressionDiagnostic | undefined, locale: Locale): string {
  if (input?.state === 'unknown' && input.reason === 'RUN_PROGRESSION_COVERAGE_UNVERIFIED') return t('run.progression.coverageUnknown', {}, locale);
  if (!input || input.state === 'unknown') return t('run.progression.unknown', {}, locale);
  if (input.state === 'maintenance-only') return t('run.progression.maintenance', {}, locale);
  if (input.missing.some(cell => cell.reason === 'DENIED')) return t('run.progression.denied', {}, locale);
  if (input.missing.some(cell => cell.reason === 'APPROVAL_REQUIRED')) return t('run.progression.approvalRequired', {}, locale);
  if (input.missing.length) return input.missing.every(cell => cell.reason === 'NO_GRANT') ? t('run.progression.blocked', {}, locale) : t('run.progression.restricted', {}, locale);
  if (input.session === 'ineligible') return t('run.progression.repropose', {}, locale);
  return input.state === 'eligible' ? t('run.progression.eligible', {}, locale) : t('run.progression.suspended', {}, locale);
}
const commandArgument = (value: string) => /^[A-Za-z0-9._/:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
export function runProgressionLines(run: Pick<RunView, 'runId' | 'scopeId' | 'revision'>, input: unknown, locale: Locale, shownRunId = run.runId): string[] {
  const value = readRunProgressionDiagnostic(run, input), scope = commandArgument(run.scopeId), id = commandArgument(shownRunId);
  const inspect = `deckent run inspect --scope ${scope} --id ${id}`;
  const lines = [runProgressionWord(value, locale)];
  if (value) {
    lines.push(t('run.progression.observation', { actor: value.actor?.id ?? '—', scope: value.scopeId, revision: value.revision,
      at: value.observedAtMs, policy: value.policyRevision ?? '—', reason: value.reason }, locale));
    for (const cell of value.missing) lines.push(t('run.progression.cell', { cell: `${cell.kind}/${cell.id}/${cell.action}`, scope: cell.scope, reason: cell.reason, code: cell.code }, locale));
    const missing = value.missing.filter(cell => cell.reason === 'NO_GRANT');
    if (value.actorClass === 'ai' && missing.length && value.missing.every(cell => cell.reason === 'NO_GRANT')) lines.push(t('run.progression.permissionMissing', {
      command: `deckent policy upgrade --template current --only ai-execution --scope ${commandArgument(missing[0]!.scope)} --preview` }, locale));
    if (value.missing.some(cell => cell.reason !== 'NO_GRANT')) lines.push(t('run.progression.adminReview', {}, locale));
    if (value.parkUnavailable) lines.push(t('run.progression.parkUnavailable', {}, locale));
    if (value.state === 'blocked' && (value.reason === 'RUN_PROGRESSION_REPROPOSE_REQUIRED' || value.session === 'ineligible' || value.parkUnavailable)) lines.push(t('run.progression.reproposeNext', {}, locale));
  }
  lines.push(t('run.progression.inspectNext', { command: inspect }, locale));
  if (value && value.state !== 'eligible') lines.push(t('run.progression.controls', { hold: `deckent run hold --scope ${scope} --id ${id}`,
    cancel: `deckent run cancel --scope ${scope} --id ${id}` }, locale));
  return lines.map(line => terminalSafeText(line));
}
