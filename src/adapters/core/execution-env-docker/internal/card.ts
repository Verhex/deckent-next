import { MESSAGE_REGISTRY, t, terminalSafeText, type Locale } from '#platform/index.js';
import type { ExecutionFacts, ExecutionInstallOffer } from '#adapters/core/setup-detect-execution/index.js';
import { DOCKER_APT, type DockerAptData } from './registry.js';
import { dockerCommandLines, type DockerInstallPlan, type DockerPrintReason } from './plan.js';
import type { DockerInstallResult } from './install.js';

/** The setup operation of an approved install (never in an operation catalog or an MCP tool; INIT-D2 cond. 1). */
export const EXECUTION_ENVIRONMENT_INSTALL = Object.freeze({ id: 'execution-environment.install', version: 1 });
/**
 * I-S2's seam: offer the install only to a person at a real terminal (`person` is the surface's own decision: not `--yes`, `--json`, an agent,
 * CI, MCP or the SDK), only for this registry entry, and only when detection says it is absent (never on `unknown`, never over a found CLI).
 */
export const dockerInstallOffer = (person: boolean, data: DockerAptData = DOCKER_APT) => (facts: ExecutionFacts): ExecutionInstallOffer | null => {
  const row = facts.runtimes.find(entry => entry.id === data.environment && entry.support === 'supported');
  return person && row?.cli === 'absent' ? { operation: { ...EXECUTION_ENVIRONMENT_INSTALL, input: { environment: data.environment } },
    question: { key: 'setup.execution.install', params: { runtime: row.label } }, cli: null } : null;
};
const fingerprint = (data: DockerAptData) => data.key.fingerprint.replace(/(.{4})(?!$)/g, '$1 ');
/** The approval card's body (EN/TR): the exact commands first, then source and key, the version rule, the root-equivalent group, sudo's own
 * prompt (NOPASSWD stated; no sudo call happens before the card, cond. 2 order), interruption and how to undo it (compensation is manual). */
export function dockerCardBody(plan: Extract<DockerInstallPlan, { kind: 'install' }>, locale: Locale, data: DockerAptData = DOCKER_APT): readonly string[] {
  const user = plan.steps.at(-1)!.argv.at(-1)!;
  return [t('setup.docker.card.sudo', {}, locale), ...dockerCommandLines(plan.steps).map(line => `  $ ${line}`),
    t('setup.docker.card.source', { ...plan.source, fingerprint: fingerprint(data) }, locale), t('setup.docker.card.version', {}, locale),
    t('setup.docker.card.group', { user, group: data.group }, locale), t('setup.docker.card.nopasswd', {}, locale),
    t('setup.docker.card.interrupt', {}, locale), t('setup.docker.card.undo', { packages: data.packages.join(' ') }, locale)];
}
type PrintParams = Readonly<Record<string, string>>;
const PRINT: Readonly<Record<DockerPrintReason, (params: PrintParams, locale: Locale) => string>> = Object.freeze({
  platform: (p, l) => t('setup.docker.print.platform', p, l), desktop: (p, l) => t('setup.docker.print.desktop', p, l), distribution: (p, l) => t('setup.docker.print.distribution', p, l),
  conflicts: (p, l) => t('setup.docker.print.conflicts', p, l), repository: (p, l) => t('setup.docker.print.repository', p, l), network: (p, l) => t('setup.docker.print.network', p, l) });
/** A print-only answer: why, and the commands when they are known (the staged key and source files stay for them). */
export function dockerPrintLines(plan: Extract<DockerInstallPlan, { kind: 'print' }>, locale: Locale, data: DockerAptData = DOCKER_APT): readonly string[] {
  const supported = data.distributions.map(item => `${item.id} ${item.codenames.join('/')} (${item.architectures.join('/')})`).join('; ');
  return [PRINT[plan.reason]({ docs: data.docs, url: plan.source?.url ?? data.docs, staging: plan.staging ?? '-', supported, detail: plan.detail }, locale),
    ...plan.steps ? dockerCommandLines(plan.steps).map(line => `  $ ${line}`) : []];
}
const RESULT: Readonly<Record<DockerInstallResult['status'], (params: Readonly<Record<string, string | number>>, locale: Locale) => string>> = Object.freeze({
  succeeded: (p, l) => t('setup.docker.result.succeeded', p, l), failed: (p, l) => t('setup.docker.result.failed', p, l), uncertain: (p, l) => t('setup.docker.result.uncertain', p, l) });
/** After the effect: what ran, then the re-detected state in the setup family's own words (its reason key; relogin, stopped, ready …). */
export function dockerResultLines(result: DockerInstallResult, steps: number, next: Readonly<{ code: string; params?: Readonly<Record<string, string | number>> | undefined }>, locale: Locale): readonly string[] {
  const text = (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[next.code] ?? next.code, params = next.params ?? {};
  return [result.mismatch ? t('setup.docker.result.mismatch', { keyring: DOCKER_APT.keyring, sources: DOCKER_APT.sourcesFile }, locale)
    : RESULT[result.status]({ step: result.step ?? 0, steps, code: result.exitCode ?? '-', version: result.version ?? '-' }, locale),
    text.replace(/\{(\w+)\}/gu, (whole, name: string) => Object.hasOwn(params, name) ? terminalSafeText(String(params[name])) : whole)];
}
