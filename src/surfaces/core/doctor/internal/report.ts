import { t, type Locale } from '#platform/index.js';
import type { ToolchainCurrencyReport } from '#engine/index.js';

/** One realm resolution as doctor shows it (the adapter's `ShellRealmReport` shape; surfaces keep their own view). */
interface ShellRealmSelection { readonly selected: string | null; readonly marker: string | null; readonly notice: string | null; readonly code: string | null;
  readonly rejected: readonly { readonly kind: string; readonly reason: string }[] }
export interface ShellRealmDoctorView extends ShellRealmSelection { readonly mode: string; readonly preferSandbox: ShellRealmSelection | null }
/** The worker image refresh status as doctor shows it (WORKER-AUTO-REFRESH). */
export interface ImageRefreshDoctorView { readonly status: string; readonly reason: string | null; readonly imageVersion: string | null }
/** Doctor's installation binding view: strength and source kind only, never a machine value, digest or configured path. */
export interface InstallationBindingReport { readonly capability: 'supported' | 'unsupported' | 'source-invalid'; readonly strength?: 'machine' | 'weak' | null; readonly source?: string | null; readonly required?: boolean }
/** The installation's secret store as doctor shows it (SECRET-K1): backend id, status and typed code only; never a value. */
export interface SecretStoreDoctorLine { readonly backend: string; readonly status: string; readonly code?: string | null;
  readonly leftover?: { readonly backends: readonly string[]; readonly entries: number; readonly unverified?: readonly string[] } }

/** Recovery files an interrupted backup restore left behind (S1 D4); absolute paths of this user's own installation. */
export interface RecoveryFilesDoctorView { readonly leftovers: readonly string[] }

/** What the human rendering reads from the collected doctor report; the pool readiness lines arrive already rendered. */
export interface DoctorRenderInput {
  readonly platform: string;
  readonly host: { readonly cpuCores: number; readonly totalMemMB: number; readonly recommendedMaxWorkers: number };
  readonly company: { readonly companyId: string };
  readonly principal: { readonly id: string };
  readonly toolchains?: ToolchainCurrencyReport;
  readonly secretStore: SecretStoreDoctorLine | null;
  readonly imageRefresh: ImageRefreshDoctorView | null;
  readonly installationBinding: InstallationBindingReport | null;
  readonly shellRealm: ShellRealmDoctorView | null;
  readonly recoveryFiles?: RecoveryFilesDoctorView | null;
  /** Running service vs. the restart-apply configuration now in effect; absent/null when not asked. */
  readonly serviceConfig?: 'current' | 'stale' | 'unknown' | 'stopped' | null;
}

function imageRefreshText(view: ImageRefreshDoctorView, locale: Locale): string {
  const params = { reason: view.reason ?? '-', version: view.imageVersion ?? '-' };
  return view.status === 'updating' ? t('doctor.imageRefresh.updating', params, locale) : view.status === 'failed' ? t('doctor.imageRefresh.failed', params, locale) : t('doctor.imageRefresh.current', params, locale);
}
const installationBindingLines = (r: InstallationBindingReport, platform: string, locale: Locale): string[] => [r.capability === 'source-invalid' ? t('doctor.installationBinding.sourceInvalid', {}, locale)
  : r.capability === 'unsupported' ? t('doctor.installationBinding.unsupported', { platform }, locale) : r.strength === 'weak' ? t('doctor.installationBinding.weak', {}, locale)
    : t('doctor.installationBinding.machine', { source: r.source === 'configured' ? t('doctor.installationBinding.source.configured', {}, locale) : t('doctor.installationBinding.source.platform', {}, locale) }, locale), ...(r.required && r.strength !== 'machine' ? [t('doctor.installationBinding.required', {}, locale)] : [])];
/** The realm lines in the product's own sandbox words (the result marker, then the notice the live stream shows); no catalog text. */
function shellRealmLines(report: ShellRealmDoctorView): string[] {
  const lines = (view: ShellRealmSelection, label: string) => [`${view.marker ?? (view.selected === 'host' ? 'sandbox: host' : `sandbox: refused (${view.code ?? '-'})`)} [${label}]`,
    ...(view.notice ? [view.notice] : view.rejected.length ? [view.rejected.map(item => `${item.kind}: ${item.reason}`).join('; ')] : [])];
  return [...lines(report, `terminal.shell.realm ${report.mode}`), ...(report.preferSandbox ? lines(report.preferSandbox, 'sandbox-net (MCP default: network, own HOME)') : [])];
}

/** SECRET-AT-REST transparency (owner 2026-10-08): who can read the keys in each Core backend, in plain words; another backend has its own. */
function secretStoreCustodyLine(backend: string, locale: Locale): readonly string[] {
  if (backend === 'core.secret-store.env@1') return [t('doctor.secretStore.custody.env', {}, locale)];
  if (backend === 'core.secret-store.file@1') return [t('doctor.secretStore.custody.file', {}, locale)];
  if (backend === 'core.secret-store.encrypted-file@1') return [t('doctor.secretStore.custody.encryptedFile', {}, locale)];
  return [];
}

/** The human `doctor` text; `poolLines` are the pool readiness lines the caller (which owns the pool port) already rendered. */
export function renderDoctorReport(result: DoctorRenderInput, poolLines: readonly string[], locale: Locale): string {
  return [t('doctor.host', { platform: result.platform, cpu: result.host.cpuCores, memory: result.host.totalMemMB,
    workers: result.host.recommendedMaxWorkers, company: result.company.companyId, principal: result.principal.id }, locale),
  ...(result.toolchains ? [t('doctor.toolchains.header', { mode: result.toolchains.mode, endpoint: result.toolchains.registryEndpoint ?? '-' }, locale),
    ...result.toolchains.providers.map(entry => t('doctor.toolchains.entry', { provider: entry.provider, status: entry.reason ? `${entry.status} (${entry.reason})` : entry.status,
      admitted: entry.admitted.length ? entry.admitted.map(item => item.version ?? item.cliVersion).join(', ') : '-', latest: entry.latest?.version ?? '-' }, locale))] : []),
  // SECRET-K1: the selected secret store and whether it can be read now (backend id, status and typed code only; never a value).
  ...(result.secretStore ? [t('doctor.secretStore', { backend: result.secretStore.backend, status: result.secretStore.status,
    codeSuffix: result.secretStore.code ? `, ${result.secretStore.code}` : '' }, locale), ...secretStoreCustodyLine(result.secretStore.backend, locale),
    ...(result.secretStore.leftover?.entries ? [t('doctor.secretStore.leftover', { entries: result.secretStore.leftover.entries, backends: result.secretStore.leftover.backends.join(', ') }, locale)] : []),
    ...(result.secretStore.leftover?.unverified?.length ? [t('doctor.secretStore.leftoverUnverified', { backends: result.secretStore.leftover.unverified.join(', ') }, locale)] : [])] : []),
  ...(result.recoveryFiles?.leftovers.length ? [t('doctor.recoveryLeftovers', { paths: result.recoveryFiles.leftovers.join(', ') }, locale)] : []),
  ...(result.imageRefresh && result.imageRefresh.status !== 'unknown' ? [t('doctor.imageRefresh', { status: imageRefreshText(result.imageRefresh, locale) }, locale)] : []),
  ...(result.serviceConfig === 'stale' ? [t('doctor.serviceConfigStale', {}, locale)] : []),
  ...(result.installationBinding ? installationBindingLines(result.installationBinding, result.platform, locale) : []),
  ...poolLines,
  ...(result.shellRealm ? shellRealmLines(result.shellRealm) : [])].join('\n');
}
