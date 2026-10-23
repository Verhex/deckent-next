import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteAgentCatalogStore, openSqliteCatalogEvolutionStore } from '#adapters/index.js';
import { catalogActionBytes, catalogAggregatorPrincipal, encodeDeckentJson, SIGNATURE_LABELS, type DeckentMetrics, type JsonValue, type VerifiedPrincipal } from '#domain/index.js';
import { AgentCatalogApplication, AgentCatalogPolicyAuthorization, AgentCatalogStoreError, AgentStandingApplication, CatalogEvolutionApplication, SignerKeyApplication,
  type AgentCatalogDependencies, type CatalogLessonSource, type SignerKeyCustody, type SignerRevocation, type SignerRevocationLog } from '#engine/index.js';
import { createHmacIntegrity, ed25519KeyId, signatureMessage } from '#platform/index.js';
import { metric, NOW, type MetricSpec } from './catalog-metrics.js';

/** S8-3/S8-4 engine fixture: one SQLite ledger, the catalog and evolution stores, an in-memory host custody and revocation log, a real policy decision. */
export const SQLITE = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
export const person: VerifiedPrincipal = { id: 'h', issuer: 'local-os', subject: 'uid:1000', assurance: 'os-user', scopeIds: ['scope'] };
export const mcp: VerifiedPrincipal = { id: 'm', issuer: 'local-os/mcp', subject: 'uid:1000', assurance: 'os-user', scopeIds: ['scope'] };
export const remote: VerifiedPrincipal = { id: 'r', issuer: 'remote-ai', subject: 'agent-7', assurance: 'token-verified', scopeIds: ['scope'] };
export const aggregator = catalogAggregatorPrincipal({ issuer: 'local-os', subject: 'uid:1000' }, ['scope']);
const spki = (key: KeyObject) => key.export({ type: 'spki', format: 'der' });
export function testCustody() {
  const keys = new Map<string, KeyObject>(), signed: string[] = [];
  const custody: SignerKeyCustody = {
    async create() { const pair = generateKeyPairSync('ed25519'), keyId = ed25519KeyId(spki(pair.publicKey)); keys.set(keyId, pair.privateKey); return { keyId, publicKey: spki(pair.publicKey).toString('base64') }; },
    async signAction(keyId, action) { signed.push(keyId); return sign(null, signatureMessage(SIGNATURE_LABELS.catalogAction, catalogActionBytes(action)), keys.get(keyId)!).toString('base64'); } };
  return { custody, signed };
}
export function memoryLog(): SignerRevocationLog & { entries: SignerRevocation[] } {
  const log = { entries: [] as SignerRevocation[], async list() { return [...log.entries]; }, async append(entry: SignerRevocation) { log.entries.push(entry); },
    async repair() { return [...log.entries]; } };
  return log;
}
type Rule = { id: string; effect: 'allow'; actions: string[]; scopes: string[]; principals: { issuer: string; subject: string }[]; resource: { kind: string; ids: 'all' | string[] } };
export const grant = (id: string, who: { issuer: string; subject: string }, actions: string[], ids: 'all' | string[] = 'all', kind = 'agent-catalog'): Rule =>
  ({ id, effect: 'allow', actions, scopes: ['scope'], principals: [{ issuer: who.issuer, subject: who.subject }], resource: { kind, ids } });
export async function catalogEvolutionFixture(roots: string[], options: { mode?: 'shadow' | 'on'; overlay?: unknown; lessons?: readonly CatalogLessonSource[]; grants?: Rule[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-catalog-evolution-')); roots.push(root);
  const path = join(root, 'ledger.db'); openSqliteLedger(path, SQLITE).close();
  const integrity = createHmacIntegrity('catalog-key', randomBytes(32)), host = testCustody(), log = memoryLog();
  const policy = { grants: [grant('person', person, ['inspect', 'define', 'import', 'promote', 'demote', 'restore', 'retire', 'dismiss']), grant('aggregator', aggregator, ['inspect', 'suggest', 'narrow']),
    ...options.grants ?? []] };
  const authorization = new AgentCatalogPolicyAuthorization({ load: async () => ({ schemaVersion: 1, revision: 'p', restrictions: [], grants: policy.grants }) });
  let ids = 0, now = NOW + 1000;
  const readable = { value: (refs: readonly unknown[]) => refs.map(() => true) as boolean[] };
  const deps = (principal: VerifiedPrincipal): AgentCatalogDependencies => ({ verifier: { verify: async () => principal }, authorize: (...args) => authorization.authorize(...args),
    authorizeSigner: async () => ({ revision: 'p', ruleId: 'r' }), openStore: async access => openSqliteAgentCatalogStore(path, SQLITE, integrity, access), custody: host.custody, revocations: log,
    lessonReadable: async (_principal, _scope, refs) => readable.value(refs), now: () => now, eventId: () => `e${++ids}` });
  const standing = (principal: VerifiedPrincipal) => new AgentStandingApplication(deps(principal));
  const writer = standing(aggregator);
  const evolution = (mode = options.mode ?? 'on', overlay = options.overlay) => new CatalogEvolutionApplication({ verifier: { verify: async () => person }, authorize: async () => ({}),
    openCatalog: async () => openSqliteAgentCatalogStore(path, SQLITE, integrity, 'read'), openStore: async access => openSqliteCatalogEvolutionStore(path, SQLITE, access),
    overlay, mode, now: () => now, writer: { producer: { issuer: aggregator.issuer, subject: aggregator.subject }, ready: scopeId => writer.ready(scopeId), record: (scopeId, change) => writer.record(scopeId, change) },
    ...options.lessons ? { lessons: async () => options.lessons! } : {} });
  return { path, root, log, host, policy, readable, deps, standing, catalog: (principal = person) => new AgentCatalogApplication(deps(principal)),
    signers: new SignerKeyApplication(deps(person)), evolution, setNow: (value: number) => { now = value; } };
}
export const removeRoots = (roots: string[]) => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
let producer = 0;
/** Metric rows as the producers seal them (digest-sealed record + the producer receipt carrying its sealed `now`, `daysAgo` before NOW). */
export function seedMetrics(path: string, ...specs: (MetricSpec & { daysAgo?: number })[]) {
  const db = new DatabaseSync(path);
  try {
    for (const spec of specs) {
      const value: DeckentMetrics = metric({ scope: 'scope', ...spec }), id = `producer-${++producer}`, bytes = encodeDeckentJson(value as unknown as JsonValue);
      db.prepare("INSERT INTO run_receipts(scope_id,command_id,command,snapshot) VALUES(?,?,?,'{}')").run(value.identity.scopeId, id, JSON.stringify({ action: 'apply-task-evaluation', now: NOW - (spec.daysAgo ?? 1) * 86_400_000 }));
      db.prepare('INSERT INTO acceptance_metrics(scope_id,producer_command_id,run_id,task_id,attempt_id,outcome_kind,record) VALUES(?,?,?,?,?,?,?)').run(value.identity.scopeId, id, value.identity.runId,
        value.identity.taskId, value.identity.attemptId, value.outcome.kind, encodeDeckentJson({ schemaVersion: 1, metric: value as unknown as JsonValue, digest: createHash('sha256').update(bytes).digest('hex') }));
    }
  } finally { db.close(); }
}
export const countRows = (path: string, table: string, where = '') => { const db = new DatabaseSync(path, { readOnly: true }); try { return Number(db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get()?.['n']); } finally { db.close(); } };
export const enrol = (principal: { issuer: string; subject: string }, commandId: string) => ({ schemaVersion: 1, scopeId: 'scope', commandId, principal: { issuer: principal.issuer, subject: principal.subject }, label: commandId });
export const agentDefine = (agentId: string, commandId: string, expectedRevision: number | null = null, workClasses = ['feature']) => ({ schemaVersion: 1, scopeId: 'scope', commandId, agentId, expectedRevision,
  content: { name: agentId, persona: 'Faturaları siparişle eşleştirirsin.', workClasses, skills: [], parentAgentId: null } });
/** `n` Tasks of an agent over two models and two periods: `accepted` accepted, the rest attributable failures. */
export const agentTasks = (agentId: string, n: number, accepted: number, prefix = agentId): (MetricSpec & { daysAgo?: number })[] => Array.from({ length: n }, (_, i) => ({ task: `${prefix}-${i}`,
  agent: [agentId, 1] as const, daysAgo: i % 2 ? 1 : 9, model: ['channel-a', i % 2 ? 'model-a' : 'model-b'] as const, ...(i < accepted ? {} : { status: 'failed' as const, cause: 'criteria-failed' }) }));
export const plainTasks = (n: number, accepted: number, prefix = 'plain'): MetricSpec[] => Array.from({ length: n }, (_, i) => ({ task: `${prefix}-${i}`, agent: null,
  ...(i < accepted ? {} : { status: 'failed' as const, cause: 'worker-report-failed' }) }));
export { AgentCatalogStoreError };
