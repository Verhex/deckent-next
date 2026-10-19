import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { main } from '#surfaces/core/cli/index.js';
import { clearConfigCache, ErrorRegistry } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import type { StandingGrantsPage } from '#engine/index.js';

// CA-1: `deckent policy grants --all` renders the engine's page (person · rule · tool · pattern · scope · since) as text, on a pipe too; JSON only
// with --json; a policy refusal becomes the typed CLI_POLICY_GRANTS_ALL_UNAVAILABLE naming the permission and the next step (EN/TR).
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  registerProviderConfig();
  const root = await mkdtemp(join(tmpdir(), 'deckent-grants-all-cli-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home); await mkdir(join(root, '.deckent'));
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') }, terminal: { scopeId: 'live' } }));
  return { root, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
}
const sink = () => { const out = { text: '' }; return { out, stream: { write(value: string) { out.text += value; return true; } } }; };
const page: StandingGrantsPage = { schemaVersion: 1, scopeId: 'live', revision: 'r1', since: 'complete', next: 'Y3Vyc29y',
  rows: [{ id: 'standing-a', principals: [{ issuer: 'host', subject: '1000' }], tool: 'run_shell', kind: 'command', pattern: 'npm test', scopes: ['live'], sinceMs: Date.UTC(2026, 9, 19, 9, 30) },
    { id: 'standing-b', principals: [{ issuer: 'idp.example', subject: 'colleague' }], tool: 'edit_file', kind: 'directory', pattern: 'src/*', scopes: ['live'], sinceMs: null }] };

it('admin: a readable table on a pipe (EN and TR), raw page only with --json, the next page by --after', async () => {
  const f = await fixture(), seen: unknown[] = [];
  const listAllStandingGrants = async (_root: string, input: { scopeId: string; after?: string }) => { seen.push(input); return page; };
  const en = sink();
  expect(await main(['policy', 'grants', '--all', '--lang', 'en'], { ...f, stdout: en.stream, listAllStandingGrants })).toBe(0);
  for (const text of ['scope: live', 'This page: 2 standing approval(s) of 2 person(s)', 'Person', 'Since', 'host/1000', 'idp.example/colleague', 'standing-a', 'run_shell (command)', 'npm test',
    '2026-10-19', 'no audited change created this rule', 'deckent policy grants --all --scope live --after Y3Vyc29y', 'no secret value is shown']) expect(en.out.text).toContain(text);
  expect(en.out.text).not.toContain('{'); expect(() => JSON.parse(en.out.text)).toThrow();
  const tr = sink();
  expect(await main(['policy', 'grants', '--all', '--lang', 'tr'], { ...f, stdout: tr.stream, listAllStandingGrants })).toBe(0);
  for (const text of ['Bu sayfa: 2 kişinin 2 kalıcı onayı', 'Kişi', 'Başlangıç', 'İzin verdiği', 'elle eklenmiş', 'Daha fazla kural']) expect(tr.out.text).toContain(text);
  const json = sink();
  expect(await main(['policy', 'grants', '--all', '--json', '--scope', 'live', '--after', 'Y3Vyc29y'], { ...f, stdout: json.stream, listAllStandingGrants })).toBe(0);
  expect(JSON.parse(json.out.text)).toEqual(page);
  // The last page reached by --after is still a page, not the whole scope.
  const lastPaged = sink();
  expect(await main(['policy', 'grants', '--all', '--after', 'Y3Vyc29y', '--lang', 'en'], { ...f, stdout: lastPaged.stream, listAllStandingGrants: async () => ({ ...page, next: null }) })).toBe(0);
  expect(lastPaged.out.text).toContain('This page: 2 standing approval(s)'); expect(lastPaged.out.text).not.toContain('More rules');
  expect(seen).toEqual([{ scopeId: 'live' }, { scopeId: 'live' }, { scopeId: 'live', after: 'Y3Vyc29y' }]);
  const none = sink();
  expect(await main(['policy', 'grants', '--all', '--lang', 'tr'], { ...f, stdout: none.stream, listAllStandingGrants: async () => ({ ...page, rows: [], next: null }) })).toBe(0);
  expect(none.out.text).toContain('kimsenin kayıtlı kalıcı onayı yok');
  const last = sink();
  expect(await main(['policy', 'grants', '--all', '--lang', 'en'], { ...f, stdout: last.stream, listAllStandingGrants: async () => ({ ...page, next: null }) })).toBe(0);
  expect(last.out.text).toContain('2 standing approval(s) of 2 person(s) in this scope'); expect(last.out.text).not.toContain('--after');
});

it('refused by policy (a person without the grant, a revoked rule, the MCP actor): typed refusal naming the permission and the next step, EN and TR', async () => {
  const f = await fixture();
  for (const code of ['POLICY_DENIED', 'POLICY_APPROVAL_UNSUPPORTED']) {
    for (const [lang, words] of [['en', ['policy inspect-standing-grants', 'nothing was read', 'deckent policy upgrade --template current', 'scope live']],
      ['tr', ['policy inspect-standing-grants', 'hiçbir şey okunmadı', 'yöneticiden']]] as const) {
      const out = sink(), err = sink();
      const status = await main(['policy', 'grants', '--all', '--lang', lang], { ...f, stdout: out.stream, stderr: err.stream,
        listAllStandingGrants: async () => { throw ErrorRegistry.createError(code); } });
      expect(status).toBe(2); expect(err.out.text).toContain('CLI_POLICY_GRANTS_ALL_UNAVAILABLE'); expect(out.out.text).toBe('');
      for (const word of words) expect(err.out.text).toContain(word);
    }
  }
  // Any other failure keeps its own code (never disguised as a permission refusal).
  const err = sink();
  expect(await main(['policy', 'grants', '--all'], { ...f, stdout: sink().stream, stderr: err.stream, listAllStandingGrants: async () => { throw ErrorRegistry.createError('POLICY_UNAVAILABLE'); } })).not.toBe(0);
  expect(err.out.text).toContain('POLICY_UNAVAILABLE');
  // --after belongs to --all; --mine --all stays a usage error; nothing is read.
  const seen: unknown[] = [];
  for (const argv of [['policy', 'grants', '--after', 'x'], ['policy', 'grants', '--mine', '--all'], ['policy', 'revoke', 'standing-a', '--after', 'x']]) {
    expect(await main(argv, { ...f, stdout: sink().stream, stderr: sink().stream, listAllStandingGrants: async (...args: unknown[]) => { seen.push(args); return page; } })).toBe(2);
  }
  expect(seen).toEqual([]);
});
