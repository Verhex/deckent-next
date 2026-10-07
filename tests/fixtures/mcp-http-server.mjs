// A real Streamable HTTP MCP server (SDK v2 `createMcpHandler`: 2026-07-28 per-request serving with the stateless 2025 fallback) on the
// loopback interface, for the MCP client tests. Every request's headers are recorded (what reached the server is the evidence); the tool
// `whoami` answers with the Authorization header it received, so a test can prove the client's redaction of an echoed credential.
import { createServer } from 'node:http';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';

export async function startMcpHttpFixture() {
  const requests = [];
  let authorization = null;
  const build = () => {
    const server = new Server({ name: 'deckent-mcp-http-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: [
      { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } },
      { name: 'whoami', description: 'Says which credential it was called with', inputSchema: { type: 'object', properties: {} } }] }));
    server.setRequestHandler('tools/call', async request => request.params.name === 'whoami'
      ? { content: [{ type: 'text', text: `called with: ${authorization}` }] }
      : { content: [{ type: 'text', text: `echo ${JSON.stringify(request.params.arguments ?? {})}` }] });
    return server;
  };
  const handler = createMcpHandler(() => build());
  const http = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    requests.push({ method: incoming.method, url: incoming.url, headers: { ...incoming.headers } });
    authorization = incoming.headers['authorization'] ?? null;
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
    const body = incoming.method === 'GET' || incoming.method === 'HEAD' || incoming.method === 'DELETE' ? undefined : Buffer.concat(chunks);
    const response = await handler.fetch(new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers, body }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) outgoing.write(chunk);
    outgoing.end();
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();
  return { url: `http://127.0.0.1:${port}/mcp`, requests, close: async () => { await handler.close(); await new Promise(resolve => { http.closeAllConnections(); http.close(resolve); }); } };
}
