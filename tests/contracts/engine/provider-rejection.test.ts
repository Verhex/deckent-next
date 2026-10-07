import { describe, expect, it } from 'vitest';
import { chatTurnRoundFailureState, classifyProviderRejection } from '#engine/index.js';
import { providerRejectionHint } from '#surfaces/core/terminal-render/index.js';
import { terminalRenderLabels } from '#surfaces/core/terminal-labels/index.js';

// SECRET-AT-REST (owner 2026-10-08): a refused key, a denied model, a reached spend limit and a rate limit are named apart, from the
// status and — where the caller holds it — the provider's typed error fields; the body itself is never returned or shown.
const summary = (httpStatus: number) => ({ reason: 'http-status' as const, httpStatus, body: { byteLength: 1, observedBytes: 1, complete: true, digest: 'f'.repeat(64) } });
const withBody = (httpStatus: number, error: unknown) => ({ reason: 'http-status' as const, httpStatus,
  body: { data: Buffer.from(JSON.stringify({ type: 'error', error })).toString('base64') } });

describe('provider refusal classification', () => {
  it('names a refused key, a denied request and a payment refusal from the status alone', () => {
    expect(classifyProviderRejection(summary(401))).toBe('credential-rejected');
    expect(classifyProviderRejection(summary(403))).toBe('access-denied');
    expect(classifyProviderRejection(summary(402))).toBe('spend-limit');
  });
  it('without the body a 429 is a reached limit (spend or rate, not guessed) and a 400 stays unclassified', () => {
    expect(classifyProviderRejection(summary(429))).toBe('limit-reached');
    expect(classifyProviderRejection(summary(400))).toBeNull();
    expect(classifyProviderRejection(summary(500))).toBeNull();
    expect(classifyProviderRejection({ reason: 'invalid-response', httpStatus: 401 })).toBeNull();
  });
  it('with the body: the Anthropic tier cap, a user-set (workspace) limit and OpenAI quota are spend limits; another 429 is the rate limit', () => {
    expect(classifyProviderRejection(withBody(429, { type: 'rate_limit_error', message: 'You have reached your API usage limits',
      details: { error_code: 'enforced_spend_limit_reached' } }))).toBe('spend-limit');
    expect(classifyProviderRejection(withBody(400, { type: 'invalid_request_error',
      message: 'You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.' }))).toBe('spend-limit');
    expect(classifyProviderRejection(withBody(400, { type: 'invalid_request_error',
      message: 'You have reached your specified API usage limits.' }))).toBe('spend-limit');
    expect(classifyProviderRejection(withBody(429, { type: 'insufficient_quota', code: 'insufficient_quota', message: 'quota' }))).toBe('spend-limit');
    expect(classifyProviderRejection(withBody(429, { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' }))).toBe('rate-limit');
    expect(classifyProviderRejection(withBody(400, { type: 'invalid_request_error', message: 'max_tokens: too large' }))).toBeNull();
    // A body that is not the provider's JSON error never decides a spend limit.
    expect(classifyProviderRejection({ reason: 'http-status', httpStatus: 429, body: { data: Buffer.from('<html>busy</html>').toString('base64') } })).toBe('rate-limit');
  });
  it('the turn note carries the token next to the status; the body never enters it', () => {
    const body = { encoding: 'base64' as const, byteLength: 159, observedBytes: 159, complete: true, digest: 'f'.repeat(64) };
    const content = { kind: 'response-body', encoding: 'base64', digest: 'f'.repeat(64), byteLength: 159 } as never;
    const rejected = (httpStatus: number) => chatTurnRoundFailureState({ schemaVersion: 4, state: 'rejected', observedAtMs: 1, content,
      evidence: { schemaVersion: 1, adapter: { id: 'anthropic-messages-http', version: 1 }, reason: 'http-status', httpStatus, body } });
    expect(rejected(401)).toBe('rejected: HTTP 401 (credential-rejected)');
    expect(rejected(429)).toBe('rejected: HTTP 429 (limit-reached)');
    expect(rejected(400)).toBe('rejected: HTTP 400');
  });
  it('the terminal shows the human sentence for the token in a failed round\'s note, in the session language', () => {
    const note = 'The model round ended without an answer (rejected: HTTP 401 (credential-rejected)); it is recorded and not retried.';
    expect(providerRejectionHint(note, terminalRenderLabels('tr'))).toContain('API anahtarını reddetti');
    expect(providerRejectionHint(note, terminalRenderLabels('en'))).toContain('refused the API key');
    expect(providerRejectionHint('The model round ended without an answer (rejected: HTTP 400); it is recorded.', terminalRenderLabels('en'))).toBeNull();
    expect(providerRejectionHint(null, terminalRenderLabels('en'))).toBeNull();
  });
});
