import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolvePolicyBindings, type VerifiedPrincipal } from '#domain/index.js';
import { ApprovalApplication, ApprovalAssuranceProducerRegistry, approvalAssuranceRegistrationEvent, approvalAssuranceRegistry,
  agentToolApprovalFacts, createTurnDecisionCapabilities, requestAgentToolApproval, requiredApprovalAssurance, sealApproval, verifyApproval, AuditApplication } from '#engine/index.js';
import { openSqliteApprovalStore, openSqliteAuditStore, openSqliteLedger, upgradeExistingProductLedger } from '#adapters/index.js';
import { CORE_TURN_ASSURANCE_REFERENCE } from '#platform/core/config-fields/index.js';
import { CONFIG_FIELDS, createHmacIntegrity } from '#platform/index.js';
import { DOWNGRADE_TO_V40_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

const manifest = { schemaVersion: 1 as const, id: 'enterprise.assurance', version: 1, level: 'enterprise-step-up', rank: 2 };
const evidence = { scopeId: 'scope', approvalId: 'approval', decider: { issuer: 'host', subject: 'owner' }, peerPid: null, capability: null, nowMs: 1000 };
const registration = () => ({ manifest: { ...manifest }, create: () => ({ attests: () => true }) });
const make = () => { const registry = new ApprovalAssuranceProducerRegistry(); registry.register(registration()); registry.seal(); return registry; };
const reference = { id: manifest.id, version: manifest.version };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('keeps legacy config on Core v1; selection is explicit, versioned, bounded and duplicate-free', () => {
  expect(CONFIG_FIELDS.approvals.schema.parse({}).assuranceProducers).toEqual([CORE_TURN_ASSURANCE_REFERENCE]);
  expect(CONFIG_FIELDS.approvals.schema.parse({ assuranceProducers: [] }).assuranceProducers).toEqual([]);
  for (const assuranceProducers of [[reference, reference], [{ id: manifest.id }], [{ ...reference, version: 0 }], [{ ...reference, extra: true }]])
    expect(CONFIG_FIELDS.approvals.schema.safeParse({ assuranceProducers }).success).toBe(false);
});
it.each([
  { schemaVersion: 2 }, { version: 0 }, { rank: 0 }, { rank: 1 }, { rank: NaN }, { rank: Infinity },
  { level: 'turn-bound' }, { level: 'peer-session' }, { id: 'core.fake' }, { level: 'core.fake' }, { id: 'undotted' },
])('refuses invalid versions/ranks and Core replacement: %j', change => {
  const registry = new ApprovalAssuranceProducerRegistry();
  expect(() => registry.register({ ...registration(), manifest: { ...manifest, ...change } } as never)).toThrow();
  expect(registry.manifests()).toHaveLength(1);
});
it('refuses duplicate id, level and rank, and late registration; returned manifests cannot be mutated', () => {
  const registry = new ApprovalAssuranceProducerRegistry(); registry.register(registration());
  for (const change of [{ version: 2, level: 'other-level', rank: 3 }, { id: 'other.id', rank: 3 }, { id: 'other.id', level: 'other-level' }])
    expect(() => registry.register({ ...registration(), manifest: { ...manifest, ...change } })).toThrow(expect.objectContaining({ code: 'REGISTRY_ADAPTER_DUPLICATE' }));
  expect(Object.isFrozen(registry.manifests()[1])).toBe(true);
  registry.seal(); expect(() => registry.register(registration())).toThrow(expect.objectContaining({ code: 'REGISTRY_SEALED' }));
});
it('snapshots registration metadata and factory functions; registered but unselected levels remain unsatisfiable', () => {
  const registry = new ApprovalAssuranceProducerRegistry(), input = registration(); registry.register(input);
  input.manifest.rank = 99; input.create = () => { throw new Error('mutated factory'); }; registry.seal();
  const record = vi.fn();
  expect(approvalAssuranceRegistry(registry.resolve([], undefined, record)).rank(manifest.level)).toBe(Infinity);
  expect(record).toHaveBeenCalledWith([expect.objectContaining({ id: CORE_TURN_ASSURANCE_REFERENCE.id, active: false }), expect.objectContaining({ ...manifest, active: false })]);
  const live = approvalAssuranceRegistry(registry.resolve([reference], undefined, record));
  expect(live.derive(evidence)).toMatchObject({ level: manifest.level, rank: 2 });
});
it('refuses missing producer/version and duplicate selection before audit or construction', () => {
  const registry = make(), record = vi.fn();
  for (const refs of [[{ id: 'missing.id', version: 1 }], [{ ...reference, version: 2 }], [reference, reference]])
    expect(() => registry.resolve(refs, undefined, record)).toThrow(expect.objectContaining({ code: 'REGISTRY_ADAPTER_UNKNOWN' }));
  expect(record).not.toHaveBeenCalled();
});
it('no audit means no factory activation; non-boolean/async attestations never grant assurance', () => {
  const registry = new ApprovalAssuranceProducerRegistry(), create = vi.fn(() => ({ attests: () => Promise.resolve(true) as never }));
  registry.register({ manifest, create }); registry.seal();
  expect(() => registry.resolve([reference], undefined, () => { throw new Error('audit unavailable'); })).toThrow('audit unavailable');
  expect(create).not.toHaveBeenCalled();
  expect(approvalAssuranceRegistry(registry.resolve([reference], undefined, () => undefined)).derive(evidence).level).toBe('peer-session');
});
it('cannot lower a hard-floor class with a peer-session policy rule or with Core producer disabled', () => {
  const policy = resolvePolicyBindings({ schemaVersion: 2, revision: 'p', roles: [], restrictions: [], grants: [], separationOfDuties: [],
    approvalAssurance: [{ id: 'loose', scopes: 'all', subject: 'agent-tool-call', minimum: 'peer-session' }] }, { schemaVersion: 1, revision: 'b', bindings: [] });
  const core = approvalAssuranceRegistry([createTurnDecisionCapabilities()]);
  expect(agentToolApprovalFacts(policy, 'scope', 'shell-destructive').requiredAssurance).toBe('turn-bound');
  const inactive = approvalAssuranceRegistry(make().resolve([], undefined, () => undefined));
  expect(inactive.rank('turn-bound')).toBe(Infinity);
  expect(core.rank('turn-bound')).toBe(1);
});

const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const principal: VerifiedPrincipal = { id: 'owner', issuer: 'host', subject: 'owner', assurance: 'os-user', scopeIds: ['scope'] };
const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
const clock = { sample: () => ({ wallMs: 1000, monotonicMs: 10 }) };
const sessions = { verifySession: async () => ({ principal, session: { schemaVersion: 1, sessionId: 'session', authorityRef: 'trusted-fixture', kind: 'os-user',
  principalRef: actor, scopeIds: ['scope'], authenticatedAt: 1, expiresAt: 10000 } }), isSessionActive: async () => true, revoke: async () => undefined };

it('approve-card-then-assert: config-selected ERP producer uses the one decision path; absent/inactive producer leaves risky card pending without receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'approval-producer-')); roots.push(root);
  const journal = openSqliteApprovalStore(join(root, 'ledger.db'), options, 'allow'), integrity = createHmacIntegrity('key', randomBytes(32));
  const policy = resolvePolicyBindings({ schemaVersion: 2, revision: 'p', roles: [], restrictions: [], separationOfDuties: [],
    grants: [{ id: 'approver', effect: 'allow', principals: 'all', scopes: 'all', actions: 'all', resource: { kind: 'approval', ids: 'all' } }],
    approvalAssurance: [{ id: 'strict', scopes: 'all', subject: 'agent-tool-call', minimum: manifest.level }] }, { schemaVersion: 1, revision: 'b', bindings: [] });
  const settle = vi.fn(), registry = new ApprovalAssuranceProducerRegistry();
  registry.register({ manifest, create: () => ({ attests: ev => ev.scopeId === 'scope' && ev.decider.subject === 'owner', settle }) }); registry.seal();
  try {
    const card = requestAgentToolApproval(journal.store, integrity, { scopeId: 'scope', subject: { kind: 'agent-tool-call', turnId: 'turn', round: 1, index: 0,
      tool: 'run_shell', toolVersion: 1, resource: 'rm -rf production', argsDigest: 'a'.repeat(64) }, requester: actor, policyRevision: 'p', summary: 'rm -rf production',
      createdAt: 100, expiresAt: 10000, facts: agentToolApprovalFacts(policy, 'scope', 'shell-destructive') });
    const command = { schemaVersion: 1, scopeId: 'scope', approvalId: card.request.approvalId, commandId: 'allow', expectedRevision: 0, decision: 'allow', reason: 'Reviewed risky input' };
    const app = (producers: ReturnType<typeof registry.resolve>) => new ApprovalApplication(journal.store, { verify: async () => principal }, sessions,
      { load: async () => policy }, integrity, clock, 'local-sdk', 10, undefined, undefined, { producers });
    for (const producers of [[], registry.resolve([], undefined, () => undefined), registry.resolve([reference], undefined, () => undefined)]) {
      await expect(app(producers).decide(command)).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
      expect(journal.store.load('scope', card.request.approvalId)?.status).toBe('pending'); expect(journal.store.receipt('scope', 'allow')).toBeNull();
    }
    const live = registry.resolve([CORE_TURN_ASSURANCE_REFERENCE, reference], createTurnDecisionCapabilities(), () => undefined);
    expect(requiredApprovalAssurance(policy, card.request, approvalAssuranceRegistry(live))).toBe(manifest.level);
    const decided = await app(live).decide(command);
    expect(decided.decision).toMatchObject({ assurance: manifest.level, decision: 'allow' }); expect(settle).toHaveBeenCalledTimes(1);
    expect(await app([]).decide(command)).toEqual(decided); expect(settle).toHaveBeenCalledTimes(1);
    expect(verifyApproval(JSON.parse(JSON.stringify(decided)), integrity)).toEqual(decided);
  } finally { journal.close(); }
});
it('real-shaped v40 migration preserves legacy sealed approval bytes; v1 registration inventory persists/reopens without a DDL change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assurance-migration-')); roots.push(root);
  const path = join(root, 'ledger.db'), integrity = createHmacIntegrity('key', randomBytes(32));
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_V40_LEDGER_SQL);
  const legacy = JSON.stringify(sealApproval({ request: { schemaVersion: 1, approvalId: 'old-task', scopeId: 'scope', runId: 'run', taskId: 'task',
    requester: actor, actionDigest: 'a'.repeat(64), policyRevision: 'p', summary: 'task', createdAt: 1, expiresAt: 10 }, revision: 0, status: 'pending', decision: null }, integrity));
  db.prepare('INSERT INTO approvals(scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot) VALUES(?,?,?,?,?,?,?,?)')
    .run('scope', 'old-task', 'task', 'run', 'task', 'a'.repeat(64), 0, legacy); db.close();
  await mkdir(join(root, 'backups'), { mode: 0o700 });
  await upgradeExistingProductLedger(path, options, join(root, 'backups'), new Date('2026-10-15T00:00:00Z'));
  const raw = new DatabaseSync(path); expect(raw.prepare('SELECT snapshot FROM approvals WHERE approval_id=?').get('old-task')?.snapshot).toBe(legacy); raw.close();
  let store = await openSqliteAuditStore(path, options, 'forbid');
  const context = { eventId: 'registry', scopeId: 'scope', principal: actor, policyRevision: 'p', atMs: 1000 };
  let bytes = '';
  let oldAuditBytes: string;
  const oldEvent = { schemaVersion: 1 as const, ...context, eventId: 'legacy-audit', principal: { issuer: actor.issuer, subject: actor.subject },
    subject: { kind: 'mcp-trust' as const, action: 'trust' as const, scope: 'project' as const, server: 'erp', definitionDigest: 'b'.repeat(64), toolsDigest: null } };
  try {
    const audit = new AuditApplication(store, integrity), registry = make();
    oldAuditBytes = JSON.stringify(audit.record(oldEvent));
    registry.resolve([reference], undefined, producers => { bytes = JSON.stringify(audit.record(approvalAssuranceRegistrationEvent(context, producers))); });
    expect(audit.list('scope', 0, 10)[1]?.event.subject).toMatchObject({ kind: 'approval-assurance-registration', schemaVersion: 1,
      producers: [expect.objectContaining({ active: false }), expect.objectContaining({ ...manifest, active: true })] });
  } finally { store.close(); }
  store = await openSqliteAuditStore(path, options, 'forbid');
  try {
    const audit = new AuditApplication(store, integrity); expect(JSON.stringify(audit.load('scope', 'legacy-audit'))).toBe(oldAuditBytes); expect(JSON.stringify(audit.load('scope', 'registry'))).toBe(bytes);
    const record = audit.load('scope', 'registry')!; expect(audit.record(record.event)).toEqual(record);
    expect(() => audit.record({ ...record.event, subject: { ...record.event.subject, secret: 'forbidden' } })).toThrow(expect.objectContaining({ code: 'AUDIT_INVALID' }));
  } finally { store.close(); }
});
