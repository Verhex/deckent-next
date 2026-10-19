import { emit, t, type ConfigLoadOptions, type Locale, type loadConfig } from '#platform/index.js';
import { askCliCard, cliMode, formatDuration } from '#surfaces/core/cli-human/index.js';
import { DOCTOR_FIXES, type DoctorCheck } from '#surfaces/core/doctor/index.js';
import type { KernelCommandContext } from './context.js';

type DoctorConfig = Awaited<ReturnType<typeof loadConfig>>;
/** One fix the person may apply now: what the card says and the existing product operation that applies it. */
type Offer = Readonly<{ id: string; title: string; body: readonly string[]; apply: () => Promise<string> }>;
export interface DoctorFixInput {
  readonly checks: () => readonly DoctorCheck[]; readonly locale: Locale; readonly root: string; readonly options: ConfigLoadOptions;
  readonly config: DoctorConfig; readonly context: KernelCommandContext; readonly remeasure: () => Promise<void>;
}

/**
 * The registry fix's port, bound to the existing product operation the CLI already wires (the same call as the command named in the row's
 * next step). Absent here or unwired on the context: the fix is not offered and the row keeps its next step. `repairInstallationDirectory`
 * has no product operation yet (candidate policy action `installation/repair`, I-POL W3), so `chmod 700` stays a next step.
 */
function bind(port: string, input: DoctorFixInput): Readonly<{ title: string; effect: string; apply: Offer['apply'] }> | null {
  const { context, root, options, locale } = input;
  if (port === 'updateToolchains' && context.updateToolchains) {
    const update = context.updateToolchains, duration = formatDuration(input.config.toolchains.update.buildTimeoutMs, locale);
    return { title: t('doctor.fix.toolchainUpdate.title', {}, locale), effect: t('doctor.fix.toolchainUpdate.effect', { duration }, locale), apply: async () => {
      const result = await update(root, { apply: true }, options);
      const version = result.plan?.next?.imageVersion ?? '-';
      return result.decision === 'built' ? t('doctor.fix.toolchainUpdate.built', { version, proposal: result.proposalPath ?? '-' }, locale)
        : result.decision === 'no-change' ? t('doctor.fix.toolchainUpdate.noChange', {}, locale)
          : result.decision === 'disabled' ? t('doctor.fix.toolchainUpdate.disabled', {}, locale) : t('doctor.fix.toolchainUpdate.planned', { version }, locale);
    } };
  }
  return null;
}

/** The fixes the current rows allow: registry order, never a hard-floor item, only with a bound operation, at most once per call. */
export function doctorFixOffers(input: DoctorFixInput, offered: ReadonlySet<string>): Offer[] {
  const checks = input.checks(), offers: Offer[] = [];
  for (const fix of DOCTOR_FIXES) {
    if (fix.hardFloor || offered.has(fix.id)) continue;
    const rows = checks.filter(check => check.fix === fix.id);
    const bound = rows.length ? bind(fix.port, input) : null;
    if (bound) offers.push({ id: fix.id, apply: bound.apply, title: bound.title, body: [...rows.map(row => row.text), bound.effect] });
  }
  return offers;
}

/**
 * Interactive doctor (owner, CLI review 2026-10-19): on a person's terminal each offered fix is one card (apply / not now; never "always"),
 * applied only after the person picks apply, then everything is measured again. A pipe, CI, AI agent, `TERM=dumb` or `--json` caller is never
 * asked (the report is the whole answer). Declining or cancelling changes nothing. A typed refusal from the operation (for example a missing
 * grant) ends the call with that error after the report; nothing else is attempted.
 */
export async function offerDoctorFixes(input: DoctorFixInput): Promise<void> {
  const { context, locale } = input;
  if (cliMode(context).mode !== 'interactive') return;
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  const offered = new Set<string>();
  for (let offer = doctorFixOffers(input, offered)[0]; offer; offer = doctorFixOffers(input, offered)[0]) {
    offered.add(offer.id);
    const answer = await askCliCard({ title: offer.title, body: offer.body, options: [
      { id: 'apply', label: t('doctor.fix.apply', {}, locale), key: 'y' }, { id: 'skip', label: t('doctor.fix.skip', {}, locale), key: 'n' }] },
    { locale, ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.env ? { env: context.env } : {}),
      ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}), ...(context.signal ? { signal: context.signal } : {}) });
    if (answer !== 'apply') { emit(t('doctor.fix.declined', {}, locale), sinks); continue; }
    emit(t('doctor.fix.applying', {}, locale), sinks);
    emit(await offer.apply(), sinks);
    await input.remeasure();
  }
}
