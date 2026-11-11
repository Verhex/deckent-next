import { readTimingSummary } from '#platform/index.js';
import { t, ErrorRegistry } from '#platform/index.js';
import type { TimingPhase, Locale } from '#platform/index.js';
import type { KernelCall } from './kernel.js';

const phaseText = (phase: TimingPhase, locale: Locale): string => {
  switch (phase) {
    case 'process-entry': return t('doctor.timing.phase.process-entry', {}, locale);
    case 'queued': return t('doctor.timing.phase.queued', {}, locale);
    case 'started': return t('doctor.timing.phase.started', {}, locale);
    case 'gate-passed': return t('doctor.timing.phase.gate-passed', {}, locale);
    case 'dispatch': return t('doctor.timing.phase.dispatch', {}, locale);
    case 'first-flush': return t('doctor.timing.phase.first-flush', {}, locale);
    case 'populated-flush': return t('doctor.timing.phase.populated-flush', {}, locale);
    case 'first-output': return t('doctor.timing.phase.first-output', {}, locale);
    case 'finished': return t('doctor.timing.phase.finished', {}, locale);
    case 'cancelled': return t('doctor.timing.phase.cancelled', {}, locale);
    case 'read-completed': return t('doctor.timing.phase.read-completed', {}, locale);
    case 'exit': return t('doctor.timing.phase.exit', {}, locale);
  }
};
export async function timingCommand(call: KernelCall): Promise<void> {
  if (call.args.positionals.length !== 2 || call.args.toolchains || call.args.verbose || call.args.global || call.args.dryRun) throw ErrorRegistry.createError('CLI_USAGE');
  const summary = await readTimingSummary(call.env);
  call.output(summary, value => [t('doctor.timing.title', {}, call.locale),
    ...value.commands.map(row => t('doctor.timing.row', { command: row.command, samples: row.samples, median: row.median.toFixed(1), p95: row.p95.toFixed(1), phase: phaseText(row.slowestPhase, call.locale) }, call.locale)),
    ...(value.commands.length ? [] : [t('doctor.timing.empty', {}, call.locale)]),
    t('doctor.timing.dropped', { count: value.dropped }, call.locale)].join('\n'));
}
