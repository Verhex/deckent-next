import { Readable } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import { main } from '#surfaces/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

/*
 * C-MODELS (alpha.48, owner CLI review 2026-10-19 `mcp`; owner A48-D5 + A48-D6): `deckent mcp` reads like a person expects and every trust
 * decision is a person's card. A person's card is simulated here (the Ink view is PTY-proven on the built binary); every other caller goes
 * through the real mode decision. Trust is never decided off a terminal, `--yes` included; listing never starts a server; `--check` starts
 * trusted servers only.
 */
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

const capture = () => { const lines: string[] = []; return { text: () => lines.join(''), sink: { write: (text: string) => { lines.push(String(text)); return true; } } }; };
const piped = () => Object.assign(Readable.from([]), { isTTY: false });
const server = (name: string, status: string, extra: Record<string, unknown> = {}) => ({ name, scope: 'local', file: '/h/.deckent/mcp.json', status, shadows: [], realm: 'sandbox',
  transport: 'stdio', command: 'npx', args: ['-y', `@example/${name}`], envNames: [], headerNames: [], definitionDigest: 'a'.repeat(64), pinnedTools: status === 'trusted' ? 2 : 0, ...extra });
function host(listed: unknown[] = [], language = 'en', env: Record<string, string> = {}) {
  const requests: Record<string, unknown>[] = [], out = capture(), err = capture();
  const context = { root: '/p', env: { DECKENT_LANGUAGE: language, NO_COLOR: '1', ...env }, stdin: piped(), stdout: out.sink, stderr: err.sink,
    async runMcpCommand(_root: string, request: Record<string, unknown>, _options: unknown, ask: (card: unknown) => Promise<boolean | null>) {
      requests.push(request);
      if (request['verb'] === 'list') return { schemaVersion: 1, servers: listed.map(entry => request['health'] === false ? { ...entry as object, health: 'not-started' } : entry), problems: [] };
      if (request['verb'] === 'approve') {
        const launch = await ask({ phase: 'launch', name: request['name'], scope: 'local', transport: 'stdio', command: 'npx', args: ['-y', '\u001b[31mevil'], realm: 'sandbox', envNames: ['TOKEN'],
          headerNames: [], variables: [], posture: 'sandbox', note: null });
        return { schemaVersion: 1, approved: launch === true, name: request['name'], scope: 'local', pinnedTools: launch ? 1 : 0 };
      }
      if (request['verb'] === 'add') { const decided = request['approve'] === false ? null : await ask({ phase: 'launch', name: request['name'], scope: request['scope'], transport: 'stdio', command: 'node',
        args: ['srv.js'], realm: 'host', envNames: ['API_KEY'], headerNames: [], variables: [], posture: 'host', note: null });
      return { schemaVersion: 1, added: { name: request['name'], scope: request['scope'], file: '/h/.deckent/mcp.json' }, trust: decided === null ? 'pending' : decided ? 'trusted' : 'declined', pinnedTools: 0 }; }
      return { schemaVersion: 1 };
    } };
  return { requests, out, err, context: context as never };
}

it('trust off a terminal is refused before anything is asked or written, --yes included (owner A48-D5/D6: AI and MCP never decide)', async () => {
  for (const argv of [['mcp', 'approve', 'fx', '--yes'], ['mcp', 'approve', 'fx'], ['mcp', 'add', '--yes', 'fx', '--', 'node', 'srv.js'], ['mcp', 'add-json', '--yes', 'fx', '{"command":"node"}'],
    ['mcp', 'add', '--scope', 'user', '--yes', 'fx', '--', 'node', 'srv.js']]) {
    const h = host();
    expect(await main(argv, h.context), argv.join(' ')).toBe(2);
    expect(h.err.text()).toContain('MCP_APPROVAL_NEEDS_TERMINAL');
    expect(h.err.text()).not.toMatch(/pass --yes/u);
    expect(h.requests, argv.join(' ')).toEqual([]);
  }
  // An AI agent on a real terminal is still not a person: refused, nothing sent.
  const agent = host([], 'en', { CLAUDECODE: '1' });
  Object.assign((agent.context as { stdin: { isTTY: boolean } }).stdin, { isTTY: true });
  expect(await main(['mcp', 'approve', 'fx', '--yes'], agent.context)).toBe(2);
  expect(agent.requests).toEqual([]);
  // Adding without a trust decision stays scriptable: the entry lands untrusted and asks on first use.
  const scripted = host();
  expect(await main(['mcp', 'add', '--no-approve', 'fx', '--', 'node', 'srv.js'], scripted.context)).toBe(0);
  expect(scripted.requests).toEqual([expect.objectContaining({ verb: 'add', approve: false })]);
});

it('a person on a terminal decides on the card (arrow keys), --yes never skips it; the card lines are terminal-safe, one argument per line', async () => {
  card.interactive = true; card.answers = ['yes'];
  const h = host();
  expect(await main(['mcp', 'approve', 'fx', '--yes'], h.context)).toBe(0);
  expect(card.asked).toHaveLength(1);
  const body = (card.asked[0]!.body ?? []).join('\n');
  expect(body).toContain('npx'); expect(body).toMatch(/2: \\u001b\[31mevil|2: .*evil/u); expect(body).not.toContain('\u001b');
  expect(card.asked[0]!.options.map(option => option.id)).toEqual(['yes', 'no']);
  expect(h.requests).toEqual([{ verb: 'approve', name: 'fx' }]);
  // A cancelled card (Esc, Ctrl+C) answers nothing: the adapter records nothing for null.
  card.answers = [null];
  const cancelled = host();
  expect(await main(['mcp', 'approve', 'fx'], cancelled.context)).toBe(0);
  expect(cancelled.out.text()).not.toMatch(/approved: true/u);
});

it('mcp and mcp list: a table, waiting servers first with their next step, nothing started; JSON only with --json (EN, TR)', async () => {
  const listed = [server('context7', 'trusted'), server('filesystem', 'pending-approval'), server('old', 'pending-approval', { reason: 'trust-moved' })];
  for (const argv of [['mcp'], ['mcp', 'list']]) {
    const h = host(listed);
    expect(await main(argv, h.context)).toBe(0);
    expect(h.requests).toEqual([{ verb: 'list', health: false }]);
    const text = h.out.text();
    expect(text).not.toMatch(/[{}]/u);
    expect(text).toMatch(/Name\s+Scope\s+State\s+Connection\s+Command \/ URL/u);
    expect(text.indexOf('filesystem')).toBeLessThan(text.indexOf('context7'));
    expect(text).toContain('deckent mcp approve filesystem');
    expect(text).toContain('deckent mcp approve old');
    expect(text).toMatch(/old.*approve again on its card/u);
    expect(text).toContain('npx -y @example/context7');
    expect(text).toContain('not checked');
  }
  const json = host(listed);
  expect(await main(['mcp', 'list', '--json'], json.context)).toBe(0);
  expect(JSON.parse(json.out.text())).toMatchObject({ servers: [{ name: 'context7' }, { name: 'filesystem' }, { name: 'old', reason: 'trust-moved' }] });
  const tr = host(listed, 'tr');
  expect(await main(['mcp', 'list'], tr.context)).toBe(0);
  expect(tr.out.text()).toMatch(/Ad\s+Kapsam\s+Durum\s+Bağlantı\s+Komut \/ URL/u);
  expect(tr.out.text()).toContain('onay bekliyor');
});

it('--check asks the host to start trusted servers only and shows their connection; waiting servers are never started', async () => {
  const listed = [server('context7', 'trusted', { health: 'connected' }), server('filesystem', 'pending-approval', { health: 'not-started' })];
  const h = host(listed);
  expect(await main(['mcp', 'list', '--check'], h.context)).toBe(0);
  expect(h.requests).toEqual([{ verb: 'list' }]);
  expect(h.out.text()).toMatch(/context7.*connected/u);
  expect(h.out.text()).toMatch(/filesystem.*not started: not trusted/u);
});

it('the add form on a terminal: name and command typed (owner exception), scope picked, a preview card with realm and env before anything is written', async () => {
  card.interactive = true; card.answers = ['local', 'apply', 'yes'];
  const h = host(), { PassThrough } = await import('node:stream'), stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
  Object.assign(h.context as object, { stdin });
  const done = main(['mcp', 'add'], h.context);
  setTimeout(() => stdin.write('docs\n'), 20); setTimeout(() => stdin.write('node srv.js --port 3\n'), 60);
  expect(await done).toBe(0);
  const preview = card.asked[1]!;
  expect(preview.title).toContain('docs');
  expect(preview.body?.join('\n')).toMatch(/Runs in: the default sandbox/u);
  expect(preview.body?.join('\n')).toMatch(/Environment names: none/u);
  expect(preview.body?.join('\n')).toMatch(/argument 2: --port/u);
  expect(h.requests).toEqual([{ verb: 'add', scope: 'local', name: 'docs', approve: true, entry: { type: 'stdio', command: 'node', args: ['srv.js', '--port', '3'] } }]);
  // Cancelling the preview card writes nothing.
  card.answers = ['local', 'cancel'];
  const cancelled = host(), again = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
  Object.assign(cancelled.context as object, { stdin: again });
  const pending = main(['mcp', 'add'], cancelled.context);
  setTimeout(() => again.write('docs\n'), 20); setTimeout(() => again.write('https://mcp.example.com/mcp\n'), 60);
  expect(await pending).not.toBe(0);
  expect(cancelled.requests).toEqual([]);
});
