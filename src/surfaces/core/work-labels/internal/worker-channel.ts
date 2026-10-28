import { t, type Locale } from '#platform/index.js';

const word = (ok: boolean | null, locale: Locale) => ok === null ? t('tui.provider.worker.unknown', {}, locale) : ok ? t('tui.provider.worker.yes', {}, locale) : t('tui.provider.worker.no', {}, locale);
/**
 * BeUser D-05b: a CLI worker channel (codex, cursor) never answers chat here, so "invocable now" is the wrong readiness for it. It is ready for
 * /do when its catalog channel is on, this machine's CLI is signed in and the worker image carries it; each is shown as observed (or "not checked").
 * `families` is the setup observation's family facts (coding hosts, execution worker), read only.
 */
export function workerChannelText(cli: string, active: boolean, families: Readonly<Record<string, unknown>> | null, locale: Locale): string {
  const host = (families?.['coding'] as { hosts?: readonly { id: string; login: string }[] } | undefined)?.hosts?.find(row => row.id === cli);
  const worker = (families?.['execution'] as { worker?: { image?: string; acquisition?: { images: readonly { provider: string }[] } | null } } | undefined)?.worker;
  return t('tui.provider.worker.ready', { cli, active: word(active, locale), login: word(host ? host.login === 'found' : null, locale),
    image: word(worker ? Boolean(worker.acquisition?.images.some(image => image.provider === cli)) || worker.image === 'present' : null, locale) }, locale);
}
