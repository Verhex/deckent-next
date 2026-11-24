import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { main } from '#surfaces/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

// C-MODELS: the trust card is an arrow-key card on a person's terminal; it is simulated here and its lines are printed as the card shows them.
const shownCards = vi.hoisted(() => [] as string[]);
vi.mock('#surfaces/core/cli-human/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('#surfaces/core/cli-human/index.js')>();
  return { ...real, cliMode: () => ({ mode: 'interactive' as const, reason: 'tty' as const }),
    askCliCard: async (request: CliCardRequest) => { shownCards.push([request.title, ...(request.body ?? [])].join('\n')); return 'yes'; } };
});

// T3 integration (L1 i18n debt): `deckent mcp add` prints its trust card with the terminal window's localized fields (realm in words, URL and
// header names, never a value) and the K1 grant outcome as one sentence — not the adapter's raw card object or a `grant: {…}` dump.
const card = { phase: 'launch', name: 'web', scope: 'local', file: '/p/.deckent/mcp.local.json', definitionDigest: 'a'.repeat(64), transport: 'http',
  command: 'https://mcp.example.com/mcp', args: [], variables: [], envNames: [], headerNames: ['Authorization'], realm: 'none',
  posture: 'remote: an HTTP server on another machine (nothing runs here; its headers go to that endpoint with every request)', note: null };
async function run(lang: 'en' | 'tr', grant: unknown) {
  const out: string[] = [], stdin = Object.assign(new PassThrough(), { isTTY: true });
  const code = await main(['mcp', 'add', '--transport', 'http', '--header', 'Authorization: Bearer $DECK:GH', 'web', 'https://mcp.example.com/mcp', '--lang', lang], {
    root: '/p', env: {}, stdin, stdout: { write(value: string) { out.push(value); } },
    async runMcpCommand(_root: string, _request: unknown, _options: unknown, ask: (card: unknown) => Promise<boolean>) {
      await ask(card);
      return { schemaVersion: 1, added: { name: 'web', scope: 'local', file: '/p/.deckent/mcp.local.json' }, trust: 'trusted', pinnedTools: 2, grant };
    } } as never);
  return { code, text: [...shownCards.splice(0), out.join('')].join('\n') };
}
it('prints the trust card in the person\'s words and the grant outcome as a sentence (EN, TR)', async () => {
  const en = await run('en', { status: 'granted' });
  expect(en.code).toBe(0);
  expect(en.text).toContain('Start the MCP server web to read its tools?');
  expect(en.text).toContain('URL: https://mcp.example.com/mcp');
  expect(en.text).toContain('Headers: Authorization');
  expect(en.text).toContain('remote: an HTTP server on another machine; nothing runs here');
  expect(en.text).not.toContain('$DECK');
  expect(en.text).toContain('Policy grant written: this server is yours to call; standard asks every call, and tools marked "always ask" ask in every mode; every call is audited.');
  expect(en.text).not.toMatch(/grant:\s*\{/u);
  const tr = await run('tr', { status: 'refused', reason: 'administer' });
  expect.soft(tr.code).toBe(1);
  expect(tr.text).toContain('Başlıklar: Authorization');
  expect(tr.text).toContain('Güvenildi ama politika izni yazılmadı: politikanız politika kurallarını değiştirmenize izin vermiyor');
  const trGranted = await run('tr', { status: 'granted' });
  expect(trGranted.text).toContain('Politika izni yazıldı: bu sunucuyu çağırabilirsiniz; standart mod her çağrıda, "her zaman sor" işaretli araçlar her modda sorar; her çağrı denetim kaydına yazılır.');
});

it('prints the two revoke outcomes in EN and TR and preserves the same JSON receipt', async () => {
  const receipt = { schemaVersion: 1, revoked: { name: 'fx', scope: 'local' }, grant: { status: 'refused', reason: 'AUTHORITY_WITNESS_REQUIRED' } };
  const revoke = async (locale: 'en' | 'tr', result: unknown, json = false) => {
    const out: string[] = [];
    const code = await main(['mcp', 'revoke', 'fx', '--lang', locale, ...(json ? ['--json'] : [])], {
      root: '/p', env: {}, stdout: { write(value: string) { out.push(value); } },
      async runMcpCommand(_root: string, request: unknown) { expect(request).toEqual({ verb: 'revoke', name: 'fx' }); return result; },
    } as never);
    expect.soft(code, JSON.stringify(result)).toBe((result as typeof receipt).grant?.status === 'refused' ? 1 : 0);
    return out.join('').trimEnd();
  };
  const enTrust = 'Trust for fx was revoked. Approve it again before starting the server.';
  const enWitness = `${enTrust}\nThis operation removed no policy grant. Removing one needs the grant owner's terminal.`;
  expect.soft(await revoke('en', receipt)).toBe(enWitness);
  expect.soft(await revoke('en', { ...receipt, grant: { status: 'refused', reason: 'APPROVAL_INTERACTIVE_REQUIRED' } })).toBe(enWitness);
  expect.soft(await revoke('tr', receipt)).toBe('fx için güven geri alındı. Sunucuyu başlatmadan önce yeniden onaylayın.\nBu işlem politika izni kaldırmadı. Kaldırma işlemi için izin sahibinin terminali gerekir.');
  const enJson = await revoke('en', receipt, true), trJson = await revoke('tr', receipt, true);
  expect(trJson).toBe(enJson);
  expect(JSON.parse(enJson)).toEqual(receipt);
  const trustOnly = { schemaVersion: 1, revoked: receipt.revoked };
  expect.soft(await revoke('en', trustOnly)).toBe(`${enTrust}\nNo policy grant removal was recorded.`);
  expect.soft(await revoke('tr', trustOnly)).toBe('fx için güven geri alındı. Sunucuyu başlatmadan önce yeniden onaylayın.\nPolitika izni kaldırma işlemi kaydedilmedi.');
  expect(JSON.parse(await revoke('en', trustOnly, true))).toEqual(trustOnly);
  expect.soft(await revoke('en', { ...receipt, grant: { status: 'revoked' } })).toBe(`${enTrust}\nPolicy grant removed: calls to this server follow your company policy again.`);
  expect.soft(await revoke('en', { ...receipt, grant: { status: 'refused', reason: 'delegation' } })).toBe(`${enTrust}\nThe policy grant could not be removed. Review the scope’s policy before trying again.`);
  expect(await revoke('en', { ...receipt, grant: { status: 'refused', reason: 'not-settled' } })).toBe(`${enTrust}\nThe policy grant could not be removed. Review the scope’s policy before trying again.`);
});

it('reports an unfinished requested trust step while retaining the registration receipt', async () => {
  const approve = { schemaVersion: 1, name: 'web', scope: 'local', pinnedTools: 0 };
  const grant = { status: 'refused', reason: 'administer' };
  const registered = (trust: string, scope = 'local') => ({ schemaVersion: 1, added: { name: 'web', scope, file: '/p/mcp.json' }, trust });
  const add = ['add', 'web', 'https://mcp.example.com/mcp'], addJson = ['add-json', 'web', '{"command":"fixture"}'];
  for (const [argv, receipt, expected] of [
    [['approve', 'web'], { ...approve, approved: false }, 1],
    [['approve', 'web'], { ...approve, approved: true }, 0],
    [['approve', 'web'], { ...approve, approved: true, pinnedTools: 1, grant }, 1],
    [add, { ...registered('declined'), pinnedTools: 0 }, 1],
    [addJson, { ...registered('unanswered'), pinnedTools: 0 }, 1],
    [addJson, registered('shadowed'), 1],
    [add, { ...registered('trusted'), pinnedTools: 1 }, 0],
    [add, { ...registered('trusted'), pinnedTools: 1, grant }, 1],
    [addJson, { ...registered('trusted'), pinnedTools: 1, grant }, 1],
    [['remove', 'web'], { schemaVersion: 1, removed: registered('trusted').added, grant: { status: 'refused', reason: 'AUTHORITY_WITNESS_REQUIRED' } }, 1],
    [['remove', 'web'], { schemaVersion: 1, removed: registered('trusted').added, grant: { status: 'revoked' } }, 0],
    [[...add, '--no-approve'], registered('pending'), 0],
    [[...addJson, '--scope', 'project'], registered('pending', 'project'), 0],
  ] as const) {
    const out: string[] = [];
    const code = await main(['mcp', ...argv, '--json'], {
      root: '/p', env: {}, stdout: { write(value: string) { out.push(value); } }, runMcpCommand: async () => receipt,
    } as never);
    expect.soft(code, argv.join(' ')).toBe(expected);
    expect(JSON.parse(out.join(''))).toEqual(receipt);
  }
  const out: string[] = [];
  const code = await main(['mcp', 'remove', 'web', '--lang', 'en'], {
    root: '/p', env: {}, stdout: { write(value: string) { out.push(value); } },
    runMcpCommand: async () => ({ removed: registered('trusted').added, grant: { status: 'refused', reason: 'AUTHORITY_WITNESS_REQUIRED' } }),
  } as never);
  expect.soft(code).toBe(1);
  expect(out.join('').trimEnd()).toBe("Removed web (local)\nThis operation removed no policy grant. Removing one needs the grant owner's terminal.");
  for (const [argv, locale, receipt, expected] of [
    [['approve', 'web'], 'en', { ...approve, approved: false, grant: { status: 'revoked' } },
      'web (local) was not approved; nothing is trusted.\nPolicy grant removed: calls to this server follow your company policy again.'],
    [add, 'en', { ...registered('declined'), grant: { status: 'none' } },
      'Added web (local); you declined its trust, so it does not start.\nNo policy grant removal was recorded.'],
    [addJson, 'tr', { ...registered('unanswered'), grant: { status: 'refused', reason: 'AUTHORITY_WITNESS_REQUIRED' } },
      'web (yerel) eklendi. İlk kullanımda güven onayı ister. Hemen onaylamak için deckent mcp approve web komutunu çalıştırın.\nBu işlem politika izni kaldırmadı. Kaldırma işlemi için izin sahibinin terminali gerekir.'],
  ] as const) {
    out.length = 0;
    expect.soft(await main(['mcp', ...argv, '--lang', locale], {
      root: '/p', env: {}, stdout: { write(value: string) { out.push(value); } }, runMcpCommand: async () => receipt,
    } as never)).toBe(1);
    expect.soft(out.join('').trimEnd()).toBe(expected);
  }
});
