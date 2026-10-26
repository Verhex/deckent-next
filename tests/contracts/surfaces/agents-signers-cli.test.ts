import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearConfigCache, ed25519KeyId } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import type { SignerKey, SkillDefinition } from '#domain/index.js';
import { agentsCommand } from '#surfaces/core/cli-agents/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

// S8-5: `deckent agents signers | enrol-signer | add-signer | revoke-signer | repair-signers | import-skill`. Every change is a person's card at their own
// terminal (AI tools, pipes and --json refused before any handler runs); the card says what the key may do and what a revoke keeps; output is public facts only.
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
const vendor = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }), vendorId = ed25519KeyId(vendor);
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-agents-signers-cli-')); roots.push(root);
  const home = join(root, 'home'), dir = join(root, 'project');
  await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(dir, '.deckent', 'config.json'), JSON.stringify({ terminal: { scopeId: 'scope' } }), { mode: 0o600 });
  await writeFile(join(dir, 'key.json'), JSON.stringify({ purpose: 'import', publicKey: vendor.toString('base64'), label: 'Verhex hub' }));
  await writeFile(join(dir, 'bundle.json'), JSON.stringify({ skillId: 'invoice-match', name: 'Fatura', text: 'Siparişi faturayla eşle.', source: { ref: 'hub:verhex/invoice-match' },
    pin: 'a'.repeat(64), signature: { algorithm: 'ed25519', keyId: vendorId, value: 'A'.repeat(86) + '==' } }));
  return { root: dir, env: { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' } };
}
const capture = () => { let text = ''; return { text: () => text, sink: { write: (chunk: string) => { text += chunk; return true; } } }; };
const tty = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return undefined; } });
const person = { issuer: 'local-os', subject: 'uid:1', ai: false as const };
const row = (keyId: string, extra: Partial<SignerKey> = {}): SignerKey => ({ schemaVersion: 1, scopeId: 'scope', keyId, algorithm: 'ed25519', publicKey: vendor.toString('base64'),
  purpose: 'action', boundPrincipal: { issuer: 'local-os/mcp', subject: 'uid:1' }, custody: 'host', label: 'MCP actor', state: 'active', addedBy: person, atMs: 1, commandId: 'e1', revision: 1, ...extra });
const skill = { schemaVersion: 1, scopeId: 'scope', skillId: 'invoice-match', revision: 1 } as unknown as SkillDefinition;
function handlers(calls: unknown[], log: 'ok' | 'broken' = 'ok') {
  const rows = [{ ...row('c'.repeat(64)), signedRows: 2 }, { ...row(vendorId, { purpose: 'import', boundPrincipal: null, custody: 'external', label: 'Verhex hub' }), signedRows: 0 }];
  const done = (kind: string) => async (_root: string, input: unknown) => { calls.push([kind, input]); return { schemaVersion: 1 as const, replayed: false, item: rows[0]!, logged: log === 'ok', signedRows: 2 }; };
  return { listSigners: async () => ({ schemaVersion: 1 as const, scopeId: 'scope', items: rows, log }), enrolSigner: done('enrol'), addSigner: done('add'), revokeSigner: done('revoke'),
    repairSigners: async (_root: string, input: unknown) => { calls.push(['repair', input]); return { schemaVersion: 1 as const, entries: 3, revoked: 1 }; },
    inspectSkill: async (_root: string, query: { skillId: string }) => ({ schemaVersion: 1 as const, status: 'not-found' as const, id: query.skillId }),
    importSkill: async (_root: string, input: unknown) => { calls.push(['import', input]); return { schemaVersion: 1 as const, replayed: false, item: skill }; } };
}

it('negative: every signer card and the import are refused for an AI tool, a pipe and --json before any handler runs', async () => {
  const f = await project(), calls: unknown[] = [];
  for (const args of [['enrol-signer', '--principal', 'local-os/mcp:uid:1', '--label', 'x'], ['add-signer', '--input', 'key.json'], ['revoke-signer', 'c'.repeat(12)], ['repair-signers'],
    ['import-skill', '--input', 'bundle.json']])
    for (const [env, stdin, json] of [[{ ...f.env, CLAUDECODE: '1' }, tty(), []], [f.env, Object.assign(Readable.from([]), { isTTY: false }), []], [f.env, tty(), ['--json']]] as const)
      await expect(agentsCommand(['agents', ...args, '--scope', 'scope', ...json], { root: f.root, env, stdin, stdout: capture().sink, ...handlers(calls) }))
        .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(calls).toEqual([]);
});

it('enrol: the card names the principal and what a host signature proves; apply sends exactly the principal and label; cancel writes nothing', async () => {
  const f = await project(), calls: unknown[] = [], out = capture(); card.interactive = true; card.answers = [null, 'apply'];
  const argv = ['agents', 'enrol-signer', '--principal', 'local-os/mcp:uid:1', '--label', 'MCP actor', '--scope', 'scope', '--lang', 'tr'];
  expect(await agentsCommand(argv, { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, stderr: capture().sink, ...handlers(calls) })).toBe(1);
  await agentsCommand(argv, { root: f.root, env: f.env, stdin: tty(), stdout: out.sink, ...handlers(calls) });
  const shown = JSON.stringify(card.asked[0]);
  for (const text of ['local-os/mcp:uid:1', 'MCP actor', 'modelin niyetini kanıtlamaz']) expect(shown).toContain(text);
  expect(calls).toMatchObject([['enrol', { scopeId: 'scope', principal: { issuer: 'local-os/mcp', subject: 'uid:1' }, label: 'MCP actor' }]]);
  expect(out.text()).toContain('c'.repeat(64));
  await expect(agentsCommand(['agents', 'enrol-signer', '--principal', 'no-colon', '--label', 'x', '--scope', 'scope'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, ...handlers(calls) }))
    .rejects.toMatchObject({ code: 'CLI_USAGE' });
});

it('add, revoke (unique 12-character prefix, the card says committed rows stay marked), repair and import each go through one card', async () => {
  const f = await project(), calls: unknown[] = []; card.interactive = true; card.answers = ['apply', 'apply', 'apply', 'apply'];
  const run = (args: string[], extra = {}) => agentsCommand(['agents', ...args, '--scope', 'scope', '--lang', 'en'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, ...handlers(calls), ...extra });
  await run(['add-signer', '--input', 'key.json']);
  expect(JSON.stringify(card.asked[0])).toContain(vendorId); expect(JSON.stringify(card.asked[0])).toContain('Deckent does not protect it');
  await run(['revoke-signer', 'c'.repeat(12)]);
  expect(JSON.stringify(card.asked[1])).toContain('The 2 committed rows it signed stay as they are');
  await run(['repair-signers']);
  await run(['import-skill', '--input', 'bundle.json']);
  expect(JSON.stringify(card.asked[3])).toContain('hub:verhex/invoice-match');
  expect(calls).toMatchObject([['add', { purpose: 'import', principal: null, label: 'Verhex hub' }], ['revoke', { keyId: 'c'.repeat(64) }], ['repair', { scopeId: 'scope' }],
    ['import', { skillId: 'invoice-match', expectedRevision: null, content: { name: 'Fatura' }, pin: 'a'.repeat(64), signature: { keyId: vendorId } }]]);
  await expect(run(['revoke-signer', 'c'.repeat(8)])).rejects.toMatchObject({ code: 'CLI_ID_TOO_SHORT' });
});

it('the list shows public facts in EN/TR and as JSON; a broken log is stated; nothing private is printed', async () => {
  const f = await project(), base = { root: f.root, env: f.env };
  const tr = capture(); await agentsCommand(['agents', 'signers', '--scope', 'scope', '--lang', 'tr'], { ...base, ...handlers([], 'broken'), stdout: tr.sink });
  for (const text of ['İptal kaydı bozuk', 'eylemler', 'skill içe aktarma', 'harici anahtar', 'c'.repeat(12)]) expect(tr.text()).toContain(text);
  const json = capture(); await agentsCommand(['agents', 'signers', '--scope', 'scope', '--json'], { ...base, ...handlers([]), stdout: json.sink });
  expect(JSON.parse(json.text())).toMatchObject({ log: 'ok', items: [{ purpose: 'action', signedRows: 2 }, { purpose: 'import' }] });
  expect(json.text()).not.toMatch(/pkcs8|PRIVATE/i);
});

it('a signer prefix shorter than twelve characters says too short after the human witness gate', async () => {
  const f = await project(); card.interactive = true;
  await expect(agentsCommand(['agents', 'revoke-signer', 'abc', '--scope', 'scope'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink,
    listSigners: async () => ({ schemaVersion: 1, scopeId: 'scope', items: [] }) })).rejects.toMatchObject({ code: 'CLI_ID_TOO_SHORT', params: { min: 12 } });
  expect(card.asked).toHaveLength(0);
});
