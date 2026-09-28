import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentToolOutcome, AgentToolSpec } from '#domain/index.js';
import { EffectTargetError, type EffectApplyRequest, type EffectTarget } from '#engine/index.js';
import { redactText } from '#adapters/core/native-connection/index.js';
import { fetchableUrlError, fetchHttps, type HttpFetchResult, type HttpFetchTransport } from './request.js';

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export const NETWORK_FETCH_TARGET_KIND = 'network-fetch';
/** Core operation of an agent fetch (FETCH S7, owner 2026-09-28): the `network` namespace is Core's. A request leaves the machine, so it is a
 * write-class external effect; policy decides it, it has no precondition and no compensation. The input is the URL and the byte limit. */
export const NETWORK_FETCH_OPERATION = Object.freeze({ schemaVersion: 1 as const, operation: Object.freeze({ id: 'network.fetch', version: 1 }),
  targetKind: NETWORK_FETCH_TARGET_KIND, effectClass: 'write' as const, approval: 'policy' as const, precondition: 'none' as const,
  compensation: null, inputMaxBytes: 4_096 });
export const FETCH_URL_MAX_CHARS = 2_048;
/** Head of a fetched text shown to the model (the read tools' result bound); the whole body is in the scratch area. */
export const FETCH_HEAD_BYTES = 16_384;

export const FETCH_URL_TOOL_SPEC: AgentToolSpec = Object.freeze({ name: 'fetch_url', version: 1, toolClass: 'deckent' as const,
  description: 'Fetch one https:// URL with a plain GET (no cookies or credentials) and save the response body in your scratch area under fetch/. '
    + 'The result names the status, content type, size and saved path, and shows the first 16 KiB of a text body (secret-shaped text is redacted); '
    + 'read the rest with scratch_read. Hosts outside the installation\'s allowlist wait for the operator or are refused.',
  inputSchema: { type: 'object' as const, required: ['url'], properties: { url: { type: 'string', description: 'The https:// URL' },
    maxBytes: { type: 'integer', description: 'Keep at most this many body bytes (the installation limit applies)' } } } });

/** `terminal.fetch` as the adapter uses it (configuration data). */
export interface FetchSettings {
  readonly egress: 'none' | 'allowlist' | 'approval'; readonly allowedHosts: readonly string[]; readonly maxBytes: number;
  readonly timeoutMs: number; readonly maxRedirects: number;
}
export type FetchPlan = { readonly ok: true; readonly url: string; readonly host: string; readonly listed: boolean; readonly maxBytes: number }
  | { readonly ok: false; readonly error: string };

/**
 * Plans one `fetch_url` call before anything is resolved or asked (no DNS query leaves the machine before a decision): https only,
 * no credentials in the URL, the default port, a host name (not an IP literal), at most 2048 characters; the fragment is dropped. The
 * verdict: an allowlisted host (exact match) is `listed`; any other host is refused under `allowlist` egress and asks under `approval`.
 */
export function planFetchCall(settings: FetchSettings, args: Record<string, unknown>): FetchPlan {
  if (settings.egress === 'none') return { ok: false, error: 'network-disabled' };
  const raw = args['url'], limit = args['maxBytes'];
  if (typeof raw !== 'string' || (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1))) return { ok: false, error: 'invalid-arguments' };
  if (raw.length > FETCH_URL_MAX_CHARS) return { ok: false, error: 'url-too-long' };
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, error: 'invalid-url' }; }
  const refused = fetchableUrlError(url);
  if (refused) return { ok: false, error: refused };
  url.hash = '';
  const listed = settings.allowedHosts.includes(url.hostname);
  if (!listed && settings.egress !== 'approval') return { ok: false, error: 'host-not-allowed' };
  return { ok: true, url: url.href, host: url.hostname, listed, maxBytes: Math.min(settings.maxBytes, typeof limit === 'number' ? limit : settings.maxBytes) };
}

/** Effect identity of one fetch call: the turn, the call's position and its exact arguments (the shell's scheme, Astra 2113). */
export const agentFetchEffectCommandId = (scopeId: string, turnId: string, execution: { readonly round: number; readonly index: number }, argsDigest: string) =>
  sha256(`agent-fetch-effect:1\0${scopeId}\0${turnId}\0${execution.round}\0${execution.index}\0${argsDigest}`);

/** The approval card: the whole URL, why it asks, what happens to the body, and the URL's digest. */
export function describeFetchApproval(plan: Extract<FetchPlan, { ok: true }>): string {
  return `GET ${plan.url}\nhost: ${plan.host}${plan.listed ? '' : ' (not on this installation\'s allowlist)'}\n`
    + `body: at most ${plan.maxBytes} bytes, saved in the conversation's scratch area; the first ${FETCH_HEAD_BYTES} bytes of a text body are shown to the model\n`
    + `sha256(url): ${sha256(plan.url)}`;
}

const EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({ 'text/html': 'html', 'text/plain': 'txt', 'text/markdown': 'md', 'text/css': 'css',
  'text/csv': 'csv', 'text/xml': 'xml', 'application/xml': 'xml', 'application/json': 'json', 'text/javascript': 'js', 'application/javascript': 'js',
  'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'application/yaml': 'yaml' });
const mediaType = (contentType: string | null) => (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase();
/** The saved file's extension comes only from this fixed table of media types, never from the URL. */
const extensionOf = (contentType: string | null) => EXTENSIONS[mediaType(contentType)] ?? (mediaType(contentType).startsWith('text/') ? 'txt' : 'bin');
const isText = (contentType: string | null) => { const type = mediaType(contentType); return type.startsWith('text/') || /(?:json|xml|javascript|yaml)$/u.test(type); };

/** Stores a fetched body in the scratch area (the scratch store owns the quota and the file). */
export type FetchDeposit = (rel: string, data: Uint8Array) => Promise<{ readonly ok: true; readonly path: string; readonly rel: string } | { readonly ok: false; readonly error: string }>;
export interface FetchRun { readonly result: HttpFetchResult; readonly stored: Awaited<ReturnType<FetchDeposit>> | null }

const inputSchema = z.object({ url: z.string().min(1).max(FETCH_URL_MAX_CHARS), maxBytes: z.number().int().positive() }).strict();
/**
 * One fetch as a C11 effect target (FETCH S7). Each call is its own record; the request is never repeated: `lookup` is always unknown.
 * Nothing sent → refused; answered (any HTTP status, a stopped redirect included) → the effect happened; sent then timed out, cancelled or
 * broken → unknown. A response body is saved to the scratch area as `fetch/<sha256>.<ext>` before the result is handed to `onResult`.
 */
export class NetworkFetchTarget implements EffectTarget {
  readonly kind = NETWORK_FETCH_TARGET_KIND;
  constructor(private readonly run: { readonly settings: FetchSettings; readonly transport: HttpFetchTransport; readonly redirectAllowed: (host: string) => boolean;
    readonly deposit: FetchDeposit; readonly signal: AbortSignal; readonly onResult: (run: FetchRun) => void }) {}
  identity() { return 'network-fetch:https'; }
  async observe() { return { version: null }; }
  async apply(request: EffectApplyRequest) {
    const parsed = inputSchema.safeParse(request.input);
    if (!parsed.success) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    const { settings, transport, redirectAllowed, signal } = this.run;
    const result = await fetchHttps({ url: parsed.data.url, maxBytes: Math.min(parsed.data.maxBytes, settings.maxBytes), timeoutMs: settings.timeoutMs,
      maxRedirects: settings.maxRedirects, redirectAllowed, transport, signal });
    const stored = result.outcome === 'response'
      ? await this.run.deposit(`fetch/${sha256(result.body)}.${extensionOf(result.contentType)}`, result.body).catch(() => ({ ok: false as const, error: 'scratch-unavailable' }))
      : null;
    this.run.onResult({ result, stored });
    if (result.outcome === 'refused') throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    if (result.outcome === 'unknown') throw new EffectTargetError('EFFECT_TARGET_UNKNOWN');
    return { version: null };
  }
  async lookup() { return null; }
}

/** Text of a UTF-8 prefix of at most `bytes`, never splitting a character. */
function head(body: Buffer, bytes: number): string {
  let end = Math.min(body.length, bytes);
  if (end < body.length) while (end > 0 && (body[end]! & 0xc0) === 0x80) end--;
  return body.subarray(0, end).toString('utf8');
}
/** The model's result of one fetch: what happened, where the body is, and a redacted head of a text body. */
export function describeFetchResult(run: FetchRun): AgentToolOutcome {
  const { result, stored } = run, tag = '[deckent] fetch_url:';
  if (result.outcome === 'refused') return { status: 'error', text: `${tag} error=${result.reason}; nothing was sent` };
  if (result.outcome === 'unknown') {
    return { status: 'error', text: `${tag} error=${result.reason}; the request was sent and its outcome is unknown; it is not sent again` };
  }
  if (result.outcome === 'stopped') {
    return { status: 'error', text: `${tag} error=${result.reason}${result.location ? ` (to ${result.location}, status ${result.httpStatus})` : ''} after `
      + `${result.redirects} redirect(s) from ${result.finalUrl}; the earlier request(s) were sent` };
  }
  const lines = [`${tag} status=${result.httpStatus} content-type=${result.contentType ?? 'unknown'} bytes=${result.body.length} truncated=${result.truncated} `
    + `redirects=${result.redirects} url=${result.finalUrl}`];
  lines.push(stored?.ok ? `[deckent] saved: ${stored.path} (scratch_read path: ${stored.rel})` : `[deckent] not saved: error=${stored?.error ?? 'scratch-unavailable'}`);
  if (!isText(result.contentType)) lines.push('[deckent] binary content is not shown');
  else {
    lines.push(redactText(head(result.body, FETCH_HEAD_BYTES), [], Number.MAX_SAFE_INTEGER));
    if (result.body.length > FETCH_HEAD_BYTES) lines.push(`[deckent] showing the first ${FETCH_HEAD_BYTES} of ${result.body.length} bytes`);
  }
  const ok = stored?.ok === true && result.httpStatus !== null && result.httpStatus >= 200 && result.httpStatus < 300;
  return { status: ok ? 'ok' : 'error', text: lines.join('\n') };
}

/** The result of a call whose effect did not run (policy, approval or an effect error), in the shell tool's words. */
export function describeFetchRefusal(code: unknown): AgentToolOutcome {
  const why = code === 'POLICY_DENIED' ? `denied by policy (operation ${NETWORK_FETCH_OPERATION.operation.id}); nothing was sent`
    : code === 'EFFECT_APPROVAL_REQUIRED' ? 'the fetch needs an approval that was not given; nothing was sent'
    : typeof code === 'string' && code.startsWith('APPROVAL_') ? `the approval for this call could not be verified (${code}); nothing was sent`
    : typeof code === 'string' ? code : 'failed';
  return { status: 'error', text: `[deckent] fetch_url: error=${why}` };
}
