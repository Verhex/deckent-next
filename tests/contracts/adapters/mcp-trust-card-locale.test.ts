import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvalSubject, type ApprovalRecord } from '#domain/index.js';
import { agentToolApprovalFacts } from '#engine/index.js';
import { createHmacIntegrity, type Locale } from '#platform/index.js';
import { describeMcpTrustCard, mcpTrustApprovalAsker, type McpCardAskerInput, type McpTrustCard } from '#adapters/index.js';

// Keep the real request sealing, subject construction and waiter; only persistence is in memory.
const journal = vi.hoisted(() => {
  let record: ApprovalRecord | null = null;
  return {
    store: {
      findToolCall: () => null,
      create: (next: ApprovalRecord) => { record = next; return next; },
      load: () => record,
      transition: (_previous: ApprovalRecord, next: ApprovalRecord) => { record = next; return next; },
    },
    close: vi.fn(),
  };
});
vi.mock('#adapters/core/approval-store/index.js', () => ({ openSqliteApprovalStore: () => journal }));

const launch: McpTrustCard = {
  phase: 'launch', name: 'catalog', scope: 'project', file: '/project/mcp.json', definitionDigest: 'a'.repeat(64),
  transport: 'stdio', command: 'node', args: ['catalog.mjs'], variables: [{ name: 'TOKEN', set: false }],
  envNames: [], headerNames: [], realm: 'sandbox-net', note: null,
};
const tools: McpTrustCard = { ...launch, phase: 'tools', era: 'modern', protocolVersion: '2026-07-28',
  tools: [{ name: 'lookup', digest: 'b'.repeat(64), description: null, annotations: {}, alwaysAsk: true }] };
const english = (phase: McpTrustCard['phase']) => [
  `MCP server catalog (project scope, /project/mcp.json) — ${phase === 'launch' ? 'start it?' : 'trust it and pin these tools?'}`,
  'command: node catalog.mjs',
  'variables: TOKEN (unset)',
  'env: none',
  'realm: sandbox-net',
  `definition: ${'a'.repeat(64)}`,
  ...(phase === 'tools' ? ['tools (1; modern 2026-07-28):', '  lookup bbbbbbbbbbbb always-ask'] : []),
].join('\n');

async function show(card: McpTrustCard, locale?: Locale) {
  const controller = new AbortController();
  const events: Parameters<McpCardAskerInput['emit']>[0][] = [];
  const ask = mcpTrustApprovalAsker({
    ledgerPath: async () => '/unused/ledger.db', sqlite: { busyTimeoutMs: 2000, journalMode: 'wal', durability: 'full' },
    integrity: async () => createHmacIntegrity('locale-test', Buffer.alloc(32, 1)),
    clock: { sample: () => ({ wallMs: 1000, monotonicMs: 0 }) }, scopeId: 'scope', turnId: 'turn',
    requester: { id: 'person', issuer: 'test', subject: 'person' }, policyRevision: 'policy', ttlMs: 10000,
    facts: agentToolApprovalFacts(null, 'scope', null), signal: controller.signal,
    ...(locale ? { locale } : {}),
    emit: event => { events.push(event); if (event.kind === 'approval.requested') controller.abort(); },
  });
  expect(await ask(card)).toBeNull();
  const requested = events.find(event => event.kind === 'approval.requested');
  expect(requested).toBeDefined();
  const record = journal.store.load();
  expect(record?.status).toBe('expired');
  const subject = approvalSubject(record!.request);
  if (subject.kind !== 'agent-tool-call' || requested?.kind !== 'approval.requested') throw new Error('Missing trust approval');
  expect(events.at(-1)).toMatchObject({ kind: 'approval.settled', callId: requested.callId, outcome: 'cancelled' });
  return { preview: requested.preview, callId: requested.callId, argsDigest: subject.argsDigest, actionDigest: record!.request.actionDigest };
}

afterEach(() => { vi.unstubAllEnvs(); journal.close.mockClear(); });

describe('MCP turn trust card locale', () => {
  it.each([launch, tools])('localizes the $phase preview without changing its approval binding or default English bytes', async card => {
    vi.stubEnv('DECKENT_LANGUAGE', 'tr');
    const tr = await show(card, 'tr'), en = await show(card, 'en'), defaultLocale = await show(card);
    expect(tr.preview).toBe(describeMcpTrustCard(card, 'tr'));
    expect(tr.preview).toContain('MCP sunucusu');
    expect(tr.preview).not.toBe(en.preview);
    expect(en.preview).toBe(english(card.phase));
    expect(defaultLocale.preview).toBe(english(card.phase));
    const digest = createHash('sha256').update(`mcp-trust-card:1\0${english(card.phase)}`).digest('hex');
    for (const shown of [tr, en, defaultLocale]) {
      expect(shown.argsDigest).toBe(digest);
      expect(shown.callId).toBe(`mcp-trust-catalog-${card.phase}`);
      expect(shown.actionDigest).toBe(defaultLocale.actionDigest);
    }
    expect(journal.close).toHaveBeenCalledTimes(3);
  });
});
