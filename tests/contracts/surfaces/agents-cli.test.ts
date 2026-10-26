import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import type { AgentDefinition, SkillDefinition } from '#domain/index.js';
import { agentsCommand } from '#surfaces/core/cli-agents/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

// S7: `deckent agents define | define-skill` is a person's terminal act (the default card, AJAN-ORG S6). The card shows what will be written; an AI
// tool, a pipe or --json is refused before anything is read. Reads list and inspect agents and skills. The card is simulated as in memory-write-cli.
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
const d = (c: string) => c.repeat(64);
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-agents-cli-')); roots.push(root);
  const home = join(root, 'home'), dir = join(root, 'project');
  await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(dir, '.deckent', 'config.json'), JSON.stringify({ terminal: { scopeId: 'scope' } }), { mode: 0o600 });
  await writeFile(join(dir, 'agent.json'), JSON.stringify({ agentId: 'invoice-auditor', name: 'Fatura denetçisi', persona: 'Faturaları siparişle eşleştirirsin.',
    workClasses: ['feature'], skills: [{ skillId: 'invoice-match' }], parentAgentId: 'finance-lead' }));
  await writeFile(join(dir, 'skill.json'), JSON.stringify({ skillId: 'invoice-match', name: 'Fatura eşleştirme', text: 'Siparişi faturayla eşle.' }));
  return { root: dir, env: { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' } };
}
const capture = () => { let text = ''; return { text: () => text, sink: { write: (chunk: string) => { text += chunk; return true; } } }; };
const tty = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return undefined; } });
const author = { issuer: 'local-os', subject: 'uid:1', ai: false };
const skill: SkillDefinition = { schemaVersion: 1, scopeId: 'scope', skillId: 'invoice-match', revision: 3, content: { name: 'Fatura eşleştirme', text: 'Siparişi faturayla eşle.' },
  contentDigest: d('a'), source: { kind: 'local' }, signature: { status: 'unsigned' }, provenance: { author, commandId: 'k1', definedAtMs: 1 } };
const agent: AgentDefinition = { schemaVersion: 1, scopeId: 'scope', agentId: 'invoice-auditor', revision: 1, tier: null, personaDigest: d('b'), skillSetDigest: d('c'),
  content: { name: 'Fatura denetçisi', persona: 'Faturaları siparişle eşleştirirsin.', workClasses: ['feature'], skills: [{ skillId: 'invoice-match', revision: 3, digest: d('a') }], parentAgentId: null },
  provenance: { author: { ...author, issuer: 'local-os/mcp', ai: true }, commandId: 'a1', definedAtMs: 1 } };
function handlers(calls: unknown[], existing: AgentDefinition | null = null) {
  return {
    listAgents: async () => ({ schemaVersion: 1 as const, scopeId: 'scope', items: [agent] }),
    inspectAgent: async (_root: string, query: { agentId: string }) => existing && query.agentId === existing.agentId
      ? { schemaVersion: 1 as const, status: 'ok' as const, item: existing, history: [existing] } : { schemaVersion: 1 as const, status: 'not-found' as const, id: query.agentId },
    listSkills: async () => ({ schemaVersion: 1 as const, scopeId: 'scope', items: [skill] }),
    inspectSkill: async (_root: string, query: { skillId: string }) => query.skillId === skill.skillId
      ? { schemaVersion: 1 as const, status: 'ok' as const, item: skill, history: [skill] } : { schemaVersion: 1 as const, status: 'not-found' as const, id: query.skillId },
    defineAgent: async (_root: string, input: unknown) => { calls.push(['agent', input]); return { schemaVersion: 1 as const, replayed: false, item: agent }; },
    defineSkill: async (_root: string, input: unknown) => { calls.push(['skill', input]); return { schemaVersion: 1 as const, replayed: false, item: skill }; },
  };
}

it('negative: define and define-skill are refused for an AI tool, a pipe and --json before any handler runs (AUTHORITY_WITNESS_REQUIRED)', async () => {
  const f = await project(), calls: unknown[] = [];
  for (const [argv, env, stdin] of [
    [['agents', 'define', '--input', 'agent.json', '--scope', 'scope'], { ...f.env, CLAUDECODE: '1' }, tty()],
    [['agents', 'define-skill', '--input', 'skill.json', '--scope', 'scope'], f.env, Object.assign(Readable.from([]), { isTTY: false })],
    [['agents', 'define', '--input', 'agent.json', '--scope', 'scope', '--json'], f.env, tty()],
  ] as const) {
    await expect(agentsCommand(argv, { root: f.root, env, stdin, stdout: capture().sink, ...handlers(calls) })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  }
  expect(calls).toEqual([]);
});

it('a person creates an agent on their card: skills are pinned to their current revision and digest, the card shows persona, classes and parent', async () => {
  const f = await project(), calls: unknown[] = [], out = capture(); card.interactive = true; card.answers = ['apply'];
  await agentsCommand(['agents', 'define', '--input', 'agent.json', '--scope', 'scope', '--lang', 'en'], { root: f.root, env: f.env, stdin: tty(), stdout: out.sink, ...handlers(calls) });
  expect(card.asked).toHaveLength(1);
  const shown = JSON.stringify(card.asked[0]);
  for (const text of ['Faturaları siparişle eşleştirirsin.', 'feature', 'invoice-match@3', 'finance-lead', 'New agent']) expect(shown).toContain(text);
  expect(calls).toMatchObject([['agent', { scopeId: 'scope', agentId: 'invoice-auditor', expectedRevision: null,
    content: { skills: [{ skillId: 'invoice-match', revision: 3, digest: d('a') }], parentAgentId: 'finance-lead' } }]]);
  expect(out.text()).toContain('invoice-auditor');
});

it('a revision carries the revision the card showed; a cancelled card writes nothing and exits 1; define-skill writes a local skill', async () => {
  const f = await project(), calls: unknown[] = []; card.interactive = true;
  card.answers = [null];
  expect(await agentsCommand(['agents', 'define', '--input', 'agent.json', '--scope', 'scope'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, stderr: capture().sink, ...handlers(calls, agent) })).toBe(1);
  expect(calls).toEqual([]);
  card.answers = ['apply', 'apply'];
  await agentsCommand(['agents', 'define', '--input', 'agent.json', '--scope', 'scope', '--lang', 'tr'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, ...handlers(calls, agent) });
  await agentsCommand(['agents', 'define-skill', '--input', 'skill.json', '--scope', 'scope'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, ...handlers(calls, agent) });
  expect(calls).toMatchObject([['agent', { agentId: 'invoice-auditor', expectedRevision: 1 }], ['skill', { skillId: 'invoice-match', expectedRevision: 3, content: { name: 'Fatura eşleştirme' } }]]);
  expect(JSON.stringify(card.asked[1])).toContain('1 → 2');
});

it('reads: the list, one agent with its pinned skills, the skills list and one skill — in English and Turkish, and as JSON', async () => {
  const f = await project(), base = { root: f.root, env: f.env, ...handlers([]) };
  const list = capture(); await agentsCommand(['agents', '--scope', 'scope', '--lang', 'en'], { ...base, stdout: list.sink });
  expect(list.text()).toContain('invoice-auditor'); expect(list.text()).toContain('Fatura denetçisi');
  const one = capture(); await agentsCommand(['agents', 'inspect', 'invoice-auditor', '--scope', 'scope', '--lang', 'tr'], { ...base, inspectAgent: handlers([], agent).inspectAgent, stdout: one.sink });
  for (const text of ['Faturaları siparişle eşleştirirsin.', 'invoice-match@3', '(AI)']) expect(one.text()).toContain(text);
  const skills = capture(); await agentsCommand(['agents', 'skills', '--scope', 'scope', '--lang', 'en'], { ...base, stdout: skills.sink });
  expect(skills.text()).toContain('invoice-match'); expect(skills.text()).toContain('local');
  const json = capture(); await agentsCommand(['agents', 'skill', 'invoice-match', '--scope', 'scope', '--json'], { ...base, stdout: json.sink });
  expect(JSON.parse(json.text())).toMatchObject({ status: 'ok', item: { skillId: 'invoice-match', contentDigest: d('a') } });
});
it('S8-1a: inspect names the standing per bound work class (EN/TR); an agent defined before standings existed says none is recorded', async () => {
  const f = await project(), base = { root: f.root, env: f.env, ...handlers([]) };
  const standing = { schemaVersion: 1 as const, scopeId: 'scope', agentId: 'invoice-auditor', revision: 1, workClass: 'feature', standing: 'candidate' as const, standingRevision: 1,
    basis: { kind: 'definition' as const, decidedBy: author, atMs: 1, commandId: 'a1', suggestionId: null, reasonCode: null } };
  const inspectAgent = async () => ({ schemaVersion: 1 as const, status: 'ok' as const, item: agent, history: [agent], standings: [standing, { ...standing, workClass: 'docs', standing: 'active' as const }] });
  const tr = capture(); await agentsCommand(['agents', 'inspect', 'invoice-auditor', '--scope', 'scope', '--lang', 'tr'], { ...base, inspectAgent, stdout: tr.sink });
  expect(tr.text()).toContain('İş türüne göre durum: feature aday, docs terfili');
  const en = capture(); await agentsCommand(['agents', 'inspect', 'invoice-auditor', '--scope', 'scope', '--lang', 'en'], { ...base, inspectAgent, stdout: en.sink });
  expect(en.text()).toContain('Standing per work class: feature candidate, docs promoted');
  const legacy = capture(); await agentsCommand(['agents', 'inspect', 'invoice-auditor', '--scope', 'scope', '--lang', 'en'], { ...base, inspectAgent: handlers([], agent).inspectAgent, stdout: legacy.sink });
  expect(legacy.text()).toContain('none recorded');
});

it('named reads reject missing agents, skills and stats, including JSON; the list exposes the missing aggregator signer', async () => {
  const f = await project(), base = { root: f.root, env: f.env, ...handlers([]), stdout: capture().sink };
  const missingStats = { schemaVersion: 1 as const, scopeId: 'scope', status: 'not-found' as const, labels: { relation: 'association-not-causation' as const, rate: 'acceptance-rate-not-accuracy' as const },
    mode: 'shadow' as const, registry: { revision: 'r', status: 'provisional', digest: d('a') }, asOfMs: 1, rows: { read: 0, truncated: false }, lastPass: null, agents: [], workClasses: [] };
  for (const action of ['inspect', 'skill', 'stats']) await expect(agentsCommand(['agents', action, 'missing-agent', '--scope', 'scope', '--json'],
    { ...base, inspectAgentStats: async () => missingStats })).rejects.toMatchObject({ code: 'AGENT_CATALOG_NOT_FOUND' });
  const out = capture(); await agentsCommand(['agents', '--scope', 'scope', '--lang', 'en'], { ...base, stdout: out.sink, inspectCatalogMonitor: async () => ['catalog-aggregator-unsigned'] });
  expect(out.text()).toContain('signing key'); expect(out.text()).toContain('deckent agents enrol-signer');
});
it('a cancelled scope card reports cancellation, exits 1 and reads no agents', async () => {
  const f = await project(), read = vi.fn(), err = capture(); card.interactive = true; card.answers = [null];
  await writeFile(join(f.root, '.deckent', 'config.json'), '{}'); clearConfigCache();
  expect(await agentsCommand(['agents', '--lang', 'en'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, stderr: err.sink,
    configChoiceSources: () => ({ list: async () => Object.freeze(Object.assign(['one', 'two'].map(value => ({ value, label: value })), { partial: false })) }), listAgents: read })).toBe(1);
  expect(err.text()).toContain('Cancelled'); expect(read).not.toHaveBeenCalled();
});
