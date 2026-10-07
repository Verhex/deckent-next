import { describe, expect, it } from 'vitest';
import type { Locale } from '#platform/index.js';
import { mcpSlash } from '#surfaces/core/cli/index.js';
import type { CommandContext } from '#surfaces/core/cli/index.js';

// TUI2 L3: /mcp speaks one language per locale and says what each server's state means; no raw status names or "!" markers remain.
const servers = [
  { name: 'context7', scope: 'user', status: 'trusted', command: 'npx', args: ['-y', 'ctx7'], pinnedTools: 2 },
  { name: 'solo', scope: 'project', status: 'trusted', command: 'node', args: ['solo.mjs'], pinnedTools: 1 },
  { name: 'fx', scope: 'local', status: 'pending-approval', command: 'node', args: ['fx.mjs'], pinnedTools: 0 },
  { name: 'gone', scope: 'local', status: 'trusted', command: 'node', args: ['gone.mjs'], pinnedTools: 0, lastStart: { text: 'REASON-TEXT' } },
  { name: 'moved', scope: 'user', status: 'changed', command: 'node', args: [], pinnedTools: 3 }];
const context = (list: unknown) => ({ runMcpCommand: async () => list }) as unknown as CommandContext;
const run = (locale: Locale, args = '', list: unknown = { servers, problems: [{ name: null, scope: 'project', reason: 'bad json' }, { name: 'broken', scope: 'user', reason: 'no command' }] }) =>
  mcpSlash('/unused', args, context(list), {}, locale);

describe('/mcp human output', () => {
  it('EN', async () => {
    expect(await run('en')).toEqual(['MCP servers of this project: 5', '  context7 · user · trusted · 2 tools · npx -y ctx7', '  solo · project · trusted · 1 tool · node solo.mjs',
      '  fx · local · waiting for approval · node fx.mjs', '  gone · local · trusted · did not start · node gone.mjs', '    REASON-TEXT',
      '  moved · user · changed since approval, needs approval again · 3 tools · node', '  Problem in the project MCP file: bad json', '  Problem with broken (user): no command',
      '  Servers waiting for approval ask for trust the first time a message uses them.']);
  });
  it('TR', async () => {
    expect(await run('tr')).toEqual(['Bu projenin MCP sunucuları: 5', '  context7 · kullanıcı · güvenilir · 2 araç · npx -y ctx7', '  solo · proje · güvenilir · 1 araç · node solo.mjs',
      '  fx · yerel · onay bekliyor · node fx.mjs', '  gone · yerel · güvenilir · başlatılamadı · node gone.mjs', '    REASON-TEXT',
      '  moved · kullanıcı · onaydan sonra değişti, yeniden onay gerekir · 3 araç · node', '  proje MCP dosyasında sorun: bad json', '  broken (kullanıcı) için sorun: no command',
      '  Onay bekleyen sunucular, bir mesajda ilk kullanıldıklarında güven ister.']);
  });
  it('maps every trust status to words, never to the raw status name', async () => {
    for (const locale of ['en', 'tr'] as const) {
      const statuses = ['trusted', 'pending-approval', 'changed', 'declined', 'invalid-launch', 'trust-store-unavailable'];
      const lines = await run(locale, '', { servers: statuses.map(status => ({ name: status, scope: 'local', status, command: 'c', args: [], pinnedTools: 0 })), problems: [] });
      for (const [index, status] of statuses.entries()) if (!(locale === 'en' && ['trusted', 'declined'].includes(status))) expect(lines[index + 1]!.split(' · ')[2]).not.toBe(status);
    }
  });
  it('answers the empty list, the verbs and a bad call in the locale', async () => {
    expect(await run('en', '', { servers: [], problems: [] })).toEqual(['No MCP server is registered for this project. Add one with: deckent mcp add …']);
    expect(await run('tr', '', { servers: [], problems: [] })).toEqual(['Bu proje için kayıtlı MCP sunucusu yok. Eklemek için: deckent mcp add …']);
    expect(await run('tr', 'approve fx', {})).toEqual(['fx için güven sıfırlandı. Onay kartı bir sonraki mesajınızda açılacak.']);
    expect(await run('en', 'reconnect fx', {})).toEqual(['fx restarts the next time it is used']);
    expect(await run('tr', 'remove fx', { removed: { scope: 'user' } })).toEqual(['fx kaldırıldı (kullanıcı)']);
    expect(await run('en', 'frobnicate')).toEqual(['Usage: /mcp [list] | /mcp approve|reconnect|remove <name>']);
  });
});
