import { randomUUID } from 'node:crypto';
import { projectAttachmentOfferSchema } from '#domain/index.js';
import { t, terminalSafeText, type Locale } from '#platform/index.js';
import { askCliCard } from '#surfaces/core/cli-human/index.js';
import type { CommandContext } from './kernel-commands.js';

/** The existing question card owns input until the typed attach settles; no credential or policy writer lives here. */
export async function offerAttachedSession(context: CommandContext, locale: Locale, launch: (context: CommandContext) => Promise<void>): Promise<boolean> {
  if (!context.projectAttachment) return false;
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, stdin = context.stdin ?? process.stdin;
  const options = { env, heal: false }, scopeId = randomUUID();
  const offer = projectAttachmentOfferSchema.parse(await context.projectAttachment(root, { action: 'offer', scopeId }, options));
  if (offer.kind === 'none') return false;
  const connections = offer.preparation.connections.map(row => `${row.reference.providerId} / ${row.reference.modelId}`).join(', ');
  const billing = { subscription: t('billing.subscription', {}, locale), metered: t('billing.metered', {}, locale), local: t('billing.local', {}, locale) };
  const costs = [...new Set(offer.preparation.connections.map(row => billing[row.billing]))].join(', ');
  const answer = await askCliCard({ title: t('setup.session.title', {}, locale), body: [
    t('setup.session.body', { path: terminalSafeText(offer.path), scope: terminalSafeText(offer.scopeId),
      connections: terminalSafeText(connections || t('setup.session.noConnection', {}, locale)), costs: terminalSafeText(costs || t('setup.session.noConnection', {}, locale)),
      writeRoot: terminalSafeText(offer.writeRoot) }, locale)],
    options: [{ id: 'yes', label: t('setup.window.yes', {}, locale), role: 'yes' }, { id: 'no', label: t('setup.window.no', {}, locale), role: 'no' }], initial: 'no' },
  { locale, env, stdin, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}),
    ...(context.signal ? { signal: context.signal } : {}) });
  stdin.pause();
  if (answer !== 'yes') return true;
  await context.projectAttachment(root, { action: 'apply', scopeId: offer.scopeId, expect: offer.planDigest, commandId: randomUUID() }, options);
  stdin.resume();
  await launch({ ...context, root: offer.path, rootResolution: { root: offer.path, folder: '', found: true, gitTop: context.rootResolution?.gitTop ?? null } });
  return true;
}
