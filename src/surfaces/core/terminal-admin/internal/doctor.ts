import { t, type Locale, type OutputSink } from '#platform/index.js';
import type { InfoChip, InfoChipState, InfoSection, InfoView } from '#surfaces/core/terminal-window/index.js';

/** `/doctor`: the very report `deckent doctor` prints, captured as lines (`run` is the CLI's own doctor command writing to this sink). */
export async function doctorLines(run: (sink: OutputSink) => Promise<void>): Promise<readonly string[]> {
  return (await capture(run)).replace(/\n+$/u, '').split('\n');
}

async function capture(run: (sink: OutputSink) => Promise<void>): Promise<string> {
  let text = '';
  await run({ write: chunk => { text += chunk; return true; } });
  return text;
}

/** The fields of `deckent doctor --json` (schema 2) the window reads; every field is optional here and checked before use. */
type DoctorJson = Partial<Readonly<{ schemaVersion: number; scope: string; platform: string; status: string;
  host: Readonly<{ cpuCores: number; totalMemMB: number; recommendedMaxWorkers: number }>; company: Readonly<{ companyId: string }>; principal: Readonly<{ id: string }>;
  secretStore: Readonly<{ backend: string; status: string; code?: string | null }> | null; serviceConfig: string | null;
  imageRefresh: Readonly<{ status: string; reason: string | null; imageVersion: string | null }> | null;
  installationBinding: Readonly<{ capability: string; strength?: string | null; required?: boolean }> | null;
  poolReadiness: Readonly<{ status: string; code?: string | null }> | null;
  shellRealm: Readonly<{ selected: string | null; code: string | null; notice: string | null; mode: string;
    preferSandbox: Readonly<{ selected: string | null; code: string | null; notice: string | null }> | null }> | null;
  toolchains: Readonly<{ providers: readonly Readonly<{ provider: string; status: string; reason?: string | null }>[] }> }>>;

/** The report object among the JSON lines the doctor wrote (configuration warnings are JSON lines on the same sink). */
export function doctorReportOf(text: string): DoctorJson | null {
  for (const line of text.split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try { const value = JSON.parse(line) as DoctorJson; if (value && value.scope === 'kernel' && value.schemaVersion === 2) return value; } catch { /* not the report */ }
  }
  return null;
}

/**
 * `/doctor` as a window (SW-1): the doctor's own structured report (`deckent doctor --json`, the same command and checks) grouped by area,
 * each area with a pass / check / failed chip in words. Without a structured report (an older host) the doctor text is one section.
 */
export async function doctorView(locale: Locale, report: ((sink: OutputSink) => Promise<void>) | null, text: (sink: OutputSink) => Promise<void>): Promise<InfoView> {
  const chip = (state: InfoChipState): InfoChip => ({ state, text: state === 'ok' ? t('terminal.info.chip.ok', {}, locale) : state === 'warn' ? t('terminal.info.chip.check', {}, locale)
    : state === 'fail' ? t('terminal.info.chip.failed', {}, locale) : t('terminal.info.chip.unknown', {}, locale) });
  const data = report ? doctorReportOf(await capture(report)) : null;
  const sections: InfoSection[] = [];
  if (!data) {
    const lines = (await capture(text)).replace(/\n+$/u, '').split('\n');
    sections.push({ title: t('terminal.info.doctor.section.report', {}, locale), items: lines.filter(line => line.trim()).map(line => ({ text: line })), notes: [t('terminal.info.doctor.reportFallback', {}, locale)] });
  } else {
    if (data.host) sections.push({ title: t('terminal.info.doctor.section.machine', {}, locale), rows: [{ key: t('terminal.info.doctor.key.platform', {}, locale), value: data.platform ?? '-' },
      { key: t('terminal.info.doctor.key.cpu', {}, locale), value: String(data.host.cpuCores) }, { key: t('terminal.info.doctor.key.memory', {}, locale), value: t('terminal.info.doctor.memoryValue', { memory: data.host.totalMemMB }, locale) },
      { key: t('terminal.info.doctor.key.workers', {}, locale), value: String(data.host.recommendedMaxWorkers) }] });
    sections.push({ title: t('terminal.info.doctor.section.identity', {}, locale), rows: [
      { key: t('terminal.info.doctor.key.company', {}, locale), value: !data.company || data.company.companyId === 'default' ? t('terminal.info.doctor.companyDefault', {}, locale) : data.company.companyId },
      { key: t('terminal.info.doctor.key.principal', {}, locale), value: t('terminal.info.doctor.principalValue', {}, locale), ...(data.principal ? { id: data.principal.id } : {}) }] });
    if (data.secretStore) {
      const ready = data.secretStore.status === 'ready';
      const custody = data.secretStore.backend === 'core.secret-store.env@1' ? t('doctor.secretStore.custody.env', {}, locale) : data.secretStore.backend === 'core.secret-store.file@1'
        ? t('doctor.secretStore.custody.file', {}, locale) : data.secretStore.backend === 'core.secret-store.encrypted-file@1' ? t('doctor.secretStore.custody.encryptedFile', {}, locale) : null;
      sections.push({ title: t('terminal.info.doctor.section.secrets', {}, locale), chip: chip(ready ? 'ok' : 'fail'), rows: [
        { key: t('terminal.info.doctor.key.state', {}, locale), value: ready ? t('terminal.info.doctor.secrets.ready', {}, locale) : t('terminal.info.doctor.secrets.unavailable', {}, locale),
          ...(data.secretStore.code ? { chip: { state: 'fail' as const, text: data.secretStore.code } } : {}) },
        { key: t('terminal.info.doctor.key.backend', {}, locale), value: data.secretStore.backend, muted: true }], ...(custody ? { notes: [custody.trim()] } : {}) });
    }
    if (data.serviceConfig) {
      const state: InfoChipState = data.serviceConfig === 'current' ? 'ok' : data.serviceConfig === 'stale' ? 'warn' : 'neutral';
      sections.push({ title: t('terminal.info.doctor.section.service', {}, locale), chip: chip(state), rows: [{ key: t('terminal.info.doctor.key.configuration', {}, locale),
        value: data.serviceConfig === 'current' ? t('terminal.info.doctor.service.current', {}, locale) : data.serviceConfig === 'stale' ? t('terminal.info.doctor.service.stale', {}, locale)
          : data.serviceConfig === 'stopped' ? t('terminal.info.doctor.service.stopped', {}, locale) : t('terminal.info.doctor.service.unknown', {}, locale) }] });
    }
    if (data.imageRefresh && data.imageRefresh.status !== 'unknown') {
      const status = data.imageRefresh.status, params = { reason: data.imageRefresh.reason ?? '-', version: data.imageRefresh.imageVersion ?? '-' };
      sections.push({ title: t('terminal.info.doctor.section.image', {}, locale), chip: chip(status === 'failed' ? 'fail' : status === 'updating' ? 'warn' : 'ok'), rows: [{ key: t('terminal.info.doctor.key.state', {}, locale),
        value: status === 'updating' ? t('doctor.imageRefresh.updating', params, locale) : status === 'failed' ? t('doctor.imageRefresh.failed', params, locale)
          : t('doctor.imageRefresh.current', params, locale) }] });
    }
    if (data.installationBinding) {
      const binding = data.installationBinding, kind = binding.capability === 'source-invalid' ? 'sourceInvalid' : binding.capability === 'unsupported' ? 'unsupported'
        : binding.strength === 'weak' ? 'weak' : 'machine';
      const words = kind === 'sourceInvalid' ? t('terminal.info.doctor.binding.sourceInvalid', {}, locale) : kind === 'unsupported' ? t('terminal.info.doctor.binding.unsupported', {}, locale)
        : kind === 'weak' ? t('terminal.info.doctor.binding.weak', {}, locale) : t('terminal.info.doctor.binding.machine', {}, locale);
      const required = binding.required === true && binding.strength !== 'machine';
      sections.push({ title: t('terminal.info.doctor.section.binding', {}, locale), chip: chip(kind === 'machine' ? 'ok' : kind === 'sourceInvalid' || required ? 'fail' : 'warn'),
        rows: [{ key: t('terminal.info.doctor.key.binding', {}, locale), value: words }], ...(required ? { notes: [t('doctor.installationBinding.required', {}, locale)] } : {}) });
    }
    if (data.poolReadiness) {
      const status = data.poolReadiness.status;
      const words = status === 'ready' ? t('doctor.poolReadiness.status.ready', {}, locale) : status === 'drift' ? t('doctor.poolReadiness.status.drift', {}, locale)
        : status === 'unavailable' ? t('doctor.poolReadiness.status.unavailable', {}, locale) : status === 'unconfigured' ? t('doctor.poolReadiness.status.unconfigured', {}, locale) : status;
      sections.push({ title: t('terminal.info.doctor.section.pools', {}, locale), chip: chip(status === 'ready' ? 'ok' : status === 'drift' ? 'warn' : status === 'unavailable' ? 'fail' : 'neutral'),
        rows: [{ key: t('terminal.info.doctor.key.readiness', {}, locale), value: words,
          ...(data.poolReadiness.code ? { chip: { state: 'neutral' as const, text: data.poolReadiness.code } } : {}) }] });
    }
    if (data.shellRealm) {
      const realm = (view: Readonly<{ selected: string | null; code: string | null }>) => view.selected === null ? t('terminal.info.doctor.sandbox.refused', {}, locale)
        : view.selected === 'host' ? t('terminal.info.doctor.sandbox.host', {}, locale) : view.selected;
      const state = (view: Readonly<{ selected: string | null }>): InfoChipState => view.selected === null ? 'fail' : view.selected === 'host' ? 'warn' : 'ok';
      const prefer = data.shellRealm.preferSandbox;
      sections.push({ title: t('terminal.info.doctor.section.sandbox', {}, locale), chip: chip(state(data.shellRealm)), rows: [
        { key: t('terminal.info.doctor.key.realm', {}, locale), value: realm(data.shellRealm), ...(data.shellRealm.code ? { chip: { state: 'fail' as const, text: data.shellRealm.code } } : {}) },
        ...(prefer ? [{ key: t('terminal.info.doctor.key.mcp', {}, locale), value: realm(prefer), chip: chip(state(prefer)) }] : [])],
      ...(data.shellRealm.notice ? { notes: [data.shellRealm.notice] } : {}) });
    }
    if (data.toolchains?.providers.length) {
      sections.push({ title: t('terminal.info.doctor.section.toolchains', {}, locale), items: data.toolchains.providers.map(entry => ({ text: entry.provider,
        chip: { state: entry.status === 'fresh' || entry.status === 'ahead' ? 'ok' as const : entry.status === 'stale' ? 'warn' as const : 'neutral' as const, text: entry.reason ? `${entry.status} (${entry.reason})` : entry.status } })) });
    }
  }
  const states = sections.map(section => section.chip?.state);
  const totals = { ok: states.filter(state => state === 'ok').length, check: states.filter(state => state === 'warn').length, failed: states.filter(state => state === 'fail').length };
  return { model: { title: t('terminal.info.doctor.title', {}, locale),
    chips: data ? [chip('ok'), chip('warn'), chip('fail')].map((value, index) => ({ ...value, text: `${[totals.ok, totals.check, totals.failed][index]} ${value.text}` })) : [chip('neutral')],
    summary: t('terminal.info.doctor.summary', totals, locale), sections } };
}
