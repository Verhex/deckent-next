import { describe, expect, it } from 'vitest';
import { mcpPanelPort, type McpPanelRequest } from '#surfaces/core/cli-terminal/index.js';
import type { McpTrustQuestion } from '#surfaces/core/terminal-panels/index.js';

// T3 L4 PANELS — `/mcp`: the window's port over the host's registry command (the same handler as `deckent mcp`). It changes nothing itself:
// every action is one registry request; trust cards become the window's questions in the person's language. Integration (L4 ↔ L1): HTTP entries,
// revoke (trust and grant together), the person's real grant in the detail, and the K4 realms with the networked sandbox first.
function host(results: Partial<Record<McpPanelRequest['verb'], unknown>>, cards: unknown[] = []) {
  const requests: McpPanelRequest[] = [], answers: (boolean | null)[] = [];
  const run = async (_root: string, request: McpPanelRequest, _options: unknown, ask: (card: unknown) => Promise<boolean | null>) => {
    requests.push(request);
    for (const card of cards) answers.push(await ask(card));
    return results[request.verb] ?? {};
  };
  return { requests, answers, run };
}
const SERVER = { name: 'files', scope: 'local', file: '/home/u/.deckent/mcp.json', status: 'changed', realm: 'host', command: 'npx', args: ['-y', 'files'], envNames: ['TOKEN'],
  definitionDigest: 'a'.repeat(64), pinnedTools: 2, lastStart: { text: 'files did not start: exit 1', phase: 'launch' } };

describe('/mcp window port', () => {
  it('lists and details from the registry (nothing starts): status, tools, realm, scope, pins, last start; host is a warning', async () => {
    const { run, requests } = host({ list: { servers: [SERVER], problems: [{ name: null, scope: 'project', reason: 'invalid json' }] },
      get: { server: { ...SERVER, trust: { tools: [{ name: 'read_file', digest: 'b'.repeat(64), alwaysAsk: true }] } } } });
    const port = mcpPanelPort('/p', run, {}, 'tr');
    const list = await port.list();
    expect(list.servers).toEqual([{ name: 'files', scope: 'yerel', status: 'onaydan sonra değişti, yeniden onay gerekir', attention: true, tools: '2 araç',
      realm: 'host', launch: 'npx -y files', trusted: false }]);
    expect(list.problems).toEqual(['proje MCP dosyasında sorun: invalid json']);
    expect(requests).toEqual([{ verb: 'list', health: false }]);
    const detail = await port.detail('files');
    const text = detail.map(line => `${line.label}|${line.text}|${line.tone ?? ''}`);
    expect(text).toContain('Çalışır|host: sizin yetkinizle çalışır, dosyalarınıza, ağa ve kimlik bilgilerinize erişir — yalnız güvendiğiniz bir sunucu için seçin|warning');
    expect(text).toContain('|read_file bbbbbbbbbbbb · her zaman sorar|');
    expect(text).toContain('Son başlatma|files did not start: exit 1|warning');
    expect(text.find(line => line.startsWith('Ortam|'))).toBe('Ortam|TOKEN|'); // names only, never values
  });
  it('add maps the wizard to one `add` request (stdio entry; env values only into the entry); the trust cards come back as localized questions', async () => {
    const cards = [{ phase: 'launch', name: 'files', scope: 'user', file: '/g/mcp.json', definitionDigest: 'c'.repeat(64), command: 'npx', args: ['-y', 'files'],
      variables: [{ name: 'HOME_DIR', set: false }], envNames: ['TOKEN'], realm: 'prefer-sandbox' },
    { phase: 'tools', name: 'files', scope: 'user', file: '/g/mcp.json', definitionDigest: 'c'.repeat(64), command: 'npx', args: [], envNames: [], realm: 'prefer-sandbox',
      tools: [{ name: 'read_file', digest: 'd'.repeat(64), description: 'Reads a file', alwaysAsk: false }] }];
    const { run, requests, answers } = host({ add: { added: { name: 'files', scope: 'user', file: '/g/mcp.json' }, trust: 'trusted', pinnedTools: 1 } }, cards);
    const asked: McpTrustQuestion[] = [];
    const lines = await mcpPanelPort('/p', run, {}, 'en').add({ transport: 'stdio', name: 'files', target: 'npx', args: ['-y', 'files'], env: { TOKEN: 's3cret' }, headers: {},
      realm: 'prefer-sandbox', scope: 'user' }, async question => { asked.push(question); return true; });
    expect(requests).toEqual([{ verb: 'add', scope: 'user', name: 'files', approve: true, entry: { type: 'stdio', command: 'npx', args: ['-y', 'files'], env: { TOKEN: 's3cret' }, realm: 'prefer-sandbox' } }]);
    expect(answers).toEqual([true, true]);
    expect(asked.map(question => question.title)).toEqual(['Start the MCP server files to read its tools?', 'Trust files and pin these tools?']);
    expect(asked[0]!.lines.map(line => line.text)).toEqual(expect.arrayContaining(['npx -y files', 'HOME_DIR (not set)', 'TOKEN']));
    expect(JSON.stringify(asked)).not.toContain('s3cret');
    expect(asked[1]!.lines.map(line => line.text)).toContain('read_file dddddddddddd — Reads a file');
    expect(lines).toEqual(['Added files (user): /g/mcp.json', 'files is trusted; 1 tool pinned.']);
  });
  it('an HTTP draft is one `add` of a `type: http` entry with its headers (the registry validates the URL); revoke, reconnect and remove are their own requests', async () => {
    const { run, requests } = host({ add: { added: { name: 'remote', scope: 'local', file: '/p/.deckent/mcp.local.json' }, trust: 'trusted', pinnedTools: 2 }, remove: { removed: { scope: 'project' } } });
    const port = mcpPanelPort('/p', run, {}, 'en');
    expect(await port.add({ transport: 'http', name: 'remote', target: 'https://mcp.example.com/mcp', args: [], env: {}, headers: { Authorization: 'Bearer $DECK:GH' }, realm: '',
      scope: 'local' }, async () => true)).toEqual(['Added remote (local): /p/.deckent/mcp.local.json', 'remote is trusted; 2 tools pinned.']);
    expect(port.transports.find(choice => choice.id === 'http')!.blocked).toBeUndefined();
    expect(await port.revoke('files')).toEqual(['Trust and the tool permission of files were revoked. It does not start until you approve it again.']);
    await port.reconnect('files'); expect(await port.remove('files')).toEqual(['Removed files (project)']);
    expect(requests).toEqual([{ verb: 'add', scope: 'local', name: 'remote', approve: true, entry: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer $DECK:GH' } } },
      { verb: 'revoke', name: 'files' }, { verb: 'reconnect', name: 'files' }, { verb: 'remove', name: 'files' }]);
  });
  it('K4 realms: the networked sandbox comes first (the default of an entry without a realm), host last with its warning; an HTTP server runs nowhere here', async () => {
    const port = mcpPanelPort('/p', host({}).run, {}, 'en');
    expect(port.realms.map(choice => choice.id)).toEqual(['sandbox-net', 'require-sandbox', 'prefer-sandbox', 'host']);
    expect(port.realms[0]!.label).toBe('sandbox with network (default)');
    const { run } = host({ get: { server: { ...SERVER, realm: null, transport: 'http', command: 'https://mcp.example.com/mcp', args: [], headerNames: ['Authorization'], envNames: [] } } });
    const text = (await mcpPanelPort('/p', run, {}, 'tr').detail('remote')).map(line => `${line.label}|${line.text}`);
    expect(text).toContain('Adres (URL)|https://mcp.example.com/mcp');
    expect(text).toContain('Başlıklar|Authorization');
    expect(text).toContain('Çalışır|uzak: başka bir makinedeki HTTP sunucusu; burada hiçbir şey çalışmaz');
  });
  it('the detail names the person\'s real mcp-server grant (owner 2026-10-07): its scope, or none', async () => {
    const lineOf = async (grant: unknown) => (await mcpPanelPort('/p', host({ get: { server: { ...SERVER, grant } } }).run, {}, 'en').detail('files'))
      .find(line => line.label === 'Policy grant')!;
    expect((await lineOf({ status: 'granted', scopes: ['proj'] })).text).toBe('yours for this server in proj: standart asks every call, full-auto runs it (audited)');
    expect((await lineOf({ status: 'granted', scopes: 'all' })).text).toContain('in all your scopes');
    expect(await lineOf({ status: 'none' })).toMatchObject({ text: expect.stringContaining('none: trusting it writes your grant'), tone: 'muted' });
    expect(await lineOf(undefined)).toMatchObject({ tone: 'muted' });
  });
});
