// A real local MCP server over stdio (SDK v2), for the MCP client tests. `--mode legacy` answers only the 2025-11-25 `initialize`
// handshake (no `server/discover`); `dual` serves both eras (`serveStdio`); `modern` refuses 2025-era openings. The tool list is read from
// `--tools <json>` on every `tools/list` (a test edits the file to change a definition under a running server); every start and call is
// appended to `--log <jsonl>` (what reached the server is the evidence, never the client's claim).
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Server } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const { values } = parseArgs({ options: { mode: { type: 'string' }, tools: { type: 'string' }, log: { type: 'string' }, 'page-size': { type: 'string' }, endless: { type: 'boolean' } }, strict: true });
const mode = values.mode ?? 'dual';
const log = event => appendFileSync(values.log, `${JSON.stringify({ ...event, pid: process.pid })}\n`);
const definitions = () => JSON.parse(readFileSync(values.tools, 'utf8'));
log({ event: 'start', mode });
process.stderr.write('fixture stderr: token=abcdef0123456789abcdef\n');

function build() {
  const server = new Server({ name: 'deckent-mcp-fixture', version: '1.0.0' }, { capabilities: { tools: {} },
    ...(mode === 'legacy' ? { supportedProtocolVersions: ['2025-11-25', '2025-06-18'] } : {}) });
  // `--page-size N` serves `tools/list` in pages (an opaque numeric cursor); `--endless` never stops sending a cursor (a hostile server).
  server.setRequestHandler('tools/list', async request => {
    const all = definitions().map(tool => Object.fromEntries(Object.entries(tool).filter(([key]) => key !== 'behavior')));
    const size = values['page-size'] ? Number(values['page-size']) : 0, cursor = request.params?.cursor;
    log({ event: 'list', cursor: cursor ?? null });
    if (!size) return { tools: all };
    const from = cursor ? Number(cursor) : 0, page = all.slice(from, from + size);
    return { tools: values.endless ? all.slice(0, size).map(tool => ({ ...tool, name: `${tool.name}_${from}` })) : page,
      ...(values.endless || from + size < all.length ? { nextCursor: String(from + size) } : {}) };
  });
  server.setRequestHandler('tools/call', async (request, context) => {
    const tool = definitions().find(entry => entry.name === request.params.name);
    log({ event: 'call', name: request.params.name, arguments: request.params.arguments ?? {} });
    const behavior = tool?.behavior ?? 'echo';
    if (behavior === 'crash') process.exit(3);
    if (behavior === 'slow') {
      await new Promise(resolve => { const timer = setTimeout(resolve, 30_000); context.mcpReq.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }); });
      log({ event: 'slow-ended', aborted: context.mcpReq.signal?.aborted === true });
      return { content: [{ type: 'text', text: 'late' }] };
    }
    if (behavior === 'fail') return { isError: true, content: [{ type: 'text', text: 'the fixture tool failed' }] };
    if (behavior === 'big') return { content: [{ type: 'text', text: `${'x'.repeat(200_000)}\nsecret=abcdef0123456789abcdef` }] };
    if (behavior === 'image') return { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('png-bytes').toString('base64') }] };
    return { content: [{ type: 'text', text: `echo ${JSON.stringify(request.params.arguments ?? {})}\napi_key=abcdef0123456789abcdef` }] };
  });
  return server;
}

if (mode === 'legacy') await build().connect(new StdioServerTransport());
else serveStdio(() => build(), mode === 'modern' ? { legacy: 'reject' } : {});
