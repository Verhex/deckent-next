import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, FIRST_RUN_POLICY_TEMPLATE_ID, FIRST_RUN_POLICY_TEMPLATE_VERSION, firstRunProposalRules, proposalCoverageGrants, policyFileSchema, policyGrantSchema, type AuditEvent, type PolicyGrant } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { governedPolicyDigest, type AuthorityRevision } from '#engine/core/policy/index.js';
import { installerAuthorityChangeEvent, type PolicyTemplateDocumentWriter } from '#engine/core/installation/index.js';

const revisionOf = (value: unknown) => typeof (value as { revision?: unknown } | null)?.revision === 'string' ? (value as { revision: string }).revision : null;
const V20_IDS: readonly string[] = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS;
/**
 * Owner S6 (2026-11-09, "update grants automatically"; a widening the owner chose over the person's card): at a service start an installed first-run
 * policy of this person gets exactly the v20 AI-actor rules (the three proposal tools; Run and registry-setting proposals, both `require-approval`)
 * with no card and no terminal witness. Once only: when the archive shows any v20 rule ever held (added here, by an upgrade, or since revoked through
 * `/policy` or `policy upgrade --rollback`), nothing is added again. Written like `init policy --upgrade`: the archived conditional writer on the
 * revision read, under the installer key `--rollback` recognizes, after the `authority-change` audit record (the archive keeps the rules themselves).
 * A policy that names this person on no allow rule of the anchor scope, or holds a same-id rule with other content, is left as it is (its person upgrades on the card).
 * A v20 rule whose whole cell an allow of the AI actor already covers (role bindings included) is not added (never a downgrade to a card); the record names it and the holding rule.
 */
export async function upgradeFirstRunProposalRules(writer: PolicyTemplateDocumentWriter, input: { readonly person: { readonly issuer: string; readonly subject: string };
  /** The installation's configured service scope: a hand-built policy naming the person there is upgraded too (owner S6: every existing install). */ readonly scopeId?: string | undefined;
  readonly history: readonly AuthorityRevision[]; readonly openAudit: () => Promise<{ record(event: AuditEvent): void; close(): void }>; readonly now: () => number }): Promise<'upgraded' | 'current' | 'skipped'> {
  const ever = input.history.some(entry => [entry.before, entry.after].some(policy => policy.schemaVersion === 2 && policy.grants.some(rule => V20_IDS.includes(rule.id))));
  const person = input.person, mine = (rule: PolicyGrant) => rule.effect === 'allow' && rule.principals !== 'all' && rule.scopes !== 'all'
    && rule.principals.some(item => item.issuer === person.issuer && item.subject === person.subject);
  const planned = (current: unknown, bindings: unknown) => {
    // Anchor: the configured service scope where an allow rule names this person (hand-built live shapes too), else a first-run read rule's one scope.
    const parsed = policyFileSchema.safeParse(current), grants = parsed.success && parsed.data.schemaVersion === 2 ? parsed.data.grants : null, revision = revisionOf(current);
    const read = grants?.find(rule => rule.id === 'first-run-read-tools' && mine(rule) && (rule.scopes as readonly string[]).length === 1);
    const scopeId = input.scopeId && grants?.some(rule => mine(rule) && (rule.scopes as readonly string[]).includes(input.scopeId!)) ? input.scopeId : read ? (read.scopes as readonly string[])[0]! : null;
    if (!grants || !scopeId) return { status: 'skipped' as const, revision };
    // Side effects A, B (lead 2026-11-09): a v20 cell one allow of the AI actor already covers whole (an MCP `work` group, a hand-built or role-bound rule:
    // its effective grants) is left to it, named in the record.
    const { wanted, skipped } = firstRunProposalRules(proposalCoverageGrants(current, bindings, person), person, [scopeId]);
    const kept = (id: string) => grants.find(rule => rule.id === id), rules = wanted.filter(rule => !kept(rule.id));
    if (!wanted.length && !skipped.length) return { status: 'skipped' as const, revision };
    if (ever || wanted.some(rule => kept(rule.id) && JSON.stringify(policyGrantSchema.parse(kept(rule.id))) !== JSON.stringify(policyGrantSchema.parse(rule))) || !rules.length) return { status: 'current' as const, revision };
    const body = { ...(current as Record<string, unknown>), grants: [...(current as { grants: readonly unknown[] }).grants, ...rules] };
    const next = { ...body, revision: `a-${sha256(`policy-template-upgrade:1\0${revision ?? ''}\0${JSON.stringify({ ...body, revision: undefined })}`).slice(0, 40)}` };
    return { status: 'plan' as const, revision, scopeId, rules, skipped, next, basis: read && read.scopes.includes(scopeId) ? 'first-run' as const : 'named-person' as const, key: `policy-template-upgrade-v${FIRST_RUN_POLICY_TEMPLATE_VERSION}-${sha256(`${revision ?? ''}\0${JSON.stringify(next)}`)}` };
  };
  const first = await writer.updateAuthority(snapshot => ({ write: null, result: planned(snapshot.policy, snapshot.bindings) }));
  if (first.status !== 'plan') return first.status;
  const audit = await input.openAudit();
  try {
    return await writer.updateAuthority(snapshot => {
      const again = planned(snapshot.policy, snapshot.bindings);
      if (again.status !== 'plan' || again.key !== first.key) return { write: null, result: 'current' as const };
      const beforePublish = () => { audit.record(installerAuthorityChangeEvent({ scopeId: again.scopeId, caller: input.person, person: input.person, basis: again.basis,
        template: { id: FIRST_RUN_POLICY_TEMPLATE_ID, version: FIRST_RUN_POLICY_TEMPLATE_VERSION }, commandId: again.key, inputDigest: sha256(JSON.stringify(again.next)), before: again.revision!,
        after: again.next.revision, grantsAdded: again.rules.length, ...(again.skipped.length ? { skipped: again.skipped } : {}), atMs: input.now(), policyDigestBefore: governedPolicyDigest(snapshot.policy, snapshot.bindings),
        policyDigest: governedPolicyDigest(again.next, snapshot.bindings) })); };
      return { write: { policy: again.next, bindings: null, order: 'policy-first' as const, beforePublish }, result: 'upgraded' as const };
    }, first.key);
  } finally { audit.close(); }
}
