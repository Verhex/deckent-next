import { ApprovalError, type ApprovalRecord, type VerifiedPrincipal } from '#domain/index.js';
import type { TrustedClock } from '#platform/index.js';
import { ApprovalApplication, approvalCommandFingerprint, type ApprovalCommand } from './application.js';
import { approvalRequestDigest } from './integrity.js';
import { SessionStanding } from './standing.js';
import type { SessionApprovalResult, SessionStandingResult } from './session-contract.js';

type Refusal = Extract<SessionStandingResult, { status: 'not-saved' }>['reason'];
type Offer = { readonly record: ApprovalRecord; readonly principal: VerifiedPrincipal; readonly peerPid: number; readonly session: string; readonly key: string;
  readonly signal: AbortSignal; readonly clock: TrustedClock; readonly started: { readonly wallMs: number; readonly monotonicMs: number };
  readonly remember: (valid: () => boolean, refused: (reason: Refusal) => void) => Promise<boolean> };
type Card = { readonly offer: Offer; valid(): boolean; reason(): Refusal; invalidate(): void; close(): void;
  readonly ended: Promise<void>; claim?: { readonly fingerprint: string; readonly result: Promise<SessionApprovalResult> }; closed: boolean };
const address = (scope: string, approval: string) => `${scope}\0${approval}`;
const unknown = (): SessionStandingResult => ({ scope: 'session', status: 'unconfirmed', reason: 'result-unavailable' });
const refused = (reason: Refusal): SessionStandingResult => ({ scope: 'session', status: 'not-saved', reason });

/** Service-process owner of active offers and answer barriers; only producer-held closures can remember. No durable answer cache. */
export class SessionApprovalAnswers {
  readonly memory = new SessionStanding();
  private readonly cards = new Map<string, Card>();
  private stopped = false;
  constructor(signal?: AbortSignal) {
    if (signal?.aborted) this.stop();
    else signal?.addEventListener('abort', () => this.stop(), { once: true });
  }
  register(offer: Offer): { wait(): Promise<void>; close(): void } | null {
    const id = address(offer.record.request.scopeId, offer.record.request.approvalId);
    if (this.stopped || this.cards.has(id)) return null;
    const binding = this.memory.bind(offer.session);
    if (!binding) return null;
    let end!: () => void;
    const ended = new Promise<void>(resolve => { end = resolve; });
    const reason = (): Refusal => {
      if (offer.signal.aborted) return 'cancelled';
      const now = offer.clock.sample();
      if (now.wallMs >= offer.record.request.expiresAt || now.monotonicMs - offer.started.monotonicMs >= offer.record.request.expiresAt - offer.started.wallMs) return 'expired';
      return 'revoked';
    };
    const valid = () => !card.closed && binding.valid() && !offer.signal.aborted && reason() !== 'expired';
    const invalidate = () => { binding.close(); end(); };
    // The original producer budget bounds the barrier; every validity check also samples both clocks.
    const sampled = offer.clock.sample(), ttl = offer.record.request.expiresAt - offer.started.wallMs;
    const timer = setTimeout(invalidate, Math.max(0, Math.min(offer.record.request.expiresAt - sampled.wallMs, ttl - (sampled.monotonicMs - offer.started.monotonicMs))));
    timer.unref();
    const card: Card = { offer, valid, reason, ended, invalidate, closed: false, close: () => {
      if (card.closed) return;
      card.closed = true; clearTimeout(timer); offer.signal.removeEventListener('abort', invalidate); invalidate();
      if (this.cards.get(id) === card) this.cards.delete(id);
    } };
    offer.signal.addEventListener('abort', invalidate, { once: true });
    this.cards.set(id, card);
    if (!valid()) { card.close(); return null; }
    return { wait: async () => { if (card.claim) await Promise.race([card.claim.result.then(() => undefined, () => undefined), ended]); }, close: card.close };
  }
  clear(session: string) { for (const card of this.cards.values()) if (card.offer.session === session) card.invalidate(); this.memory.forget(session); }
  stop() { this.stopped = true; for (const card of this.cards.values()) card.close(); this.memory.clear(); }
  async answer(command: ApprovalCommand, principal: VerifiedPrincipal, peerPid: number | null, app: ApprovalApplication): Promise<SessionApprovalResult> {
    const card = this.cards.get(address(command.scopeId, command.approvalId));
    const fingerprint = approvalCommandFingerprint('approval-command:1', command, principal);
    // With no custody, only the application's exact historical replay can succeed; fresh session commands require the guard.
    if (!card) return { record: (await app.decideWithSettlement(command)).record, standing: unknown() };
    const sameActor = principal.issuer === card.offer.principal.issuer && principal.subject === card.offer.principal.subject;
    if (!sameActor || peerPid !== card.offer.peerPid) throw new ApprovalError('APPROVAL_DENIED');
    if (card.claim) {
      if (card.claim.fingerprint !== fingerprint) throw new ApprovalError('APPROVAL_CONFLICT');
      return this.sample(card, await card.claim.result);
    }
    // Install before any application await; exact duplicates share the whole decision + audit barrier.
    const result = Promise.resolve().then(async (): Promise<SessionApprovalResult> => {
      const settled = await app.decideWithSettlement(command, undefined, (record, actor) => {
        if (!card.valid() || actor.issuer !== card.offer.principal.issuer || actor.subject !== card.offer.principal.subject
          || record.revision !== card.offer.record.revision || approvalRequestDigest(record.request) !== approvalRequestDigest(card.offer.record.request)) throw new ApprovalError('APPROVAL_INVALID');
      });
      if (settled.commit === 'replay') return { record: settled.record, standing: unknown() };
      let failure: Refusal = 'policy-changed';
      const saved = await Promise.race([card.offer.remember(card.valid, reason => { failure = reason; }), card.ended.then(() => false)]);
      return { record: settled.record, standing: saved ? { scope: 'session', status: 'saved' } : refused(card.valid() ? failure : card.reason()) };
    });
    card.claim = { fingerprint, result };
    try { return this.sample(card, await result); }
    catch (error) { if (card.claim?.result === result) delete card.claim; throw error; }
  }
  private sample(card: Card, result: SessionApprovalResult): SessionApprovalResult {
    if (card.closed) return { record: result.record, standing: unknown() };
    if (result.standing.status !== 'saved') return result;
    return { record: result.record, standing: !card.valid() ? refused(card.reason()) : this.memory.has(card.offer.session, card.offer.key)
      ? result.standing : refused('evicted') };
  }
}
