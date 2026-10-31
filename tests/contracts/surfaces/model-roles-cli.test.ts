import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import type { ModelRoleInspection } from '#engine/index.js';
import { modelsCommand } from '#surfaces/core/cli-models/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

// M2 (owner 2026-10-23): `deckent models roles set` is a person's terminal act. The card shows the channel, exact model id, catalog maker and
// price, the row now and the proposed row, and what it unlocks; AI tools, pipes and --json are refused before anything is read. The card is
// simulated as in memory-write-cli (the Ink view is PTY-proven separately).
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
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-roles-cli-')); roots.push(root);
  const home = join(root, 'home'), dir = join(root, 'project');
  await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(dir, '.deckent', 'config.json'), JSON.stringify({ terminal: { scopeId: 'scope' } }), { mode: 0o600 });
  return { root: dir, env: { HOME: home, USERPROFILE: home, DECKENT_GLOBAL_HOME: join(root, 'global'), PATH: process.env['PATH'] ?? '/usr/bin:/bin' } };
}
const capture = () => { let text = ''; return { text: () => text, sink: { write: (chunk: string) => { text += chunk; return true; } } }; };
const tty = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return undefined; } });
const DIGEST = 'd'.repeat(64);
const view: ModelRoleInspection = { schemaVersion: 1, scopeId: 'scope', revision: 'model-roles-2026-10-23', digest: DIGEST,
  roles: [{ id: 'brain', minimumTier: 'frontier' }, { id: 'worker', minimumTier: 'worker' }, { id: 'beuser-walker', admits: 'connected' }],
  models: [
    { channelId: 'anthropic-api', modelId: 'claude-sonnet-5-5', state: 'assigned', tier: 'worker', roles: ['worker'], version: 1, measured: false, exceptions: [],
      catalog: { channelId: 'anthropic-api', modelId: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', maker: 'anthropic', pricing: { kind: 'per-token', asOf: '2026-10-08', inputPerMTok: '2', outputPerMTok: '10' } } },
    { channelId: 'anthropic-api', modelId: 'claude-next-1', state: 'pending', tier: null, roles: [], version: null, measured: false, exceptions: [],
      catalog: { channelId: 'anthropic-api', modelId: 'claude-next-1', displayName: 'Claude Next 1', maker: 'anthropic', pricing: { kind: 'per-token', asOf: '2026-10-23', inputPerMTok: '4', outputPerMTok: '20' } } },
  ], pending: 1 };
function handlers(calls: unknown[]) {
  return {
    inspectModelRoles: async (_root: string, query: { channelId?: string; modelId?: string }) => { calls.push(['inspect', query]);
      return { ...view, models: view.models.filter(row => (!query.channelId || row.channelId === query.channelId) && (!query.modelId || row.modelId === query.modelId)) }; },
    assignModelRole: async (_root: string, command: { channelId: string; modelId: string; tier: 'worker' | 'frontier'; roles: readonly string[] }) => { calls.push(['assign', command]);
      return { status: 'applied' as const, revision: '["model-roles-2026-10-23","installation-roles:1"]',
        row: { channelId: command.channelId, modelId: command.modelId, version: 1, tier: command.tier, roles: command.roles } }; },
  };
}
const SET = ['models', 'roles', 'set', '--channel', 'anthropic-api', '--model', 'claude-next-1', '--tier', 'frontier', '--roles', 'brain,worker', '--scope', 'scope'];

it('refuses a role change for an AI tool, a pipe and --json before any handler runs (AUTHORITY_WITNESS_REQUIRED)', async () => {
  const f = await project(), calls: unknown[] = [];
  for (const [argv, env, stdin] of [
    [SET, { ...f.env, CLAUDECODE: '1' }, tty()],
    [SET, f.env, Object.assign(Readable.from([]), { isTTY: false })],
    [[...SET, '--json'], f.env, tty()],
  ] as const) {
    await expect(modelsCommand(argv, { root: f.root, env, stdin, stdout: capture().sink, ...handlers(calls) } as never)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  }
  card.interactive = true;
  await expect(modelsCommand([...SET, '--json'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, ...handlers(calls) } as never)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(calls).toEqual([]); expect(card.asked).toEqual([]);
});

it('a person gives a new model its tier and roles on one card; the writer gets the digest the card showed', async () => {
  for (const [lang, words] of [['en', ['Channel: anthropic-api', 'claude-next-1 (Claude Next 1)', 'Maker (catalog): anthropic', '4 in / 20 out per million tokens',
    'Now: no row; every role refuses this model', 'Proposed: tier frontier, roles brain, worker', 'Unlocks brain: plans work as the Brain', 'Unlocks worker', 'global']],
  ['tr', ['Kanal: anthropic-api', 'Üretici (katalog): anthropic', 'milyon token başına 4 giriş / 20 çıkış', 'Şimdi: satır yok', 'Önerilen: kademe üst düzey, roller brain, worker',
    'brain açılır: Brain olarak iş planlar']]] as const) {
    const f = await project(), calls: unknown[] = [], out = capture(); card.interactive = true; card.asked = []; card.answers = ['apply'];
    await modelsCommand([...SET, '--lang', lang], { root: f.root, env: f.env, stdin: tty(), stdout: out.sink, ...handlers(calls) } as never);
    expect(card.asked).toHaveLength(1);
    expect(card.asked[0]!.title).toBe(lang === 'en' ? 'New model: give it a tier and roles?' : 'Yeni model: kademe ve rol verilsin mi?');
    const body = card.asked[0]!.body!.join('\n');
    for (const word of words) expect(body).toContain(word);
    expect(calls[1]).toEqual(['assign', expect.objectContaining({ scopeId: 'scope', channelId: 'anthropic-api', modelId: 'claude-next-1', tier: 'frontier', roles: ['brain', 'worker'], expect: DIGEST })]);
    expect(out.text()).toContain(lang === 'en' ? 'now has tier frontier, roles brain, worker' : 'artık kademe üst düzey, roller brain, worker');
  }
});

it('a cancelled card writes nothing and exits 1; a model outside the catalog is refused before any card', async () => {
  const f = await project(), calls: unknown[] = []; card.interactive = true; card.answers = [null];
  expect(await modelsCommand(SET, { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, stderr: capture().sink, ...handlers(calls) } as never)).toBe(1);
  expect(calls.filter(call => (call as string[])[0] === 'assign')).toEqual([]);
  card.asked = [];
  await expect(modelsCommand(SET.map(word => word === 'claude-next-1' ? 'claude-unlisted-9' : word), { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, ...handlers(calls) } as never))
    .rejects.toMatchObject({ code: 'MODEL_ROLE_CATALOG_UNKNOWN' });
  expect(card.asked).toEqual([]);
  // Removing every role is an explicit --no-roles; --roles and --no-roles together, or neither, is a usage error.
  for (const argv of [SET.filter(word => word !== '--roles' && word !== 'brain,worker'), [...SET, '--no-roles']]) {
    await expect(modelsCommand(argv, { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, ...handlers(calls) } as never)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  }
});

it('show lists every catalog model with maker, tier, roles and the pending state in both languages; --json is the typed view', async () => {
  const f = await project(), calls: unknown[] = [];
  for (const [lang, words] of [['en', ['claude-next-1', 'new model: role pending', 'assigned', 'anthropic', 'New model: role pending (1)', 'brain (frontier)',
      'beuser-walker (any connected, active model)', 'one or more of brain,worker>']],
    ['tr', ['yeni model: rol bekliyor', 'atanmış', 'Yeni model: rol bekliyor (1)', 'worker (işçi)', 'beuser-walker (bağlı ve etkin her model)']]] as const) {
    const out = capture();
    await modelsCommand(['models', 'roles', '--scope', 'scope', '--lang', lang], { root: f.root, env: f.env, stdout: out.sink, ...handlers(calls) } as never);
    for (const word of words) expect(out.text()).toContain(word);
  }
  const json = capture();
  await modelsCommand(['models', 'roles', 'show', '--channel', 'anthropic-api', '--scope', 'scope', '--json'], { root: f.root, env: f.env, stdout: json.sink, ...handlers(calls) } as never);
  expect(JSON.parse(json.text())).toMatchObject({ schemaVersion: 1, pending: 1, digest: DIGEST });
  await expect(modelsCommand(['models', 'roles', '--tier', 'frontier'], { root: f.root, env: f.env, stdout: capture().sink, ...handlers(calls) } as never)).rejects.toMatchObject({ code: 'CLI_USAGE' });
});
