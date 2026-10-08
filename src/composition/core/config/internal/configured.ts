import { composeCore } from '#composition/core/root/index.js';
import { ConfigApplication, ConfigChangeApprovalBroker, evaluateConfigWrite, type ConfigApprovalPort, type ConfigChangeSubject, type ConfigDocumentPort,
  type ConfigSnapshot } from '#engine/index.js';
import type { ModelReference, VerifiedPrincipal } from '#domain/index.js';
import { createConfigFileDocuments, createConfigFileAuthority, openLocalIntegrityAuthority, openSqliteApprovalStore, resolveTerminalModel, type TerminalModelChoice } from '#adapters/index.js';
import { resolveLocale, SystemTrustedClock, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
export async function resolveConfiguredConfigPrincipal(projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}): Promise<VerifiedPrincipal> {
  return (await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write')).principal;
}
/** `guard` runs on the snapshot taken under the layer's write lock, immediately before the change is planned: it may refuse the write (throw) when
 * something outside the written layer changed what the write was derived from. */
/** Layer documents and the layer digest from one read per file (the value and its digest always come from the same bytes). */
export function snapshotConfiguredConfig(projectRoot: string, options: ConfigLoadOptions = {}, layer: 'project' | 'global' = 'project') {
  composeCore(); return createConfigFileDocuments(projectRoot, options).snapshot(layer);
}
export function createConfiguredConfigApplication(projectRoot: string, options: ConfigLoadOptions = {}, guard?: (snapshot: ConfigSnapshot) => void) {
  composeCore();
  const documents = createConfigFileDocuments(projectRoot, options);
  const guarded: ConfigDocumentPort = guard ? { snapshot: layer => documents.snapshot(layer), publish: (input, planner) => documents.publish(input, async snapshot => { guard(snapshot); return planner(snapshot); }) } : documents;
  const load = (scopeId: string) => loadConfiguredScopeContext(projectRoot, scopeId, { ...options, force: true, heal: false }, 'write');
  return new ConfigApplication(guarded, { ...createConfigFileAuthority(load), approvals: configuredConfigApprovals(load, options) });
}

/** A card's value: a plain JSON string reads without its quotes ("dark", not "\"dark\""); anything else stays the bounded JSON text. */
const cardValue = (text: string) => /^"(?:[^"\\]|\\.)*"$/.test(text) ? JSON.parse(text) as string : text;
/** The card's sentence in the requester's language: "Setting will change: terminal.theme auto → dark (project)". */
function configChangeSummary(subject: ConfigChangeSubject, locale: Locale) {
  const values = { key: subject.keyPath, before: cardValue(subject.before), after: subject.after === null ? '' : cardValue(subject.after),
    layer: subject.layer === 'global' ? t('config.surface.source.global', {}, locale) : t('config.surface.source.project', {}, locale) };
  return subject.action === 'set' ? t('config.approval.summary.set', values, locale) : t('config.approval.summary.unset', values, locale);
}
/**
 * T3 L2 CONFIG-APPROVAL: the approval port of the configured write path — the principal's current policy decides (`evaluateConfigWrite`), the
 * ledger's approval store holds the `config-change` request (the same store, seal and decision path as every approval: the terminal window and
 * `/approvals` decide it), and the request's TTL bounds both the pending request and the admission of a stored allow.
 */
function configuredConfigApprovals(load: (scopeId: string) => ReturnType<typeof loadConfiguredScopeContext>, options: ConfigLoadOptions): ConfigApprovalPort {
  return {
    async evaluate(input) { const context = await load(input.scopeId); return evaluateConfigWrite(context.document, context.principal, input); },
    // T3 L4 `/config` locks: one scope-context read for every key of the panel; a denied write is a returned `deny` here (display only).
    async evaluateMany(inputs) {
      if (!inputs.length) return [];
      if (inputs.some(input => input.scopeId !== inputs[0]!.scopeId)) throw new TypeError();
      const context = await load(inputs[0]!.scopeId);
      return inputs.map(input => {
        try { const decided = evaluateConfigWrite(context.document, context.principal, input); return { decision: decided.decision, ruleId: decided.ruleId }; }
        catch (error) { if ((error as { code?: unknown })?.code === 'POLICY_DENIED') return { decision: 'deny' as const, ruleId: null }; throw error; }
      });
    },
    async admit(input, subject, authorization) {
      const context = await load(input.scopeId), { config, layout, principal } = context;
      // A producer of approvals (like Run reservation and the agent turn): the integrity key is created on first use.
      const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
      const journal = openSqliteApprovalStore(await context.path(), config.storage.sqlite);
      try {
        const locale = resolveLocale(undefined, options.env ?? process.env, config.language);
        return new ConfigChangeApprovalBroker(journal.store, integrity, new SystemTrustedClock(), { requestTtlMs: config.approvals.requestTtlMs, admitWithinMs: config.approvals.requestTtlMs })
          .admit({ scopeId: input.scopeId, requester: { id: principal.id, issuer: principal.issuer, subject: principal.subject }, subject, policy: context.document,
            policyRevision: authorization.revision, summary: configChangeSummary(subject, locale) });
      } finally { journal.close(); }
    },
  };
}

/** T4-B D1: the terminal's model by the one precedence (`resolveTerminalModel`), read from the two authored layer documents, never the merged config. */
export async function configuredTerminalModel(projectRoot: string, options: ConfigLoadOptions = {}, pin?: ModelReference | null): Promise<TerminalModelChoice | null> {
  if (pin) return resolveTerminalModel({ global: {}, project: {} }, pin);
  const snapshot = await snapshotConfiguredConfig(projectRoot, options);
  return resolveTerminalModel({ global: snapshot.global, project: snapshot.project });
}
