import { describe, expect, it, vi } from 'vitest';
import * as pool from '#adapters/core/mcp-client/index.js';

const APPROVED = 'https://mcp.example.test:8443/mcp';
const HEADERS = Object.freeze({ Authorization: 'Bearer resolved-DECK-secret', 'Content-Type': 'application/json', 'X-MCP': 'unchanged' });
const BODY = '{"jsonrpc":"2.0","method":"tools/call","params":{"secret":"private-call-body"},"id":1}';
const INIT = Object.freeze({ method: 'POST', headers: HEADERS, body: BODY, redirect: 'follow' as const });
const redirect = (status: number, location?: string) => new Response(null, { status, headers: location === undefined ? {} : { Location: location } });
function stub(...responses: Response[]) {
  const fetchStub = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected request beyond the stub responses'));
  for (const response of responses) fetchStub.mockResolvedValueOnce(response);
  return fetchStub;
}
const targets = (fetchStub: ReturnType<typeof stub>) => fetchStub.mock.calls.map(([input]) => input instanceof Request ? input.url : String(input));
function unchanged(fetchStub: ReturnType<typeof stub>, init = INIT) {
  for (const [, options] of fetchStub.mock.calls) {
    expect(options).toEqual({ ...init, redirect: 'manual' });
    expect(options?.headers).toBe(init.headers);
    expect(options?.body).toBe(init.body);
  }
  expect(init.redirect).toBe('follow');
}
async function refusal(request: Promise<Response>, reason: string) {
  const error = await request.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(pool.McpRedirectRefusedError);
  expect(error).toMatchObject({ name: 'McpRedirectRefusedError', code: 'MCP_REDIRECT_REFUSED', reason, message: `MCP_REDIRECT_REFUSED: ${reason}` });
  expect((error as Error).message).not.toContain('resolved-DECK-secret');
  expect((error as Error).message).not.toContain('private-call-body');
}

describe('MCP bounded manual redirects (stub fetch only)', () => {
  it.each([307, 308])('follows same-origin %s with the original method, headers and body, overriding automatic redirects', async status => {
    const answer = new Response('answer'), fetchStub = stub(redirect(status, '/next'), answer);
    expect(await (await pool.createMcpRedirectFetch(APPROVED, fetchStub)(new URL(APPROVED), INIT)).text()).toBe('answer');
    expect(targets(fetchStub)).toEqual([APPROVED, 'https://mcp.example.test:8443/next']);
    unchanged(fetchStub);
  });

  it('resolves every relative Location against the current URL and accepts exactly three hops', async () => {
    const answer = new Response('answer'), fetchStub = stub(redirect(307, './a/step'), redirect(308, '../b/step'), redirect(307, '?done=1'), answer);
    expect(await (await pool.createMcpRedirectFetch(APPROVED, fetchStub)(APPROVED, INIT)).text()).toBe('answer');
    expect(targets(fetchStub)).toEqual([APPROVED, 'https://mcp.example.test:8443/a/step', 'https://mcp.example.test:8443/b/step', 'https://mcp.example.test:8443/b/step?done=1']);
    unchanged(fetchStub);
  });

  it('preserves inherited method, headers and consumed body when the input is a Request', async () => {
    const answer = new Response('answer'), seen: unknown[] = [];
    const fetchStub = vi.fn<typeof fetch>(async (input, options) => {
      expect(input).toBeInstanceOf(Request);
      const request = input as Request;
      seen.push({ method: request.method, headers: [...request.headers], body: await request.text(), redirect: request.redirect });
      expect(options?.redirect).toBe('manual');
      return seen.length === 1 ? redirect(307, '/next') : answer;
    });
    const original = new Request(APPROVED, INIT);
    expect(await (await pool.createMcpRedirectFetch(APPROVED, fetchStub)(original)).text()).toBe('answer');
    expect(targets(fetchStub)).toEqual([APPROVED, 'https://mcp.example.test:8443/next']);
    const expected = { method: INIT.method, headers: [...new Headers(HEADERS)], body: BODY, redirect: 'manual' };
    expect(seen).toEqual([expected, expected]);
  });

  it('keeps GET requests manual and bounds HTTP bytes before consumption, including cancellation', async () => {
    const answer = new Response('answer'), fetchStub = stub(redirect(308, '/next'), answer);
    expect(await (await pool.createMcpRedirectFetch(APPROVED, fetchStub)(APPROVED)).text()).toBe('answer');
    const cap = 65_536, chunkBytes = 4_096;
    for (const length of [cap - 1, cap, cap + 1, 1_073_741_824]) {
      let produced = 0, cancelled = 0; const memoryBefore = process.memoryUsage();
      const body = new ReadableStream<Uint8Array>({ pull(controller) {
        if (produced === length) { controller.close(); return; }
        const bytes = Math.min(chunkBytes, length - produced); produced += bytes; controller.enqueue(new Uint8Array(bytes).fill(32));
      }, cancel() { cancelled++; } }, { highWaterMark: 0 });
      const response = await pool.createMcpRedirectFetch(APPROVED, stub(new Response(body, { headers: { 'Content-Length': '1' } })), cap)(APPROVED);
      if (length <= cap) { expect((await response.arrayBuffer()).byteLength).toBe(length); expect(cancelled).toBe(0); }
      else { await expect(response.arrayBuffer()).rejects.toMatchObject({ code: 'MCP_HTTP_RESPONSE_TOO_LARGE', maxBytes: cap }); expect(cancelled).toBe(1); }
      expect(produced).toBeLessThanOrEqual(cap + chunkBytes);
      console.info('MCP_HTTP_BOUND', JSON.stringify({ length, cap, produced, cancelled, heapDelta: process.memoryUsage().heapUsed - memoryBefore.heapUsed, externalDelta: process.memoryUsage().external - memoryBefore.external }));
    }
    let cancelled = false, reads = 0;
    const oversized = new Response(new ReadableStream({ pull() { reads++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { headers: { 'Content-Length': String(cap + 1) } });
    await expect(pool.createMcpRedirectFetch(APPROVED, stub(oversized), cap)(APPROVED)).rejects.toMatchObject({ code: 'MCP_HTTP_RESPONSE_TOO_LARGE' });
    expect({ reads, cancelled }).toEqual({ reads: 0, cancelled: true });
    const utf8 = await pool.createMcpRedirectFetch(APPROVED, stub(new Response('☃')), 2)(APPROVED);
    await expect(utf8.text()).rejects.toMatchObject({ code: 'MCP_HTTP_RESPONSE_TOO_LARGE' });
    let downstreamCancelled = false;
    const downstream = await pool.createMcpRedirectFetch(APPROVED, stub(new Response(new ReadableStream({ cancel() { downstreamCancelled = true; } }))))(APPROVED);
    await downstream.body!.cancel(); expect(downstreamCancelled).toBe(true);
    expect(targets(fetchStub)).toEqual([APPROVED, 'https://mcp.example.test:8443/next']);
    expect(fetchStub.mock.calls.map(([, options]) => options)).toEqual([{ redirect: 'manual' }, { redirect: 'manual' }]);
  });

  it('pins the approved server origin rather than trusting a different initial request URL', async () => {
    const fetchStub = stub();
    await refusal(pool.createMcpRedirectFetch(APPROVED, fetchStub)('https://other.example.test/mcp', INIT), 'cross-origin');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each([307, 308])('refuses the fourth %s hop without sending to its target', async status => {
    const fetchStub = stub(...[1, 2, 3, 4].map(hop => redirect(status, `/hop-${hop}`)));
    await refusal(pool.createMcpRedirectFetch(APPROVED, fetchStub)(APPROVED, INIT), 'hop-limit');
    expect(targets(fetchStub)).toEqual([APPROVED, ...[1, 2, 3].map(hop => `https://mcp.example.test:8443/hop-${hop}`)]);
    unchanged(fetchStub);
  });

  it.each([300, 301, 302, 303, 304, 305, 306, 309, 399])('refuses status %s even with a same-origin Location', async status => {
    const fetchStub = stub(redirect(status, '/refused'));
    await refusal(pool.createMcpRedirectFetch(APPROVED, fetchStub)(APPROVED, INIT), `status-${status}`);
    expect(targets(fetchStub)).toEqual([APPROVED]);
    unchanged(fetchStub);
  });

  it.each([
    ['cross-host', 'https://other.example.test:8443/refused'],
    ['protocol-relative cross-host', '//other.example.test:8443/refused'],
    ['hostname suffix', 'https://mcp.example.test.attacker.test:8443/refused'],
    ['https to http', 'http://mcp.example.test:8443/refused'],
    ['port change', 'https://mcp.example.test:9443/refused'],
    ['implicit port change', 'https://mcp.example.test/refused'],
  ])('refuses %s before any request reaches the new origin', async (_label, location) => {
    const fetchStub = stub(redirect(307, '/allowed'), redirect(308, location));
    await refusal(pool.createMcpRedirectFetch(APPROVED, fetchStub)(APPROVED, INIT), 'cross-origin');
    expect(targets(fetchStub)).toEqual([APPROVED, 'https://mcp.example.test:8443/allowed']);
    unchanged(fetchStub);
  });

  it('refuses a downgrade even on loopback, where the endpoint guard alone would allow http', async () => {
    const approved = 'https://localhost:8443/mcp', fetchStub = stub(redirect(308, 'http://localhost:8443/refused'));
    await refusal(pool.createMcpRedirectFetch(approved, fetchStub)(approved, INIT), 'cross-origin');
    expect(targets(fetchStub)).toEqual([approved]);
  });

  it.each([307, 308])('rechecks each %s target with mcpEndpointRefusal: same-origin URL credentials are refused', async status => {
    const fetchStub = stub(redirect(status, '/allowed'), redirect(status, 'https://user:password@mcp.example.test:8443/refused'));
    await refusal(pool.createMcpRedirectFetch(APPROVED, fetchStub)(APPROVED, INIT), 'url-credentials');
    expect(targets(fetchStub)).toEqual([APPROVED, 'https://mcp.example.test:8443/allowed']);
    unchanged(fetchStub);
  });

  it.each([307, 308])('refuses a missing Location on %s', async status => {
    const fetchStub = stub(redirect(status));
    await refusal(pool.createMcpRedirectFetch(APPROVED, fetchStub)(APPROVED, INIT), 'missing-location');
    expect(targets(fetchStub)).toEqual([APPROVED]);
  });

  it.each(['', '   ', 'https://[invalid', 'https://mcp.example.test:invalid/'])('refuses empty or invalid Location %j', async location => {
    const fetchStub = stub(redirect(307, location));
    await refusal(pool.createMcpRedirectFetch(APPROVED, fetchStub)(APPROVED, INIT), location.trim() ? 'invalid-location' : 'missing-location');
    expect(targets(fetchStub)).toEqual([APPROVED]);
  });

  it.each([200, 201, 204, 400, 404, 500])('returns non-3xx %s unchanged, ignoring any Location', async status => {
    const answer = new Response(null, { status, headers: { Location: 'https://other.example.test/refused', 'X-Passthrough': 'yes' } }), fetchStub = stub(answer);
    expect(await pool.createMcpRedirectFetch(APPROVED, fetchStub)(APPROVED, INIT)).toBe(answer);
    expect(targets(fetchStub)).toEqual([APPROVED]);
    unchanged(fetchStub);
  });
});
