import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import type { AgentDefinition, AgentStanding } from '#domain/index.js';
import type { CatalogSuggestionView } from '#engine/index.js';
import { agentsCommand } from '#surfaces/core/cli-agents/index.js';
import { describeDiagnostic } from '#surfaces/core/monitor-view/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

// S8-4 (S8-DESIGN §6, §7): `deckent agents suggestions | promote | demote | restore | retire | dismiss | standing reset | define --from-suggestion`. Every
// change is one person's card at their own terminal (AI tools, pipes and --json refused before any handler runs); a card shows the sealed numbers beside the
// WorkClass and the promoted agent with "association, not causation" and "acceptance rate, not accuracy"; a lesson draft says it is derived from AI output.
registerProviderConfig();
const card = vi.hoisted(() => ({ interactive: false, answers: [] as (string | null)[], asked: [] as CliCardRequest[] }));
vi.mock('#surfaces/core/cli-human/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('#surfaces/core/cli-human/index.js')>();
  return { ...real,
    cliMode: (context: Parameters<typeof real.cliMode>[0], json?: boolean) => card.interactive && !json ? { mode: 'interactive' as const, reason: 'tty' as const } : real.cliMode(context, json),
    askCliCard: async (request: CliCardRequest, io: Parameters<typeof real.askCliCard>[1]) => {
      if (!card.interactive) return real.askCliCard(request, io);
      card.asked.push(request); return card.answers.length ? card.answers.shift()! : null;
    } };
});
beforeEach(() => { card.interactive = false; card.answers = []; card.asked = []; });
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-agents-evolution-cli-')); roots.push(root);
  const home = join(root, 'home'), dir = join(root, 'project');
  await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(dir, '.deckent', 'config.json'), JSON.stringify({ terminal: { scopeId: 'scope' } }), { mode: 0o600 });
  await writeFile(join(dir, 'agent.json'), JSON.stringify({ agentId: 'auditor', name: 'A', persona: 'P', workClasses: ['feature'] }));
  return { root: dir, env: { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' } };
}
const capture = () => { let text = ''; return { text: () => text, sink: { write: (chunk: string) => { text += chunk; return true; } } }; };
const tty = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return undefined; } });
const d = (c: string) => c.repeat(64);
const stats = { decided: 21, n: 20, successes: 20, wilson: { lowerMicro: 838875, upperMicro: 1000000 }, failures: { 'criteria-failed': 0, 'worker-report-failed': 0, 'human-rejected': 0 },
  unattributable: { infra: 1, model: 0, dependency: 0, policy: 0, operator: 0, unattributed: 0 }, nonAttributableShareMicro: 47619,
  excluded: { awaitingDecision: 0, quotaPark: 0, runIncomplete: 0, unknownEvidence: 0, legacy: 0, undated: 0 },
  effort: { p50Ms: 1000, p90Ms: 1000, costUsdNanos: null, costRows: 0, effortMix: {}, pinned: 20, assigned: 0, humanDecisions: 0, evidenceKinds: { 'exit-code': 20 } },
  periods: 2, models: 2, perModel: [{ channelId: 'channel-a', modelId: 'model-a', maker: 'unknown', tier: 'unknown', n: 10, successes: 10 }], otherModels: 0,
  window: { tasks: 20, firstPosition: 1, lastPosition: 20, inputDigest: d('9') } };
const view = (extra: Partial<CatalogSuggestionView> = {}): CatalogSuggestionView => ({ schemaVersion: 1, scopeId: 'scope', suggestionId: d('a'), kind: 'promote-agent', mode: 'on',
  key: { kind: 'agent', agentId: 'auditor', revision: 1, workClass: 'feature' }, keyDigest: d('b'), rule: { id: 'promote-agent', version: 1, status: 'provisional' },
  registry: { revision: 'seed', digest: d('c') }, window: { after: 0, firstPosition: 1, lastPosition: 20, tasks: 20, n: 20, inputDigest: d('9') }, stats, baseline: { ...stats, n: 10, successes: 5, wilson: null },
  active: null, effortRatioMicro: 1000000, proposed: { kind: 'standing', to: 'active' }, producer: { issuer: 'local-os/catalog-aggregator', subject: 'uid:1' }, asOfMs: Date.now() - 60000,
  expiresAtMs: Date.now() + 86_400_000, state: 'open', stateRevision: 1, decidedBy: null, decision: null, signerRevoked: false, ...extra });
const skillView = view({ suggestionId: d('e'), kind: 'propose-skill', key: { kind: 'audience', workClassFamily: 'feature', workTargetId: null }, stats: null, baseline: null,
  proposed: { kind: 'skill-draft', template: 'skill-draft@1', lessons: [{ entryId: 'l1', revision: 2, contentDigest: d('1') }], withheld: 1, lessonSetDigest: d('2') } });
const standing = (value: AgentStanding['standing'], standingRevision = 1): AgentStanding => ({ schemaVersion: 1, scopeId: 'scope', agentId: 'auditor', revision: 1, workClass: 'feature', standing: value,
  standingRevision, basis: { kind: 'definition', decidedBy: { issuer: 'local-os', subject: 'uid:1', ai: false }, atMs: 1, commandId: 'c1', suggestionId: null, reasonCode: null } });
const agent = { schemaVersion: 1, scopeId: 'scope', agentId: 'auditor', revision: 1, content: { name: 'A', persona: 'P', workClasses: ['feature'], skills: [], parentAgentId: null },
  personaDigest: d('3'), skillSetDigest: d('4'), tier: null, provenance: { author: { issuer: 'local-os/mcp', subject: 'uid:1', ai: true }, commandId: 'c1', definedAtMs: 1,
    signed: { keyId: d('5'), signatureDigest: d('6') } } } as unknown as AgentDefinition;
function handlers(calls: unknown[], rows: CatalogSuggestionView[] = [view(), skillView]) {
  const record = (kind: string, result: unknown) => async (_root: string, input: unknown) => { calls.push([kind, input]); return result; };
  return { listSuggestions: async () => ({ schemaVersion: 1 as const, scopeId: 'scope', labels: { relation: 'association-not-causation' as const, rate: 'acceptance-rate-not-accuracy' as const }, items: rows }),
    inspectSuggestion: async (_root: string, query: { suggestionId: string }) => { const item = rows.find(row => row.suggestionId === query.suggestionId);
      return item ? { schemaVersion: 1 as const, status: 'ok' as const, labels: { relation: 'association-not-causation' as const, rate: 'acceptance-rate-not-accuracy' as const }, item, standing: null, history: [] }
        : { schemaVersion: 1 as const, status: 'not-found' as const, suggestionId: query.suggestionId }; },
    inspectAgent: async () => ({ schemaVersion: 1 as const, status: 'ok' as const, item: agent, history: [agent], signers: {}, standings: [standing('candidate')] }),
    inspectSkill: async (_root: string, query: { skillId: string }) => ({ schemaVersion: 1 as const, status: 'not-found' as const, id: query.skillId }),
    listAgents: async () => ({ schemaVersion: 1 as const, scopeId: 'scope', items: [agent] }),
    changeStanding: record('change', { replayed: false, standings: [standing('active', 2)] }), dismissSuggestion: record('dismiss', { replayed: false, state: {} }),
    bulkStanding: record('bulk', { replayed: false, standings: [] }),
    draftSuggestion: async () => ({ suggestion: skillView, draft: { kind: 'skill' as const, content: { name: 'Lessons: feature', text: 'Lessons (1).\n- Fatura: eşle (cause: eksik)' }, lessons: 1, omitted: 0 },
      digest: d('7'), readable: 1, withheld: 1, aiDerived: true }),
    defineFromSuggestion: record('define', { schemaVersion: 1, replayed: false, item: { skillId: 'lessons', revision: 1 } }),
    listRevokedPromotions: async () => [{ keyId: d('5'), standing: standing('active', 2) }],
    listSigners: async () => ({ schemaVersion: 1 as const, scopeId: 'scope', log: 'ok' as const, items: [{ keyId: d('5'), purpose: 'action', boundPrincipal: { issuer: 'local-os/mcp', subject: 'uid:1' },
      custody: 'host', label: 'MCP', state: 'active', signedRows: 1 } as never] }),
    revokeSigner: record('revoke', { schemaVersion: 1, replayed: false, item: {}, logged: true, signedRows: 1 }) };
}
const run = async (f: Awaited<ReturnType<typeof project>>, args: string[], calls: unknown[], extra: Record<string, unknown> = {}) => {
  const out = capture();
  const code = await agentsCommand(['agents', ...args, '--scope', 'scope'], { root: f.root, env: f.env, stdin: tty(), stdout: out.sink, stderr: out.sink, ...handlers(calls), ...extra });
  return { code, text: out.text() };
};

it('negative: every standing, dismiss, reset and draft card is refused for an AI tool, a pipe and --json before any handler runs', async () => {
  const f = await project(), calls: unknown[] = [];
  for (const args of [['promote', 'auditor', '--work-class', 'feature'], ['demote', 'auditor', '--work-class', 'feature'], ['restore', 'auditor', '--work-class', 'feature'],
    ['retire', 'auditor', '--work-class', 'feature'], ['dismiss', 'a'.repeat(12)], ['standing', 'reset', '--work-class', 'feature'], ['define-skill', '--from-suggestion', 'e'.repeat(12), '--id', 'lessons']])
    for (const [env, stdin, json] of [[{ ...f.env, CLAUDECODE: '1' }, tty(), []], [f.env, Object.assign(Readable.from([]), { isTTY: false }), []], [f.env, tty(), ['--json']]] as const)
      await expect(agentsCommand(['agents', ...args, '--scope', 'scope', ...json], { root: f.root, env, stdin, stdout: capture().sink, ...handlers(calls) }))
        .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(calls).toEqual([]);
});
it('negative: a standing card without --work-class, or a define from both a file and a suggestion, is a usage error', async () => {
  const f = await project(), calls: unknown[] = [];
  for (const args of [['promote', 'auditor'], ['standing', 'reset'], ['define', '--input', 'agent.json', '--from-suggestion', 'a'.repeat(12), '--id', 'x'], ['define', '--from-suggestion', 'a'.repeat(12)],
    ['define-skill', '--input', 'agent.json', '--suggestion', 'a'.repeat(12)]])
    await expect(agentsCommand(['agents', ...args, '--scope', 'scope'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, ...handlers(calls) })).rejects.toMatchObject({ code: 'CLI_USAGE' });
});

describe('suggestions read', () => {
  it('lists and shows suggestions in the person\'s language with both labels; a hidden lesson is only counted; never a raw code or lesson text', async () => {
    const f = await project(), calls: unknown[] = [];
    for (const [lang, phrases] of [['en', ['association, not causation · acceptance rate, not accuracy', 'promote', 'new skill', 'open', '20 counted']],
      ['tr', ['ilişki, nedensellik değil · kabul oranı, doğruluk değil', 'terfi', 'yeni skill', 'açık', '20 sayıldı']]] as const) {
      const { text } = await run(f, ['suggestions', '--lang', lang], calls);
      for (const phrase of phrases) expect(text, phrase).toContain(phrase);
      expect(text).not.toMatch(/promote-agent|propose-skill|association-not-causation/u);
    }
    const shown = await run(f, ['suggestions', 'show', 'e'.repeat(12), '--lang', 'tr'], calls);
    expect(shown.text).toContain('okuyabildiğiniz dersler 1, sizden gizli 1'); expect(shown.text).toContain('l1@2');
    const promote = await run(f, ['suggestions', 'show', 'a'.repeat(12), '--lang', 'en'], calls);
    for (const phrase of ['Suggestion ' + 'a'.repeat(64), '20/20 accepted', 'not counted against the agent: infrastructure 1', 'WorkClass overall without this agent: 5/10 accepted',
      'a weak filter only', 'Proposes: promoted', 'provisional']) expect(promote.text, phrase).toContain(phrase);
    expect(calls).toEqual([]);
  });
});

describe('person cards', () => {
  it('a promote card decides the open suggestion of its key at the shown standing revision; it names the AI author; cancel writes nothing', async () => {
    const f = await project(), calls: unknown[] = [];
    card.interactive = true; card.answers = ['cancel'];
    expect((await run(f, ['promote', 'auditor', '--work-class', 'feature', '--lang', 'tr'], calls)).code).not.toBe(0);
    expect(calls).toEqual([]);
    const body = card.asked[0]!.body.join('\n');
    for (const phrase of ['auditor sürüm 1 · feature: aday → terfili', 'ilişki, nedensellik değil', 'zayıf bir süzgeç', 'Bu sürümü bir AI yazdı (local-os/mcp:uid:1)', 'Run kartı olmadan seçebilir'])
      expect(body, phrase).toContain(phrase);
    card.answers = ['apply'];
    const done = await run(f, ['promote', 'auditor', '--work-class', 'feature', '--lang', 'en'], calls);
    expect(calls).toMatchObject([['change', { action: 'promote', agentId: 'auditor', revision: 1, workClass: 'feature', expectedStandingRevision: 1, suggestionId: d('a') }]]);
    expect(done.text).toContain('auditor · feature: now promoted.');
  });
  it('a lesson draft card says it is derived from AI output and applies with the digest it showed; dismiss and reset are one card each', async () => {
    const f = await project(), calls: unknown[] = [];
    card.interactive = true; card.answers = ['apply'];
    await run(f, ['define-skill', '--from-suggestion', 'e'.repeat(12), '--id', 'lessons', '--lang', 'tr'], calls);
    expect(card.asked[0]!.body.join('\n')).toContain('AI çıktısından türetildi');
    expect(calls).toMatchObject([['define', { suggestionId: d('e'), id: 'lessons', draftDigest: d('7'), expectedRevision: null }]]);
    card.answers = ['apply'];
    await run(f, ['dismiss', 'a'.repeat(12), '--lang', 'en'], calls);
    expect(calls[1]).toMatchObject(['dismiss', { suggestionId: d('a'), expectedStateRevision: 1 }]);
  });
  it('after a revoke card, the key\'s promotions still in effect are offered for a one-step demote (owner Q-S13); declining keeps them, said plainly', async () => {
    const f = await project(), calls: unknown[] = [];
    card.interactive = true; card.answers = ['apply', 'cancel'];
    const kept = await run(f, ['revoke-signer', '5'.repeat(12), '--lang', 'tr'], calls);
    expect(card.asked[1]!.title).toContain('1 terfi hâlâ geçerli'); expect(kept.text).toContain('geçerli kalıyor');
    expect(calls.map(row => (row as [string])[0])).toEqual(['revoke']);
    card.answers = ['apply', 'apply'];
    await run(f, ['revoke-signer', '5'.repeat(12), '--lang', 'en'], calls);
    expect(calls.at(-1)).toMatchObject(['bulk', { reason: { kind: 'signer-revoked', keyId: d('5') }, targets: [{ agentId: 'auditor', expectedStandingRevision: 2 }] }]);
  });
});

it('the monitor names the catalog lines in the person\'s language', () => {
  expect(describeDiagnostic('catalog-suggestions-open:3', 'tr')).toMatchObject({ text: 'Ajan önerisi bekliyor (3)', action: 'Karar için: deckent agents suggestions' });
  expect(describeDiagnostic('catalog-signer-revoked:1', 'tr').text).toContain('İmzalayan iptal edildi');
  expect(describeDiagnostic('catalog-aggregator-unsigned', 'tr').text).toContain('imza anahtarı yok');
  // alpha.56 F1 (61b1bdb1b): the action names the aggregator identity the observation carries; without one it points to the signer list.
  expect(describeDiagnostic('catalog-aggregator-unsigned:["s","local/catalog-aggregator","alp"]', 'en').action).toContain("--scope 's' --principal 'local/catalog-aggregator:alp'");
  expect(describeDiagnostic('catalog-aggregator-unsigned', 'en').action).toContain('deckent agents signers');
});

describe('define from a file naming a suggestion (REVISE 2742 R1)', () => {
  it('a superseded (revoked producer key), expired, decided or shadow suggestion is refused before the card is shown; an open one reaches the define', async () => {
    const f = await project(), calls: unknown[] = [], defineAgent = async (_root: string, input: unknown) => { calls.push(['defineAgent', input]); return { schemaVersion: 1, replayed: false, item: { agentId: 'auditor', revision: 2 } }; };
    const args = ['agents', 'define', '--input', 'agent.json', '--suggestion', 'a'.repeat(12), '--scope', 'scope'];
    card.interactive = true;
    for (const [extra, code] of [[{ state: 'superseded', signerRevoked: true }, 'CATALOG_SUGGESTION_STALE'], [{ expiresAtMs: Date.now() - 1 }, 'CATALOG_SUGGESTION_STALE'],
      [{ state: 'expired' }, 'CATALOG_SUGGESTION_STALE'], [{ state: 'decided' }, 'CATALOG_SUGGESTION_STALE'], [{ mode: 'shadow' }, 'CATALOG_SUGGESTION_SHADOW']] as const) {
      card.answers = ['apply'];
      await expect(agentsCommand(args, { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, stderr: capture().sink, ...handlers(calls, [view({ kind: 'revise-agent', ...extra })]), defineAgent }))
        .rejects.toMatchObject({ code });
    }
    expect(card.asked).toEqual([]);
    expect(calls).toEqual([]);
    card.answers = ['apply'];
    expect(await agentsCommand(args, { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, stderr: capture().sink, ...handlers(calls, [view({ kind: 'revise-agent' })]), defineAgent })).not.toBe(1);
    expect(card.asked).toHaveLength(1);
    expect(calls).toMatchObject([['defineAgent', { agentId: 'auditor', expectedRevision: 1, fromSuggestion: d('a') }]]);
  });
});

it('a suggestion digest shorter than the displayed twelve characters reports the short prefix, before listing', async () => {
  const f = await project(), listing = vi.fn();
  await expect(agentsCommand(['agents', 'suggestions', 'show', 'abc', '--scope', 'scope'], { root: f.root, env: f.env, stdout: capture().sink,
    listSuggestions: listing })).rejects.toMatchObject({ code: 'CLI_ID_TOO_SHORT', params: { prefix: 'abc', min: 12 } });
  expect(listing).not.toHaveBeenCalled();
});
