import { emit, t, type ExitCode, type Locale } from '#platform/index.js';
import type { MemoryRolloutCriterionView, MemoryRolloutMetric, MemoryRolloutPhaseView, MemoryRolloutStatus } from '#engine/index.js';
import { safeCell } from '#surfaces/core/cli-human/index.js';
import { sinksOf } from '#surfaces/core/cli-approval/index.js';
import type { MemoryCommandContext } from './context.js';

const DAY_MS = 86_400_000, PER_MILLE = 1000;
/** A phase's wording by its switch (section, mode); a registry phase without a wording shows its switch itself. */
const STEP: Readonly<Record<string, (locale: Locale) => string>> = { 'extraction.on': locale => t('memory.rollout.step.extraction.on', {}, locale),
  'verification.shadow': locale => t('memory.rollout.step.verification.shadow', {}, locale), 'context.shadow': locale => t('memory.rollout.step.context.shadow', {}, locale),
  'context.on': locale => t('memory.rollout.step.context.on', {}, locale), 'verification.on': locale => t('memory.rollout.step.verification.on', {}, locale) };
const stepName = (phase: Pick<MemoryRolloutPhaseView, 'section' | 'set'>, locale: Locale) =>
  STEP[`${phase.section}.${phase.set}`]?.(locale) ?? `memoryAutomation.${phase.section}.mode ${phase.set}`;
type Values = Record<string, string | number>;
/** One sentence per measured metric (the registry names the metric; every metric of the closed set has its text). */
const METRIC: Readonly<Record<MemoryRolloutMetric, (values: Values, locale: Locale) => string>> = {
  agreement: (values, locale) => t('memory.rollout.metric.agreement', values, locale),
  'decided-since-false-pass': (values, locale) => t('memory.rollout.metric.decided-since-false-pass', values, locale),
  corpus: (values, locale) => t('memory.rollout.metric.corpus', values, locale),
  'independence-violations': (values, locale) => t('memory.rollout.metric.independence-violations', values, locale),
  'contest-rate': (values, locale) => t('memory.rollout.metric.contest-rate', values, locale),
  'context-shadow-runs': (values, locale) => t('memory.rollout.metric.context-shadow-runs', values, locale),
  'context-overflow': (values, locale) => t('memory.rollout.metric.context-overflow', values, locale),
  'context-integrity-violations': (values, locale) => t('memory.rollout.metric.context-integrity-violations', values, locale),
  'candidate-secret-findings': (values, locale) => t('memory.rollout.metric.candidate-secret-findings', values, locale),
  'purge-replay-pending': (values, locale) => t('memory.rollout.metric.purge-replay-pending', values, locale) };
/** The exact person command for one switch value (a person's terminal; the config write measures the criteria again). The value is the JSON
 * string `config set` takes, quoted for the shell. */
const command = (section: string, mode: string, scopeId: string) => `deckent config set memoryAutomation.${section}.mode '${JSON.stringify(mode)}' --scope ${scopeId}`;
const percent = (perMille: number) => `${Math.floor(perMille / 10)}.${perMille % 10}%`;
const ratio = (count: number, sample: number) => sample ? percent(Math.floor(count * PER_MILLE / sample)) : '-';
function criterionLine(row: MemoryRolloutCriterionView, locale: Locale): string {
  const { criterion, measure } = row, marker = row.met ? t('memory.rollout.met', {}, locale) : t('memory.rollout.unmet', {}, locale);
  if (!measure) return `  [${marker}] ${t('memory.rollout.unreadable', { criterion: criterion.id }, locale)}`;
  const threshold = criterion.minPerMille !== undefined ? `≥ ${percent(criterion.minPerMille)}` : criterion.maxPerMille !== undefined ? `≤ ${percent(criterion.maxPerMille)}` : '';
  const text = METRIC[criterion.metric]({ criterion: criterion.id, count: measure.count, sample: measure.sample, of: measure.of ?? measure.sample,
    minSample: criterion.minSample ?? 0, maxCount: criterion.maxCount ?? 0, ratio: ratio(measure.count, measure.sample), threshold }, locale);
  return `  [${marker}] ${text}${measure.complete ? '' : ` ${t('memory.rollout.partial', {}, locale)}`}`;
}
/** The value a set phase steps back to: the switch of the latest earlier phase on the same section, else off. */
const stepBack = (status: MemoryRolloutStatus, phase: MemoryRolloutPhaseView) =>
  status.view.phases.filter(row => row.section === phase.section && row.phase < phase.phase).at(-1)?.set ?? 'off';

/** `deckent memory rollout` lines (S4B-7, read-only): phase, switches, every gated phase's criteria with numbers, the next person action. */
export function rolloutLines(status: MemoryRolloutStatus, locale: Locale): string[] {
  const { view } = status, scope = safeCell(status.scopeId), current = view.phases.find(phase => phase.phase === view.phase);
  const lines = [current ? t('memory.rollout.title', { scope, phase: current.phase, name: stepName(current, locale) }, locale) : t('memory.rollout.title.none', { scope }, locale),
    t('memory.rollout.modes', { ...status.modes }, locale)];
  for (const phase of view.phases.filter(row => row.criteria.length > 0)) {
    lines.push(t('memory.rollout.criteria', { phase: phase.phase, name: stepName(phase, locale) }, locale), ...phase.criteria.map(row => criterionLine(row, locale)));
  }
  const next = view.next;
  if (!next) lines.push(t('memory.rollout.next.done', {}, locale));
  else {
    const values = { phase: next.phase, name: stepName(next, locale), command: command(next.section, next.set, status.scopeId) };
    lines.push(!next.criteria.length ? t('memory.rollout.next.open', values, locale) : next.met ? t('memory.rollout.next.ready', values, locale)
      : t('memory.rollout.next.blocked', { ...values, count: next.criteria.filter(row => !row.met).length }, locale));
  }
  for (const number of view.liveUnmet) {
    const phase = view.phases.find(row => row.phase === number)!;
    lines.push(t('memory.rollout.liveUnmet', { phase: number, criteria: phase.criteria.filter(row => !row.met).map(row => row.criterion.id).join(', '),
      command: command(phase.section, stepBack(status, phase), status.scopeId) }, locale));
  }
  const retention = status.retention, statusWord = (value: 'provisional' | 'measured') => value === 'provisional' ? t('memory.rollout.status.provisional', {}, locale) : t('memory.rollout.status.measured', {}, locale);
  if (!retention) lines.push(t('memory.rollout.retention.unreadable', {}, locale));
  else {
    lines.push(t('memory.rollout.retention', { status: statusWord(retention.status), revision: retention.revision, rows: retention.rows.map(row => t('memory.rollout.retention.row',
      { workClass: safeCell(row.workClassId), days: Math.floor(row.entryMaxAgeMs / DAY_MS), profile: safeCell(row.profileId) }, locale)).join(', ') }, locale));
    lines.push(retention.verified ? t('memory.rollout.retention.measured', { verified: retention.verified, stale: retention.stale, days: Math.floor((retention.oldestSupportAgeMs ?? 0) / DAY_MS),
      partial: retention.complete ? '' : ` ${t('memory.rollout.partial', {}, locale)}` }, locale) : t('memory.rollout.retention.empty', {}, locale));
  }
  lines.push(t('memory.rollout.registry', { revision: status.registry.revision, status: statusWord(status.registry.status), corpus: status.corpus.revision, items: status.corpus.items }, locale),
    t('memory.rollout.enables', {}, locale));
  return lines;
}
/** The action: `--json` prints the typed status (also a held one); a held read is shown on stderr with its next step and exits 1. */
export async function memoryRollout(args: { readonly json: boolean }, context: MemoryCommandContext, io: { readonly root: string; readonly options: { readonly env: NodeJS.ProcessEnv };
  readonly locale: Locale; readonly scopeId: string; readonly notice: string; readonly held: (code: 'MEMORY_UNAVAILABLE' | 'MEMORY_CORRUPT' | 'MEMORY_PURGE_REPLAY_HELD') => string }): Promise<ExitCode | undefined> {
  const sinks = sinksOf(context), result = await context.inspectMemoryRollout!(io.root, io.scopeId, io.options);
  if (args.json) { emit(result, { ...sinks, json: true }); return result.status === 'held' ? 1 : undefined; }
  if (result.status === 'held') { emit(t('memory.held', { code: result.code, next: io.held(result.code) }, io.locale), { ...sinks, level: 'error' }); return 1; }
  emit([io.notice, ...rolloutLines(result, io.locale)].join('\n'), sinks);
  return undefined;
}
