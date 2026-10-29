import { askCliCard } from '#surfaces/core/cli-human/index.js';
import type { WorklinePermissionModePort } from '#surfaces/core/terminal/index.js';
import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { TerminalLaunchContext } from './context.js';

/** One question for startup and the mounted workline; the host owns witness, preview, revision and publication. */
export function permissionModeOpener(root: string, scopeId: string, options: ConfigLoadOptions, locale: Locale,
  context: TerminalLaunchContext, ttlMs: number): WorklinePermissionModePort['open'] {
  const open = context.openOwnPermissionMode;
  if (!open) return undefined;
  return async (mode, presenter) => {
    const signal = AbortSignal.any([AbortSignal.timeout(ttlMs), ...(context.signal ? [context.signal] : [])]);
    return open(root, { scopeId, mode, signal, confirm: async preview => {
      const question = { title: t('terminal.mode.open.title', { mode: mode === 'full-access' ? t('terminal.mode.stop.full-access', {}, locale) : t('terminal.mode.stop.full-auto', {}, locale) }, locale), prompt: t('terminal.mode.open.keys', {}, locale), lines: [
        { label: t('terminal.mode.open.who', {}, locale), text: `${preview.principal.issuer}/${preview.principal.subject} · ${preview.scopeId}` },
        { label: t('terminal.mode.open.change', {}, locale), text: mode === 'full-access' ? t('terminal.mode.open.body', {}, locale) : t('terminal.mode.open.fullAuto', {}, locale) },
        ...(mode === 'full-access' ? [{ label: t('terminal.mode.open.sandbox', {}, locale), text: t('terminal.mode.open.noSandbox', {}, locale) }] : []),
      ] };
      if (presenter) return presenter(question, signal);
      return (await askCliCard({ title: question.title, body: question.lines.map(line => `${line.label}: ${line.text}`), initial: 'no', options: [
        { id: 'yes', label: t('terminal.mode.open.yes', {}, locale), role: 'yes' }, { id: 'no', label: t('terminal.mode.open.no', {}, locale), role: 'no' },
      ] }, { locale, signal, env: options.env ?? process.env, ...(context.stdin ? { stdin: context.stdin } : {}),
        ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}) })) === 'yes';
    } }, options);
  };
}
