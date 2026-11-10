import { CodedError, persistedInteger, persistedUrl } from '#platform/index.js';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';

/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type NpmRegistryErrorCode = 'NPM_REGISTRY_ENDPOINT_INVALID' | 'NPM_REGISTRY_PACKAGE_INVALID' | 'NPM_REGISTRY_UNAVAILABLE'
  | 'NPM_REGISTRY_TIMEOUT' | 'NPM_REGISTRY_STATUS' | 'NPM_REGISTRY_RESPONSE_TOO_LARGE' | 'NPM_REGISTRY_RESPONSE_INVALID';
/** Bounded failure evidence: never carries response bodies or headers. */
export class NpmRegistryError extends CodedError {
  constructor(override readonly code: NpmRegistryErrorCode, readonly status?: number) { super(code); this.name = 'NpmRegistryError'; }
}
const inputSchema = z.strictObject({ endpoint: persistedUrl(), package: z.string().regex(/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/),
  timeoutMs: persistedInteger().positive().max(2_147_483_647), responseMaxBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) });
export type NpmLatestVersionInput = z.infer<typeof inputSchema>;
const latestSchema = z.looseObject({ version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/) });
export type NpmLatestVersion = Readonly<{ version: string; source: string; observedAt: string }>;

/** Reads `<endpoint>/<package>/latest` with a timeout and response cap; no credentials, no redirects, no retries.
 * A private registry endpoint is configuration; the product never chooses it. */
export function fetchNpmLatestVersion(rawInput: NpmLatestVersionInput): Promise<NpmLatestVersion> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) throw new NpmRegistryError(parsed.error.issues.some(issue => issue.path[0] === 'package') ? 'NPM_REGISTRY_PACKAGE_INVALID' : 'NPM_REGISTRY_ENDPOINT_INVALID');
  const input = parsed.data;
  let url: URL;
  try { url = new URL(`${input.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(input.package)}/latest`); } catch { throw new NpmRegistryError('NPM_REGISTRY_ENDPOINT_INVALID'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new NpmRegistryError('NPM_REGISTRY_ENDPOINT_INVALID');
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const source = `${url.origin}${url.pathname}`;
  return new Promise<NpmLatestVersion>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const req = send(url, { method: 'GET', headers: { accept: 'application/json' }, timeout: input.timeoutMs }, response => {
      const chunks: Buffer[] = []; let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > input.responseMaxBytes) { response.destroy(); finish(() => reject(new NpmRegistryError('NPM_REGISTRY_RESPONSE_TOO_LARGE'))); return; }
        chunks.push(chunk);
      });
      response.on('error', () => finish(() => reject(new NpmRegistryError('NPM_REGISTRY_UNAVAILABLE'))));
      response.on('end', () => finish(() => {
        if (response.statusCode !== 200) { reject(new NpmRegistryError('NPM_REGISTRY_STATUS', response.statusCode)); return; }
        try {
          const body = latestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          resolve(Object.freeze({ version: body.version, source, observedAt: new Date().toISOString() }));
        } catch { reject(new NpmRegistryError('NPM_REGISTRY_RESPONSE_INVALID')); }
      }));
    });
    req.on('timeout', () => { req.destroy(); finish(() => reject(new NpmRegistryError('NPM_REGISTRY_TIMEOUT'))); });
    req.on('error', () => finish(() => reject(new NpmRegistryError('NPM_REGISTRY_UNAVAILABLE'))));
    req.end();
  });
}
