import { AUDIT_POLICY_TURN_LIMITS, type AuditEvent, type CliReportedRefusalBasis, type LocalRefusalBasis } from '#domain/index.js';
import { TURN_NOTE_MAX_CHARS, type AuditApplication } from '#engine/index.js';
import { sha256, t, type IntegrityAuthority, type Locale, type TrustedClock } from '#platform/index.js';
import type { ChatTurnResult } from '#domain/index.js';

type Summary = Extract<AuditEvent['subject'], { kind: 'access-refusal-summary' }>;
type Attempt = Pick<Summary, 'runId' | 'taskId' | 'attemptId' | 'generation'>;
export type RefusalAuditLoss = 'refusal-audit-loss';
/** `source`: who refused (default deckent-decision); only the write gate's exact pairs are stored. */
export type LocalRefusal = { readonly basis: LocalRefusalBasis | CliReportedRefusalBasis; readonly source?: 'deckent-decision' | 'cli-reported'; readonly reason: string; readonly role: string;
  readonly operationClass?: Summary['operationClass']; readonly operation?: Summary['operation']; readonly commandId?: string;
  readonly identity?: object; readonly keyed?: (authority: IntegrityAuthority) => Pick<Summary, 'invocationId' | 'target'> };
type Decision = LocalRefusal & { readonly policyRevision: string; readonly call?: Summary['call']; readonly tool?: Summary['tool'] };
type Group = { readonly decision: Decision; readonly first: number; last: number; count: number; overflow: boolean; readonly samples: NonNullable<Summary['call']>[] };
type Write = (write: (audit: AuditApplication, authority: IntegrityAuthority) => void) => Promise<void>;

/** The turn owns this writer until finalization. Nothing in the observation escapes through the tool result. */
export function createRefusalAudit(input: { readonly scopeId: string; readonly turnId: string; readonly principal: AuditEvent['principal'];
  readonly installationId: string | null; readonly companyId: string; readonly attempt?: Attempt; readonly clock: TrustedClock; readonly write: Write }) {
  const groups = new Map<string, Group>(), seen = new WeakSet<object>(), bound = AUDIT_POLICY_TURN_LIMITS.refusedMax;
  let lost = false, flushed: Promise<RefusalAuditLoss | null> | undefined;
  return {
    observe(decision: Decision) {
      if (flushed || decision.identity && seen.has(decision.identity)) return;
      if (decision.identity) seen.add(decision.identity);
      try {
        const key = JSON.stringify([decision.basis, decision.reason, decision.role, decision.policyRevision, decision.operationClass,
          decision.tool, decision.operation, decision.commandId, ...(decision.source === 'cli-reported' ? [decision.source] : [])]); // a local key keeps its bytes
        const at = input.clock.sample().wallMs;
        let group = decision.keyed ? undefined : groups.get(key);
        if (!group) {
          if (groups.size >= bound) { lost = true; return; }
          group = { decision, first: at, last: at, count: 0, overflow: false, samples: [] };
          groups.set(decision.keyed ? JSON.stringify([key, groups.size]) : key, group);
        }
        group.count++;
        group.last = Math.max(group.last, at);
        if (decision.call) {
          if (group.samples.length < bound) group.samples.push(decision.call);
          else group.overflow = true;
        }
      } catch { lost = true; }
    },
    flush() {
      return flushed ??= (async (): Promise<RefusalAuditLoss | null> => {
        if (groups.size > 0) try {
          await input.write((audit, authority) => {
            for (const [key, group] of groups) try {
              const { decision, first, last, count, samples } = group;
              const { scopeId, turnId, principal, installationId, companyId } = input;
              const keyed = decision.keyed?.(authority);
              audit.record({ schemaVersion: 1, eventId: sha256(JSON.stringify(['access-refusal-summary:1', installationId, companyId, scopeId, principal, turnId, key])),
                scopeId, principal, policyRevision: decision.policyRevision, atMs: last,
                subject: { kind: 'access-refusal-summary', schemaVersion: 1, operationClass: decision.operationClass ?? 'invoke',
                  decisionSource: decision.source ?? 'deckent-decision', reasonCode: decision.reason, evidenceBasis: decision.basis,
                  ...(decision.tool ? { tool: decision.tool } : {}), ...(decision.operation ? { operation: decision.operation } : {}),
                  ...(decision.commandId ? { commandId: decision.commandId } : {}), target: { role: decision.role, identity: null }, ...keyed,
                  turnId, ...input.attempt, ...(count === 1 && decision.call ? { call: decision.call } : {}),
                  firstObservedAtMs: first, lastObservedAtMs: last, count, countBasis: 'exact', samples, overflow: group.overflow } } satisfies AuditEvent);
            } catch { lost = true; }
          });
        } catch { lost = true; }
        return lost ? 'refusal-audit-loss' : null;
      })();
    },
  };
}

/** Fit the ordinary result first. Its answer and complete note take precedence. */
export function withRefusalAuditLoss(result: ChatTurnResult, closingNote: string | null, policyFailed: boolean, locale: Locale, maxBytes: number): ChatTurnResult {
  if (!result.note) return result;
  const sentence = policyFailed ? t('agent.refusalAudit.bothFailed', {}, locale) : t('agent.refusalAudit.failed', {}, locale);
  const note = (policyFailed ? [sentence, closingNote] : [result.note, sentence]).filter(Boolean).join(' ');
  const candidate = { ...result, note };
  return note.length <= TURN_NOTE_MAX_CHARS && Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxBytes ? Object.freeze(candidate) : result;
}
