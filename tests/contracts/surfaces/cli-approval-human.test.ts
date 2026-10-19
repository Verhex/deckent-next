import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { clearConfigCache } from '#platform/index.js';
import { getDecisionSteps, type DecisionDelegationView, type ApprovalRecord } from '#domain/index.js';
import { mcpCapabilityRegistry } from '#engine/index.js';
import { answerOnCard, approvalPickLabel, toggleDelegations, toggleMcp, type CardAsk } from '#surfaces/core/cli-approval/index.js';
import { decisionCommand } from '#surfaces/core/cli-decision/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

/**
 * C-APPROVE (alpha.48, CLI review §approval, §decide, §policy): readable approval/decision/policy output, field-named input errors, `--schema`,
 * the terminal's approval card from the CLI and the TTY policy toggles over the existing governed changes. AI/MCP never decide.
 */
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project(config: Record<string, unknown> = { terminal: { scopeId: 'live' } }) {
  registerProviderConfig();
  const root = await mkdtemp(join(tmpdir(), 'dn-cli-approve-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') }, ...config }));
  return root;
}
async function run(argv: string[], handlers: Record<string, unknown>, root: string, env: Record<string, string> = {}, stdin?: Readable) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, { root, env: { HOME: join(root, 'h'), USERPROFILE: join(root, 'h'), NO_COLOR: '1', ...env }, initialize() {}, ...(stdin ? { stdin } : {}),
    stdout: { write(value: string) { out.push(value); } }, stderr: { write(value: string) { err.push(value); } }, ...handlers } as never);
  return { code, text: out.join(''), err: err.join('') };
}
const digest = 'a'.repeat(64), now = Date.now();
const requester = { id: 'u', issuer: 'host', subject: '1000' };
function approval(id: string, input: { status?: 'pending' | 'decided' | 'expired'; created?: number; ttl?: number; cell?: string; authority?: boolean; legacy?: boolean; summary?: string } = {}): ApprovalRecord {
  const createdAt = input.created ?? now - 60_000, status = input.status ?? 'pending';
  const facts = { risk: input.cell ? { source: 'cell', cell: input.cell } : { source: 'effect-class', effectClass: 'write', authority: input.authority ?? false },
    reversibility: { kind: 'none' }, onExpiry: 'nothing-runs', requiredAssurance: 'peer-session' };
  const shared = { approvalId: id, scopeId: 'live', subject: { kind: 'task', runId: 'run-1', taskId: `task-${id}` }, requester, actionDigest: digest, policyRevision: 'p1',
    summary: input.summary ?? `Run the tests for ${id}`, createdAt, expiresAt: createdAt + (input.ttl ?? 600_000) };
  const request = input.legacy ? { schemaVersion: 2, ...shared } : { schemaVersion: 3, ...shared, facts };
  const decision = status === 'decided' ? { schemaVersion: 4, commandId: 'c', decision: 'allow', actor: requester, sessionId: 's', channel: 'local-cli', reason: 'checked',
    decidedAt: createdAt + 1, requestDigest: digest, commandDigest: digest, idempotencyKeyHash: digest, assurance: 'peer-session', deciderClass: 'human-tty' } : null;
  return { request, revision: status === 'pending' ? 0 : 1, status, decision, keyId: 'k', mac: digest } as unknown as ApprovalRecord;
}
const lines = (text: string) => text.split('\n');

it('AI path: a wrong approval input names the field (not INVENTORY_QUERY_INVALID) and sends nothing; --schema prints the contract', async () => {
  const root = await project(), seen: unknown[] = [];
  const handlers = { listApprovals: async (input: unknown) => { seen.push(input); return []; }, decideApproval: async (input: unknown) => { seen.push(input); return null; },
    inspectApproval: async (input: unknown) => { seen.push(input); return null; } };
  const listed = await run(['approval', 'list', '--input', '-', '--lang', 'en'], handlers, root, {}, Readable.from([JSON.stringify({ schemaVersion: 1, scopeId: 'live' })]));
  expect(listed.code).toBe(2); expect(listed.err).toContain('CLI_INPUT_FIELD_INVALID'); expect(listed.err).toContain('afterId'); expect(listed.err).toContain('is missing');
  expect(listed.err).not.toContain('INVENTORY_QUERY_INVALID'); expect(listed.err).toMatch(/\\?"limit\\?":20/u);
  // An AI (or any JSON) decision without a reason is refused before anything is sent.
  const noReason = await run(['approval', 'decide', '--input', '-', '--lang', 'tr'], handlers, root, {}, Readable.from([JSON.stringify({ schemaVersion: 1, scopeId: 'live',
    approvalId: 'a1', commandId: 'c1', expectedRevision: 0, decision: 'allow' })]));
  expect(noReason.code).toBe(2); expect(noReason.err).toContain('reason'); expect(noReason.err).toContain('eksik');
  const extra = await run(['approval', 'inspect', '--input', '-'], handlers, root, {}, Readable.from([JSON.stringify({ schemaVersion: 1, scopeId: 'live', approvalId: 'a1', limit: 1 })]));
  expect(extra.code).toBe(2); expect(extra.err).toContain('limit');
  expect(seen).toEqual([]);
  const schema = await run(['approval', 'decide', '--schema'], handlers, root);
  expect(schema.code).toBe(0); // The decision schema is a union (once, or "this session" for a tool call): the projection lists both shapes, each with its required fields.
  expect(JSON.parse(schema.text).anyOf[0].required).toEqual(['schemaVersion', 'scopeId', 'approvalId', 'commandId', 'expectedRevision', 'decision', 'reason']);
});

it('AI path: --input --json returns the service result unchanged; without --json a person reads a table, waiting first', async () => {
  const root = await project(), page = [approval('decided-1', { status: 'decided', created: now - 7_200_000 }), approval('wait-1', { created: now - 120_000 })];
  const handlers = { listApprovals: async () => page };
  const json = await run(['approval', 'list', '--input', '-', '--json'], handlers, root, {}, Readable.from([JSON.stringify({ schemaVersion: 1, scopeId: 'live', afterId: null, limit: 5 })]));
  expect(json.code).toBe(0); expect(JSON.parse(json.text)).toEqual(JSON.parse(JSON.stringify(page)));
  const text = await run(['approval', 'list', '--input', '-', '--lang', 'tr'], handlers, root, {}, Readable.from([JSON.stringify({ schemaVersion: 1, scopeId: 'live', afterId: null, limit: 5 })]));
  expect(text.code).toBe(0); expect(text.text).not.toContain('{'); expect(text.text.indexOf('wait-1')).toBeLessThan(text.text.indexOf('decided-'));
  expect(text.text).toMatch(/bekliyor · 8 dk \d+ sn kaldı|bekliyor · 7 dk \d+ sn kaldı/u);
});

it('person path: `approval list` reads the default scope, names it, waiting first, bounded pages; --json is the raw page', async () => {
  const root = await project(), calls: unknown[] = [];
  const pageA = [approval('old-1', { status: 'expired', created: now - 3_600_000, ttl: 60_000 }), approval('wait-2', { created: now - 30_000 }),
    { request: { schemaVersion: 9, approvalId: 'future-1' }, revision: 0, status: 'pending', decision: null }];
  const handlers = { listApprovals: async (input: { afterId: string | null }) => { calls.push(input); return input.afterId === null ? pageA : []; } };
  const listed = await run(['approval', 'list', '--lang', 'en'], handlers, root);
  expect(listed.code).toBe(0);
  expect(lines(listed.text)[0]).toContain('live'); expect(listed.text).toContain('1 waiting · 2 in total'); expect(listed.text).toContain('expired (nothing ran)');
  expect(listed.text.indexOf('wait-2')).toBeLessThan(listed.text.indexOf('old-1'));
  // A record this build cannot read is counted, never silently dropped.
  expect(listed.text).toContain('1 record(s) could not be read by this version');
  expect(calls).toEqual([{ schemaVersion: 1, scopeId: 'live', afterId: null, limit: 100 }]);
  const json = await run(['approval', 'list', '--json'], handlers, root);
  expect(JSON.parse(json.text)).toHaveLength(3);
});

it('decide without --input: off a terminal (pipe, AI agent) nothing is asked or decided; the missing --input is named with an example', async () => {
  const root = await project(), seen: unknown[] = [];
  const handlers = { listApprovals: async () => [approval('wait-3')], decideApproval: async (input: unknown) => { seen.push(input); return null; } };
  const tty = Object.assign(Readable.from([]), { isTTY: true, setRawMode() { return this; } });
  // A pipe, and an AI agent on a real-looking terminal: never a card.
  for (const [env, terminal] of [[{}, false], [{ CLAUDECODE: '1' }, true], [{ AI_AGENT: 'x' }, true]] as const) {
    const result = await run(['approval', 'decide', '--lang', 'en'], { ...handlers, ...(terminal ? { stdout: { write() {}, isTTY: true } } : {}) }, root, env,
      terminal ? tty : Object.assign(Readable.from([]), { isTTY: false }));
    expect(result.code).toBe(2); expect(result.err).toContain('CLI_ARGUMENT_MISSING'); expect(result.err).toContain('--input');
  }
  expect(seen).toEqual([]);
});

it('the approval card: once / no only (a hard floor never "always"), system ids, default or own reason; cancel decides nothing', async () => {
  const sent: Record<string, unknown>[] = [], requests: CliCardRequest[] = [];
  const context = { decideApproval: async (input: Record<string, unknown>) => { sent.push(input); return { ...approval('wait-4', { status: 'decided' }) }; } };
  const ask = (answer: string | null): CardAsk => async request => { requests.push(request); return answer; };
  for (const [record, answer, reason] of [[approval('wait-4'), 'once', undefined], [approval('floor-1', { cell: 'edit-floor' }), 'no', 'Not this file'],
    [approval('legacy-1', { legacy: true }), 'once', undefined], [approval('auth-1', { authority: true }), null, undefined]] as const) {
    await answerOnCard(record, reason, 'live', context as never, ask(answer), 'tr');
  }
  for (const request of requests) {
    expect(request.options.map(option => option.id)).toEqual(['once', 'no']);
    expect(request.options.some(option => option.id === 'always' || option.id === 'session')).toBe(false);
  }
  expect(requests[1]!.body!.join('\n')).toContain('Sert taban'); expect(requests[2]!.body!.join('\n')).toContain('Sert taban'); expect(requests[0]!.body!.join('\n')).not.toContain('Sert taban');
  expect(sent).toHaveLength(3);
  expect(sent[0]).toMatchObject({ approvalId: 'wait-4', decision: 'allow', expectedRevision: 0, channel: 'local-cli', reason: 'Terminalde onaylandı' });
  expect(String(sent[0]!['commandId'])).toMatch(/^cli-[0-9a-f-]{36}$/u); expect(sent[0]).not.toHaveProperty('approverNote');
  expect(sent[1]).toMatchObject({ approvalId: 'floor-1', decision: 'deny', reason: 'Not this file', approverNote: true });
  expect(sent[2]).toMatchObject({ approvalId: 'legacy-1', decision: 'allow' });
  // Picker rows are drawn as given by the card view, so the label itself is redacted (L-KIT: no secret in any rendered field).
  const token = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const label = approvalPickLabel(approval('secret-1', { summary: `curl -H "x-api-key: ${token}" https://api.example` }), 'en');
  expect(label).not.toContain('sk-ant-api03-AAAA'); expect(label).toContain('curl');
  expect(requests[0]!.body!.join('\n')).not.toContain('sk-ant');
});

it('decide: `{}` names the missing field (no "model call" text), --schema prints the contract, bare decide lists recent decisions', async () => {
  const root = await project(), queries: unknown[] = [];
  const empty = await run(['decide', 'inspect', '--input', '-', '--lang', 'en'], { inspectDecision: async () => { throw new Error('sent'); } }, root, {}, Readable.from(['{}']));
  expect(empty.code).toBe(2); expect(empty.err).toContain('CLI_INPUT_FIELD_INVALID'); expect(empty.err).toContain('schemaVersion'); expect(empty.err).not.toMatch(/model call/iu);
  expect(empty.err).toContain('is missing');
  const schema = await run(['decide', 'record', '--schema'], {}, root);
  expect(schema.code).toBe(0); expect(schema.text).toContain('selectedOption');
  const item = (id: string, claimedAtMs: number, selected?: string) => ({ schemaVersion: 1, status: 'advised', decisionId: id, caseDigest: digest, adviceDigest: digest, invocationId: 'i',
    advice: { schemaVersion: 1, choice: 'a', probabilities: { a: 0.9, none_of_the_above: 0.05, insufficient_information: 0.05 }, confidence: 0.8, sufficiency: 0.9, checks: {}, model: 'm',
      usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 }, thresholds: { choice: 0.85, sufficiency: 0.67 },
    record: selected ? { actor: { selectedOption: selected, rationale: 'fits' }, outcome: null } : null, replayed: false, claimedAtMs,
    case: { objective: `Pick the release for ${id}`, options: [{ id: 'a', action: 'ship', tradeoffs: [], evidenceIds: [] }] } });
  const out: string[] = [];
  await decisionCommand(['decide', '--lang', 'tr'], { root, env: { HOME: join(root, 'h'), NO_COLOR: '1' }, stdout: { write: (text: string) => { out.push(text); } },
    listDecisions: async (_root: string, query: unknown) => { queries.push(query); return { schemaVersion: 1, scopeId: 'live', items: [item('dec-new', now - 60_000, 'a'), item('dec-old', now - 7_200_000)] }; } } as never);
  expect(queries).toEqual([{ schemaVersion: 1, scopeId: 'live', limit: 20 }]);
  const text = out.join('');
  expect(text).toContain('live'); expect(text.indexOf('dec-new')).toBeLessThan(text.indexOf('dec-old')); expect(text).toContain('Pick the release'); expect(text).not.toContain(digest);
});

it('policy: summary (labelled admin, counts, hashes only with --verbose), own grants by default, --all refused before any read, vocabulary table', async () => {
  const root = await project(), reads: string[] = [];
  const status = { schemaVersion: 1, scopeId: 'live', revision: 'rev-123', admins: [{ issuer: 'host', subject: 'DESKTOP/1000' }], usableAdminCount: 1,
    template: { kind: 'hand-built', version: null, recognition: 'revision-only' }, bootstrapRequired: false, recoveryRequired: false, identityReadiness: 'not-verified' };
  const view: DecisionDelegationView = { schemaVersion: 1, scopeId: 'live', revision: 'p', resourceId: null, principal: { issuer: 'host/mcp', subject: 'p' },
    steps: getDecisionSteps().map((step, index) => ({ step, managed: index === 0 ? 'granted' : 'none', effective: index === 0 ? 'allowed' : 'denied' })) };
  const handlers = { inspectPolicyAdministration: async () => { reads.push('status'); return status; },
    listStandingGrants: async () => { reads.push('grants'); return [{ id: 'standing-1', key: 'k', tool: 'shell', kind: 'command', text: 'npm test' }]; },
    delegations: { inspect: async () => view, change: async () => { throw new Error('no change'); } },
    mcpCapabilities: { listMcpCapabilityScopes: async () => ['live'], changeMcpCapabilities: async () => { throw new Error('no change'); },
      inspectMcpCapabilities: async () => { throw Object.assign(new Error('denied'), { code: 'POLICY_DENIED' }); } } };
  const summary = await run(['policy', 'status', '--lang', 'tr'], handlers, root);
  expect(summary.code).toBe(0);
  expect(summary.text).toContain('Yönetici: host/DESKTOP/1000'); expect(summary.text).toContain('kullanılabilir admin'); expect(summary.text).toContain('Kalıcı onaylarım: 1');
  expect(summary.text).toContain(`${getDecisionSteps().length} içinde 1 açık`); expect(summary.text).toContain('okunamadı: POLICY_DENIED'); expect(summary.text).not.toContain('rev-123');
  expect((await run(['policy', 'status', '--verbose'], handlers, root)).text).toContain('rev-123');
  expect(JSON.parse((await run(['policy', 'status', '--json'], handlers, root)).text)).toEqual(status);
  reads.length = 0;
  const own = await run(['policy', 'grants', '--lang', 'en'], handlers, root);
  expect(own.code).toBe(0); expect(own.text).toContain('standing-1'); expect(reads).toEqual(['grants']);
  reads.length = 0;
  const all = await run(['policy', 'grants', '--all'], handlers, root);
  expect(all.code).toBe(2); expect(all.err).toContain('CLI_POLICY_GRANTS_ALL_UNAVAILABLE'); expect(reads).toEqual([]);
  // No --lang: the installation's configured language (tr here), not the English of the environment.
  const trRoot = await project({ terminal: { scopeId: 'live' }, language: 'tr' });
  const vocabulary = await run(['policy', 'vocabulary'], {}, trRoot, { LANG: 'C' });
  expect(vocabulary.code).toBe(0); expect(vocabulary.text).not.toContain('{'); expect(vocabulary.text).toContain('Kaynak'); expect(vocabulary.text).toContain('yetki vermez');
  const delegations = await run(['policy', 'delegations', '--lang', 'en'], handlers, root);
  expect(delegations.code).toBe(0); expect(delegations.text).toContain('live'); expect(delegations.text).toContain(' on'); expect(delegations.text).toContain(' off');
});

it('TTY toggles: declined or cancelled → no governed change; yes → the existing change with the reviewed revision / preview digest', async () => {
  const root = await project(), changes: unknown[] = [], confirmed: boolean[] = [];
  const view: DecisionDelegationView = { schemaVersion: 1, scopeId: 'live', revision: 'rev-1', resourceId: null, principal: { issuer: 'host/mcp', subject: 'p' },
    steps: getDecisionSteps().map(step => ({ step, managed: 'none', effective: 'denied' })) };
  const delegations = { inspect: async () => view, change: async (_root: string, command: unknown, confirm: (reviewed: DecisionDelegationView) => Promise<boolean>) => {
    changes.push(command); const yes = await confirm(view); confirmed.push(yes); return { status: yes ? 'applied' : 'cancelled', view } as const; } };
  const cards: CliCardRequest[] = [];
  const answers = (...ids: (string | null)[]): CardAsk => async request => { cards.push(request); return ids.shift() ?? null; };
  const context = { root, env: { HOME: join(root, 'h'), NO_COLOR: '1' }, stdout: { write() {} }, delegations } as never;
  const step = getDecisionSteps()[0]!.id;
  await toggleDelegations(context, 'en', 'live', 1000, answers(step, 'no'));
  await toggleDelegations(context, 'en', 'live', 1000, answers(step, null));
  await toggleDelegations(context, 'en', 'live', 1000, answers('-leave'));
  expect(confirmed).toEqual([false, false]);
  // The preview card speaks plain words (off → on), never the policy revision hash.
  expect(cards[1]!.body!.join('\n')).toContain('off → on'); expect(cards[1]!.body!.join('\n')).not.toContain('rev-1');
  expect(cards[0]!.options.map(option => option.label).join(' ')).toContain('· off');
  await toggleDelegations(context, 'en', 'live', 1000, answers(step, 'apply'));
  expect(confirmed).toEqual([false, false, true]);
  expect(changes.at(-1)).toMatchObject({ scopeId: 'live', step, action: 'grant', actor: 'mcp', expectedRevision: 'rev-1' });
  const group = mcpCapabilityRegistry.list()[0]!, mcpCalls: Record<string, unknown>[] = [];
  const preview = { schemaVersion: 1, status: 'preview', revision: 'r', digest: 'preview-digest', principal: { issuer: 'host/mcp', subject: 'p' }, rules: [], change: null, missing: [],
    action: 'grant', scopeId: 'live', groupId: group.id };
  const mcpCapabilities = { listMcpCapabilityScopes: async () => ['live'],
    inspectMcpCapabilities: async () => ({ schemaVersion: 1, scopeId: 'live', revision: 'r', principal: preview.principal, groups: [{ group, managed: 'none', effective: 'denied' }] }),
    changeMcpCapabilities: async (_root: string, input: Record<string, unknown>) => { mcpCalls.push(input); return { ...preview, status: input['mode'] === 'apply' ? 'applied' : 'preview' }; } };
  const mcpContext = { root, env: { HOME: join(root, 'h'), NO_COLOR: '1' }, stdout: { write() {} }, mcpCapabilities } as never;
  await toggleMcp(mcpContext, 'tr', 'live', 1000, answers(group.id, 'no'));
  expect(mcpCalls.map(call => call['mode'])).toEqual(['preview']);
  await toggleMcp(mcpContext, 'tr', 'live', 1000, answers(group.id, 'apply'));
  expect(mcpCalls.at(-1)).toMatchObject({ mode: 'apply', expect: 'preview-digest', action: 'grant', groupId: group.id, scopeId: 'live' });
});

it('MCP-NO-DECIDE kept: the MCP surface has no approval or decision decide tool', async () => {
  const { createMcpServer } = await import('#surfaces/core/mcp/index.js');
  const { Client } = await import('@modelcontextprotocol/client'), { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const server = createMcpServer({} as never, { maxConcurrentCalls: 1, responseMaxBytes: 65536 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'no-decide', version: '1' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).not.toContain('decide_approval'); expect(names).not.toContain('record_decision');
    expect(names.filter(name => /decide|record_decision|outcome_decision/u.test(name))).toEqual([]);
  } finally { await client.close(); }
});
