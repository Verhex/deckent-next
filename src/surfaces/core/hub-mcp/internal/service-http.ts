import { z } from 'zod';
import { HUB_LIMITS, canonicalHubJson, hubPackageIdSchema, hubVersionSchema } from '#domain/index.js';
import { HubServerError, type HubModeratedApplication, type HubServerContext, type HubServerPeer } from '#engine/index.js';
import { t, type Locale } from '#platform/index.js';
import { executeHubService } from './service-methods.js';
import { INPUT_VALIDATION_LIMITS, inputWithinValidationLimit } from '#platform/index.js';

export interface HubServiceHttpOptions {
  readonly endpoint: string; readonly locale?: Locale;
  /** Trusted listener derives this opaque HMAC id from the socket peer, never a forwarded client header. */
  readonly addressId: (request: Request, peer?: HubServerPeer) => string;
  /** Public read still passes the existing installation policy; no implicit authority grant. */
  readonly publicContext: HubServerContext;
}
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
/** Same read API for HTML and JSON; no cookies, inline scripts, client supplied authority or raw personal data. */
export function createHubServiceHttpHandler(app: HubModeratedApplication, options: HubServiceHttpOptions) {
  const endpoint = new URL(options.endpoint);
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search || endpoint.pathname !== '/'
    || endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new HubServerError('HUB_STORE_UNSAFE');
  const headers = { 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
  const html = (content: string) => new Response(`<!doctype html><html lang="${options.locale ?? 'en'}"><meta charset="utf-8"><title>${escape(t('hub.page.title', {}, options.locale))}</title><body><h1>${escape(t('hub.page.title', {}, options.locale))}</h1>${content}</body></html>`,
    { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
  const json = (value: unknown) => new Response(canonicalHubJson(value), { headers: { ...headers, 'content-type': 'application/json' } });
  const serve = async (request: Request, peer?: HubServerPeer): Promise<Response> => {
      const signal = request.signal;
      try {
        const url = new URL(request.url), origin = request.headers.get('origin');
        if (url.origin !== endpoint.origin || request.headers.has('host') && request.headers.get('host') !== endpoint.host
          || origin !== null && origin !== endpoint.origin || url.hash) return new Response(null, { status: 403, headers });
        const addressId = options.addressId(request, peer);
        if (!/^[a-f0-9]{64}$/.test(addressId)) throw new HubServerError('HUB_SERVER_DENIED');
        await app.publicLimit(addressId, url.pathname === '/' || url.pathname === '/packages' || url.pathname === '/api/packages');
        if (request.method === 'GET') {
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : HUB_LIMITS.searchPageMax, after = url.searchParams.get('after') ?? '';
          if (url.pathname === '/' || url.pathname === '/' || url.pathname === '/packages' || url.pathname === '/api/packages') {
            const rows = await app.search(options.publicContext, after, limit);
            if (url.pathname === '/api/packages') return json(rows);
            return html(`<h2>${escape(t('hub.page.packages', {}, options.locale))}</h2><ul>${rows.map(row => `<li><a href="/packages/${row.manifest.packageId.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(row.manifest.version)}">${escape(row.manifest.title)}</a> ${escape(row.manifest.version)}${row.manifest.provenance.authoredBy.kind !== 'person' ? ` — ${escape(t('hub.page.ai', {}, options.locale))}` : ''}</li>`).join('')}</ul>`);
          }
          if (url.pathname === '/api/moderation-log') return json(await app.publicLog(options.publicContext, Number(after || 0), limit));
          if (url.pathname === '/api/moderators') return json(await app.moderatorRoster(options.publicContext));
          const path = url.pathname.split('/').slice(1).map(decodeURIComponent);
          if (path[0] === 'profiles' && path.length === 2 || path[0] === 'api' && path[1] === 'profile' && path.length === 3) {
            const profile = await app.publicProfile(options.publicContext, path.at(-1)!);
            if (path[0] === 'api') return json(profile);
            return html(`<h2>${escape(profile.displayName)}</h2><p>@${escape(profile.handle)}</p><ul>${profile.verifiedDomains.map(domain => `<li>${escape(domain)}</li>`).join('')}</ul>`);
          }
          if ((path[0] === 'packages' || path[0] === 'api' && path[1] === 'package') && path.length === (path[0] === 'api' ? 5 : 4)) {
            const offset = path[0] === 'api' ? 2 : 1, packageId = hubPackageIdSchema.parse(`${path[offset]}/${path[offset + 1]}`), version = hubVersionSchema.parse(path[offset + 2]);
            const row = await app.inspect(options.publicContext, packageId, version), evidence = await app.evidence(options.publicContext, packageId, version);
            if (path[0] === 'api') return json({ ...row, evidence });
            return html(`<h2>${escape(row.manifest.title)}</h2><p>${escape(row.manifest.description)}</p><p>${escape(version)}</p><a href="/profiles/${encodeURIComponent(evidence.profile.handle)}">@${escape(evidence.profile.handle)}</a>${row.manifest.provenance.authoredBy.kind !== 'person' ? `<p>${escape(t('hub.page.ai', {}, options.locale))}</p>` : ''}`);
          }
          return new Response(null, { status: 404, headers });
        }
        if (request.method !== 'POST' || url.search) return new Response(null, { status: 405, headers });
        if (!request.headers.get('content-type')?.startsWith('application/json')) return new Response(null, { status: 415, headers });
        const reader = request.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
        const cancel = () => { void reader?.cancel().catch(() => undefined); };
        signal.addEventListener('abort', cancel, { once: true });
        if (reader) try {
          for (;;) {
            signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
            bytes += next.value.length; if (bytes > HUB_LIMITS.httpMaxBytes) { await reader.cancel(); return new Response(null, { status: 413, headers }); }
            chunks.push(next.value);
          }
        } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
        if (!reader) signal.removeEventListener('abort', cancel);
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); signal.throwIfAborted();
        if (!inputWithinValidationLimit(input, INPUT_VALIDATION_LIMITS.hubService)) return new Response(null, { status: 413, headers });
        if (url.pathname === '/api/login/begin') {
          const p = z.object({ providerId: z.string() }).strict().parse(input); return json(await app.accounts.begin(p.providerId, addressId));
        }
        if (url.pathname === '/api/login') {
          const p = z.object({ challengeId: z.string(), identity: z.unknown() }).strict().parse(input); return json(await app.accounts.login(p.challengeId, p.identity, signal));
        }
        const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1];
        if (!token) return new Response(null, { status: 401, headers });
        const p = z.object({ operation: z.string(), input: z.unknown() }).strict().parse(input);
        const context = await app.session(token, p.operation === 'report.create');
        if (url.pathname !== '/api/service') return new Response(null, { status: 404, headers });
        return json(await executeHubService(app, context, p.operation, p.input, signal));
      } catch (error) {
        if (signal.aborted) return new Response(null, { status: 504, headers });
        if (error instanceof HubServerError) return new Response(canonicalHubJson({ code: error.code }), { status: error.code === 'HUB_RESOURCE_UNKNOWN' ? 404 : error.code === 'HUB_RATE_REFUSED' ? 429 : 403, headers });
        return new Response(null, { status: 400, headers });
      }
  };
  return {
    async fetch(incoming: Request, peer?: HubServerPeer): Promise<Response> {
      const signal = AbortSignal.any([incoming.signal, AbortSignal.timeout(HUB_LIMITS.fetchTimeoutMs)]);
      let abort!: () => void;
      try {
        return await Promise.race([serve(new Request(incoming, { signal }), peer), new Promise<Response>(resolve => {
          abort = () => resolve(new Response(null, { status: 504, headers }));
          signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        })]);
      } finally { signal.removeEventListener('abort', abort); }
    },
  };
}
