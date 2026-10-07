import { describe, expect, it } from 'vitest';
import { mcpPanelPort, type McpPanelRequest } from '#surfaces/core/cli-terminal/index.js';
import type { McpTrustQuestion } from '#surfaces/core/terminal-panels/index.js';

// T3 L4 PANELS — `/mcp`: the window's port over the host's registry command (the same handler as `deckent mcp`). It changes nothing itself:
// every action is one registry request; trust cards become the window's questions in the person's language; HTTP waits for its transport.
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
  it('an HTTP draft is refused before any request; revoke is today\'s reset; reconnect and remove are their own requests', async () => {
    const { run, requests } = host({ remove: { removed: { scope: 'project' } } });
    const port = mcpPanelPort('/p', run, {}, 'en');
    expect(await port.add({ transport: 'http', name: 'remote', target: 'https://x', args: [], env: {}, headers: { Authorization: 'Bearer t' }, realm: '', scope: 'local' }, async () => true))
      .toEqual(['HTTP servers cannot be added in this build yet; nothing was written.']);
    expect(requests).toEqual([]);
    expect(port.transports.find(choice => choice.id === 'http')!.blocked).toContain('cannot be added');
    await port.revoke('files'); await port.reconnect('files'); expect(await port.remove('files')).toEqual(['Removed files (project)']);
    expect(requests).toEqual([{ verb: 'reset', name: 'files' }, { verb: 'reconnect', name: 'files' }, { verb: 'remove', name: 'files' }]);
  });
});
