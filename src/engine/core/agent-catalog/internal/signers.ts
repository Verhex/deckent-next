import { addSignerKey, encodeCommandProjection, isAiPrincipal, revokeSignerKey, AgentCatalogError, AGENT_CATALOG_LIMITS, type AuditEvent, type SignerKey } from '#domain/index.js';
import { ed25519KeyId, sha256 } from '#platform/index.js';
import { authenticate } from '#engine/core/authentication/index.js';
import { signerAddCommandSchema, signerEnrolCommandSchema, signerListQuerySchema, signerRepairCommandSchema, signerRevokeCommandSchema, AgentCatalogStoreError,
  type AgentCatalogDependencies, type AgentCatalogStore, type SignerAction, type SignerListing, type SignerMutation, type SignerRevocation } from './contract.js';

const MAX = AGENT_CATALOG_LIMITS.signersPerScopeMax;
type Person = { readonly issuer: string; readonly subject: string };
const actor = (principal: Person & { readonly assurance?: string }) => ({ issuer: principal.issuer, subject: principal.subject, ai: isAiPrincipal(principal) });
const sameRef = (a: Person | null | undefined, b: Person) => a?.issuer === b.issuer && a.subject === b.subject;
const brokenLog = (error: unknown) => error instanceof AgentCatalogStoreError && error.code === 'SIGNER_REVOCATION_LOG_BROKEN';

/**
 * S8-5 (S8-DESIGN §8, §9): sole owner of a scope's signer rows. Only a person enrols (a host-custody `action` key the signer service generates and
 * keeps), adds (an external public key) or revokes — every AI principal is refused before policy is read or a key exists (N22). A revoke is written
 * first to the append-only revocation log beside the ledger (never backed up), then to the ledger; at start the same revoke step re-applies every
 * logged revocation a restored ledger lacks. Committed rows a revoked key signed stay as they are and are marked (owner Q-S13); new, pending and
 * replayed actions with the key are refused at commit. No method returns, prints or logs private key material.
 */
export class SignerKeyApplication {
  constructor(private readonly deps: AgentCatalogDependencies) {}
  private async admit(action: SignerAction, scopeId: string, credential: unknown) {
    const principal = await authenticate(this.deps.verifier, credential, scopeId);
    if (action !== 'inspect' && isAiPrincipal(principal)) throw new AgentCatalogError('SKILL_SIGNER_REFUSED');
    if (!this.deps.authorizeSigner) throw new AgentCatalogStoreError('AGENT_CATALOG_UNAVAILABLE');
    return { principal, revision: (await this.deps.authorizeSigner(action, scopeId, principal)).revision };
  }
  private async withStore<T>(access: 'read' | 'write', work: (store: AgentCatalogStore) => Promise<T>): Promise<T> {
    const store = await this.deps.openStore(access);
    try { return await work(store); } finally { store.close(); }
  }
  private async logState(): Promise<'ok' | 'broken'> {
    try { await this.deps.revocations?.list(); return 'ok'; } catch (error) { if (brokenLog(error)) return 'broken'; throw error; }
  }
  async list(input: unknown, credential?: unknown): Promise<SignerListing> {
    const query = signerListQuerySchema.parse(input);
    await this.admit('inspect', query.scopeId, credential);
    const log = await this.logState();
    return this.withStore('read', async store => {
      const items = [];
      for (const row of await store.signers(query.scopeId, MAX)) {
        if (row.scopeId !== query.scopeId) throw new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT');
        items.push({ ...row, signedRows: await store.signedRows(query.scopeId, row.keyId) });
      }
      return { schemaVersion: 1 as const, scopeId: query.scopeId, items, log };
    });
  }
  /** A host-custody action key for one AI/system principal: one active action key per principal (rotation = revoke the old, enrol the new). */
  async enrol(input: unknown, credential?: unknown): Promise<SignerMutation> {
    const command = signerEnrolCommandSchema.parse(input), { principal, revision } = await this.admit('enrol', command.scopeId, credential);
    const custody = this.deps.custody;
    if (!custody) throw new AgentCatalogStoreError('SIGNER_KEY_UNAVAILABLE');
    return this.change(command, principal, revision, 'enrol', async store => {
      await this.oneActionKey(store, command.scopeId, command.principal);
      const draft = { scopeId: command.scopeId, purpose: 'action' as const, boundPrincipal: command.principal, custody: 'host' as const, label: command.label,
        actor: actor(principal), atMs: this.deps.now(), commandId: command.commandId };
      addSignerKey({ ...draft, keyId: '0'.repeat(64), publicKey: `${'A'.repeat(59)}=` }); // the row is valid before any key file exists
      return { previous: null, next: addSignerKey({ ...draft, ...await custody.create() }) };
    });
  }
  /** An externally held public key (SPKI DER, base64): an AI/system principal's own action key (attribution only) or an import/publish/hub key. */
  async add(input: unknown, credential?: unknown): Promise<SignerMutation> {
    const command = signerAddCommandSchema.parse(input), { principal, revision } = await this.admit('add', command.scopeId, credential);
    let keyId: string;
    try { keyId = ed25519KeyId(Buffer.from(command.publicKey, 'base64')); } catch { throw new AgentCatalogError('SKILL_SIGNER_INVALID'); }
    return this.change(command, principal, revision, 'add', async store => {
      if (command.principal) await this.oneActionKey(store, command.scopeId, command.principal);
      return { previous: null, next: addSignerKey({ scopeId: command.scopeId, keyId, publicKey: command.publicKey, purpose: command.purpose, boundPrincipal: command.principal,
        custody: 'external', label: command.label, actor: actor(principal), atMs: this.deps.now(), commandId: command.commandId }) };
    });
  }
  /** A person's revoke card: logged first (append-only, survives restore), then the ledger row. `logged` false: the log is broken and needs repair. */
  async revoke(input: unknown, credential?: unknown): Promise<SignerMutation> {
    const command = signerRevokeCommandSchema.parse(input), { principal, revision } = await this.admit('revoke', command.scopeId, credential);
    let logged = this.deps.revocations !== undefined;
    const result = await this.change(command, principal, revision, 'revoke', async store => {
      const previous = await store.signer(command.scopeId, command.keyId), at = this.deps.now();
      if (!previous) throw new AgentCatalogStoreError('AGENT_CATALOG_NOT_FOUND');
      const next = revokeSignerKey(previous, { actor: actor(principal), atMs: at, commandId: command.commandId, basis: 'person-card' });
      if (!next) throw new AgentCatalogStoreError('AGENT_CATALOG_REVISION_CONFLICT');
      try { await this.deps.revocations?.append({ scopeId: command.scopeId, keyId: command.keyId, by: { issuer: principal.issuer, subject: principal.subject }, atMs: at, commandId: command.commandId }); }
      catch (error) { if (!brokenLog(error)) throw error; logged = false; }
      return { previous, next };
    });
    return { ...result, logged, signedRows: await this.withStore('read', store => store.signedRows(command.scopeId, command.keyId)) };
  }
  /** A person's repair of a broken revocation log: every entry still readable and every revoked row of this scope start a new chain, then re-apply. */
  async repair(input: unknown, credential?: unknown): Promise<{ readonly schemaVersion: 1; readonly entries: number; readonly revoked: number }> {
    const command = signerRepairCommandSchema.parse(input), { principal } = await this.admit('repair', command.scopeId, credential);
    const log = this.deps.revocations;
    if (!log) throw new AgentCatalogStoreError('SIGNER_KEY_UNAVAILABLE');
    const rows = await this.withStore('read', store => store.signers(command.scopeId, MAX));
    const add = rows.filter(row => row.revoked).map(row => ({ scopeId: row.scopeId, keyId: row.keyId, by: { issuer: row.revoked!.by.issuer, subject: row.revoked!.by.subject },
      atMs: row.revoked!.atMs, commandId: row.revoked!.commandId }));
    const entries = await log.repair(add);
    return { schemaVersion: 1, entries: entries.length, revoked: await this.reapply(command.scopeId, entries, principal) };
  }
  /** Start-up (before any signing): the same revoke step for every logged revocation of `scopeId` whose ledger row is still active. A broken log throws. */
  async replay(scopeId: string): Promise<number> {
    return this.deps.revocations ? this.reapply(scopeId, await this.deps.revocations.list()) : 0;
  }
  private async reapply(scopeId: string, entries: readonly SignerRevocation[], by?: Person): Promise<number> {
    let revoked = 0;
    for (const entry of entries.filter(row => row.scopeId === scopeId)) {
      const command = { scopeId, commandId: `revocation-log:${entry.commandId}`, keyId: entry.keyId }, person = by ?? entry.by;
      const done = await this.change(command, person, 'revocation-log', 'revoke', async store => {
        const previous = await store.signer(scopeId, entry.keyId), next = previous && revokeSignerKey(previous, { actor: { ...entry.by, ai: false }, atMs: entry.atMs, commandId: command.commandId, basis: 'revocation-log' });
        return next ? { previous, next } : null;
      }, 'revocation-log');
      if (done && !done.replayed) revoked++;
    }
    return revoked;
  }
  private async oneActionKey(store: AgentCatalogStore, scopeId: string, bound: Person) {
    if ((await store.signers(scopeId, MAX)).some(row => row.purpose === 'action' && row.state === 'active' && sameRef(row.boundPrincipal, bound))) throw new AgentCatalogError('SKILL_SIGNER_INVALID');
  }
  private change(command: { scopeId: string; commandId: string }, principal: Person, policyRevision: string, action: 'enrol' | 'add' | 'revoke',
    next: (store: AgentCatalogStore) => Promise<{ previous: SignerKey | null; next: SignerKey }>): Promise<SignerMutation>;
  private change(command: { scopeId: string; commandId: string }, principal: Person, policyRevision: string, action: 'revoke',
    next: (store: AgentCatalogStore) => Promise<{ previous: SignerKey | null; next: SignerKey } | null>, basis: 'revocation-log'): Promise<SignerMutation | null>;
  private change(command: { scopeId: string; commandId: string }, principal: Person, policyRevision: string, action: 'enrol' | 'add' | 'revoke',
    next: (store: AgentCatalogStore) => Promise<{ previous: SignerKey | null; next: SignerKey } | null>, basis: 'person-card' | 'revocation-log' = 'person-card'): Promise<SignerMutation | null> {
    const digest = sha256(encodeCommandProjection('skill-signer:1', { action, command, principal: { issuer: principal.issuer, subject: principal.subject } }));
    return this.withStore('write', async store => {
      const replay = await store.signerReceipt(command.scopeId, command.commandId);
      if (replay) {
        const item = replay.digest === digest ? await store.signer(command.scopeId, replay.keyId) : null;
        if (!item) throw new AgentCatalogStoreError('AGENT_CATALOG_COMMAND_CONFLICT');
        return { schemaVersion: 1, replayed: true, item };
      }
      const change = await next(store);
      if (!change) return null;
      const row = change.next, event: AuditEvent = { schemaVersion: 1, eventId: this.deps.eventId(), scopeId: command.scopeId, principal: { issuer: principal.issuer, subject: principal.subject },
        policyRevision, atMs: row.revoked?.atMs ?? row.atMs, subject: { kind: 'skill-signer', action, keyId: row.keyId, purpose: row.purpose, custody: row.custody,
          commandId: command.commandId, revision: row.revision, basis } };
      const saved = await store.commitSigner({ ...change, event, receipt: { scopeId: command.scopeId, commandId: command.commandId, keyId: row.keyId, revision: row.revision, digest } });
      return { schemaVersion: 1, replayed: saved.replayed, item: saved.item };
    });
  }
}
