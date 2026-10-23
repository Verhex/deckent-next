import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { ErrorRegistry, EXIT_CODES, emit, ed25519KeyId, t, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import type { SignerKey } from '#domain/index.js';
import { signerAddCommandSchema, skillImportCommandSchema, type SignerListing } from '#engine/index.js';
import { readJsonInput } from '#surfaces/core/cli-kit/index.js';
import { cliTableStyle, renderCliTable, safeCell, scopeNotice, type CliCardRequest, type ScopeResolution } from '#surfaces/core/cli-human/index.js';
import { sinksOf } from '#surfaces/core/cli-approval/index.js';
import type { AgentsCommandContext } from './context.js';
import { revokedPromotionsCard } from './evolution.js';

/** S8-5 `deckent agents` signer actions (S8-DESIGN §8): the list reads; every other action is one person's card at their own terminal. */
export const SIGNER_ACTIONS = ['signers', 'enrol-signer', 'add-signer', 'revoke-signer', 'repair-signers', 'import-skill'] as const;
export type SignerAction = typeof SIGNER_ACTIONS[number];
interface Io { readonly root: string; readonly options: ConfigLoadOptions; readonly locale: Locale; readonly scope: ScopeResolution; readonly inputMaxBytes: number; readonly json: boolean;
  readonly ask: (request: CliCardRequest) => Promise<string | null> }
const need = <T>(value: T | undefined): T => { if (!value) throw ErrorRegistry.createError('AGENT_CATALOG_UNAVAILABLE'); return value; };
const principalOf = (ref: { issuer: string; subject: string } | null) => ref ? safeCell(`${ref.issuer}:${ref.subject}`) : '-';
const short = (keyId: string) => keyId.slice(0, 12);
const purposeLabel = (purpose: SignerKey['purpose'], locale: Locale) => purpose === 'action' ? t('agentsign.purpose.action', {}, locale)
  : purpose === 'import' ? t('agentsign.purpose.import', {}, locale) : purpose === 'publish' ? t('agentsign.purpose.publish', {}, locale) : t('agentsign.purpose.hub', {}, locale);
const custodyLabel = (custody: SignerKey['custody'], locale: Locale) => custody === 'host' ? t('agentsign.custody.host', {}, locale) : t('agentsign.custody.external', {}, locale);
const stateLabel = (state: SignerKey['state'], locale: Locale) => state === 'active' ? t('agentsign.state.active', {}, locale) : t('agentsign.state.revoked', {}, locale);
/** The signer table (public facts only): key id, purpose, principal, custody, state, label and the catalog rows the key signed. */
export function signerTable(items: SignerListing['items'], locale: Locale, context: AgentsCommandContext): string {
  return renderCliTable([{ header: t('agentsign.column.key', {}, locale) }, { header: t('agentsign.column.purpose', {}, locale) }, { header: t('agentsign.column.principal', {}, locale) },
    { header: t('agentsign.column.custody', {}, locale), shrink: true }, { header: t('agentsign.column.state', {}, locale) }, { header: t('agentsign.column.label', {}, locale), shrink: true },
    { header: t('agentsign.column.signed', {}, locale) }],
  items.map(row => [short(row.keyId), purposeLabel(row.purpose, locale), principalOf(row.boundPrincipal), custodyLabel(row.custody, locale), stateLabel(row.state, locale),
    row.label, row.signedRows]), cliTableStyle(context));
}
const fields = (row: SignerKey, locale: Locale) => ({ keyId: row.keyId, label: safeCell(row.label), purpose: purposeLabel(row.purpose, locale), principal: principalOf(row.boundPrincipal) });

export async function signersCommand(action: SignerAction, args: { readonly id?: string | undefined; readonly input?: string | undefined; readonly principal?: string | undefined;
  readonly label?: string | undefined }, context: AgentsCommandContext, io: Io): Promise<void | ExitCode> {
  const { locale, scope } = io, sinks = sinksOf(context), scopeId = scope.scopeId, commandId = randomUUID(), base = { schemaVersion: 1 as const, scopeId, commandId };
  const listing = () => need(context.listSigners)(io.root, { schemaVersion: 1, scopeId }, io.options);
  if (action === 'signers') {
    const result = await listing();
    if (io.json) { emit(result, { ...sinks, json: true }); return; }
    emit([scopeNotice(scope, locale), ...(result.log === 'broken' ? [t('agentsign.log.broken', {}, locale)] : []),
      result.items.length ? signerTable(result.items, locale, context) : t('agentsign.none', {}, locale)].join('\n'), sinks);
    return;
  }
  emit(scopeNotice(scope, locale), sinks);
  const card = async (title: string, body: string[]) => await io.ask({ title, body,
    options: [{ id: 'apply', label: t('agents.card.apply', {}, locale), key: 'y' }, { id: 'cancel', label: t('agents.card.cancel', {}, locale), key: 'n' }] }) === 'apply';
  const cancelled = () => { emit(t('agents.cancelled', {}, locale), { level: 'warning', ...sinks }); return EXIT_CODES.error; };
  const input = async () => readJsonInput(resolvePath(io.root, args.input!), io.inputMaxBytes,
    { limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, context.stdin);
  if (action === 'enrol-signer') {
    const at = args.principal!.indexOf(':'), principal = { issuer: args.principal!.slice(0, at), subject: args.principal!.slice(at + 1) };
    if (at < 1 || !principal.subject) throw ErrorRegistry.createError('CLI_USAGE');
    if (!await card(t('agentsign.card.enrol.title', {}, locale), t('agentsign.card.enrol.body', { principal: principalOf(principal), label: safeCell(args.label!) }, locale).split('\n'))) return cancelled();
    const done = await need(context.enrolSigner)(io.root, { ...base, principal, label: args.label! }, io.options);
    emit(t('agentsign.done.enrol', { keyId: done.item.keyId, principal: principalOf(principal) }, locale), sinks); return;
  }
  if (action === 'add-signer') {
    const raw = await input(), command = signerAddCommandSchema.safeParse({ ...base, principal: null, ...(raw && typeof raw === 'object' ? raw : {}) });
    if (!command.success || !raw || typeof raw !== 'object' || 'scopeId' in raw || 'commandId' in raw) throw ErrorRegistry.createError('SKILL_SIGNER_INVALID');
    let keyId: string;
    try { keyId = ed25519KeyId(Buffer.from(command.data.publicKey, 'base64')); } catch { throw ErrorRegistry.createError('SKILL_SIGNER_INVALID'); }
    if (!await card(t('agentsign.card.add.title', {}, locale), t('agentsign.card.add.body', { keyId, purpose: purposeLabel(command.data.purpose, locale), principal: principalOf(command.data.principal),
      label: safeCell(command.data.label) }, locale).split('\n'))) return cancelled();
    emit(t('agentsign.done.add', { keyId: (await need(context.addSigner)(io.root, command.data, io.options)).item.keyId }, locale), sinks); return;
  }
  if (action === 'revoke-signer') {
    // A full key id, or a unique prefix of at least the shown 12 characters.
    const wanted = args.id!.toLowerCase(), rows = (await listing()).items.filter(row => wanted.length >= 12 && row.keyId.startsWith(wanted));
    if (rows.length !== 1) throw ErrorRegistry.createError('AGENT_CATALOG_NOT_FOUND');
    const row = rows[0]!;
    if (!await card(t('agentsign.card.revoke.title', {}, locale), t('agentsign.card.revoke.body', { ...fields(row, locale), count: row.signedRows }, locale).split('\n'))) return cancelled();
    const done = await need(context.revokeSigner)(io.root, { ...base, keyId: row.keyId }, io.options);
    const params = { keyId: row.keyId, count: done.signedRows ?? row.signedRows };
    if (done.logged === false) emit(t('agentsign.done.revokeUnlogged', params, locale), { level: 'warning', ...sinks }); else emit(t('agentsign.done.revoke', params, locale), sinks);
    // S8-4 (owner Q-S13): the promotions this key signed stay in effect until a person demotes them — offered here in one step.
    return revokedPromotionsCard(row.keyId, context, io);
  }
  if (action === 'repair-signers') {
    if (!await card(t('agentsign.card.repair.title', {}, locale), t('agentsign.card.repair.body', {}, locale).split('\n'))) return cancelled();
    const done = await need(context.repairSigners)(io.root, base, io.options);
    emit(t('agentsign.done.repair', { entries: done.entries, revoked: done.revoked }, locale), sinks); return;
  }
  // import-skill: the bundle's text, source, pin and signature; the application checks floor (d) and the store verifies the signature at commit.
  const raw = await input() as Record<string, unknown> | null, bundle = raw && typeof raw === 'object' ? raw : {};
  const skillId = typeof bundle['skillId'] === 'string' ? bundle['skillId'] : '';
  const current = skillId ? await need(context.inspectSkill)(io.root, { schemaVersion: 1, scopeId, skillId }, io.options) : null;
  const command = skillImportCommandSchema.safeParse({ ...base, skillId, expectedRevision: current?.status === 'ok' ? current.item.revision : null,
    content: { name: bundle['name'], text: bundle['text'] }, source: bundle['source'], pin: bundle['pin'] ?? null, signature: bundle['signature'] ?? null });
  if (!command.success || Object.keys(bundle).some(key => !['skillId', 'name', 'text', 'source', 'pin', 'signature'].includes(key))) throw ErrorRegistry.createError('SKILL_DEFINITION_INVALID');
  const c = command.data;
  if (!await card(t('agentsign.card.import.title', {}, locale), [`${safeCell(c.skillId)} · ${safeCell(c.content.name)}`, safeCell(c.content.text), '', ...t('agentsign.card.import.body', { source: safeCell(c.source.ref),
    pin: c.pin ?? '-', keyId: safeCell(c.signature?.keyId ?? '-') }, locale).split('\n')])) return cancelled();
  const done = await need(context.importSkill)(io.root, c, io.options);
  emit(t('agentsign.done.import', { id: done.item.skillId, revision: done.item.revision }, locale), sinks);
}
