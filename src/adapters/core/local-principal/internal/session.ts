import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { verifiedPrincipalSchema, verifiedSessionSchema, type VerifiedSession } from '#domain/index.js';
import { SessionAuthenticationError, type SessionAuthority, type SessionVerifier } from '#engine/index.js';
import type { TrustedClock, ClockSample } from '#platform/index.js';
import { readLocalOsIdentity } from './local.js';

interface ProcessEvidence { readonly start: string; readonly tty: string; readonly session: string }
async function processEvidence(pid: number, uid: number): Promise<ProcessEvidence> {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 1) throw new Error('unsupported');
  const base = `/proc/${pid}`;
  const [status, info] = await Promise.all([readFile(`${base}/stat`, 'utf8'), stat(base)]);
  const fields = status.slice(status.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (info.uid !== uid || !fields[19] || !fields[4] || !fields[3] || ['Z', 'X', 'x'].includes(fields[0] ?? '')) throw new Error('inactive');
  return { start: fields[19], tty: fields[4], session: fields[3] };
}
/** One bounded local lease, owned by a direct process or a trusted socket adapter.
 * No ledger/session registry, caller-selected principal, inherited bearer, or token-verifier fallback.
 */
export class LocalOsSessionAuthority implements SessionAuthority, SessionVerifier {
  private revoked = false;
  private last: ClockSample;
  private constructor(private readonly principal: ReturnType<typeof verifiedPrincipalSchema.parse>,
    private readonly session: VerifiedSession, private readonly clock: TrustedClock, private readonly issued: ClockSample,
    private readonly pid: number, private readonly evidence: ProcessEvidence, private readonly connection?: AbortSignal) { this.last = issued; }
  static async create(scopeIds: readonly string[], lifetimeMs: number, clock: TrustedClock,
    source: Readonly<{ pid: number; uid: number; connection?: AbortSignal }> = { pid: process.pid, uid: process.getuid?.() ?? -1 }) {
    try {
      if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || source.connection?.aborted) throw new Error('invalid');
      const identity = readLocalOsIdentity();
      if (source.uid !== Number(identity.subject)) throw new Error('foreign');
      const evidence = await processEvidence(source.pid, source.uid);
      const issued = clock.sample();
      if (!Number.isFinite(issued.monotonicMs) || issued.monotonicMs < 0) throw new Error('clock');
      const principal = verifiedPrincipalSchema.parse({ ...identity, scopeIds });
      const session = verifiedSessionSchema.parse({ schemaVersion: 1, sessionId: randomUUID(), authorityRef: randomUUID(),
        kind: 'os-user', principalRef: { id: principal.id, issuer: principal.issuer, subject: principal.subject }, scopeIds,
        authenticatedAt: issued.wallMs, expiresAt: issued.wallMs + lifetimeMs });
      return new LocalOsSessionAuthority(principal, session, clock, issued, source.pid, evidence, source.connection);
    } catch { throw new SessionAuthenticationError('SESSION_REQUIRED'); }
  }
  async verifySession(credential: unknown) {
    if (credential !== undefined || !await this.isSessionActive(this.session)) throw new SessionAuthenticationError('SESSION_REQUIRED');
    return Object.freeze({ principal: this.principal, session: this.session });
  }
  async revoke(sessionId: string) { if (sessionId === this.session.sessionId) this.revoked = true; }
  async isSessionActive(input: VerifiedSession): Promise<boolean> {
    if (JSON.stringify(input) !== JSON.stringify(this.session)) return false;
    if (this.revoked || this.connection?.aborted) { this.revoked = true; return false; }
    try {
      const evidence = await processEvidence(this.pid, Number(this.principal.subject));
      const now = this.clock.sample();
      const invalidClock = !Number.isSafeInteger(now.wallMs) || !Number.isFinite(now.monotonicMs)
        || now.monotonicMs < this.last.monotonicMs || now.wallMs < this.last.wallMs;
      const expired = now.wallMs >= this.session.expiresAt || now.monotonicMs - this.issued.monotonicMs >= this.session.expiresAt - this.session.authenticatedAt;
      this.last = now;
      if (invalidClock || expired || this.connection?.aborted || JSON.stringify(evidence) !== JSON.stringify(this.evidence)) this.revoked = true;
    } catch { this.revoked = true; }
    return !this.revoked;
  }
}
