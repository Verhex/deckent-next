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
  expect(en.text).toContain('Policy grant written: this server is yours to call');
  expect(en.text).not.toMatch(/grant:\s*\{/u);
  const tr = await run('tr', { status: 'refused', reason: 'administer' });
  expect(tr.text).toContain('Başlıklar: Authorization');
  expect(tr.text).toContain('Güvenildi ama policy grant\'i yazılmadı: policy\'niz policy kurallarını değiştirmenize izin vermiyor');
});
