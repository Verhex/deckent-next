import { expect, it, vi } from 'vitest';
import { siwcLimitContinuation } from '#composition/core/model-invocation/index.js';
import { siwcConnectionView } from '#composition/core/siwc/index.js';
import { SIWC_INFERENCE, siwcRejection } from '#adapters/core/provider-siwc/index.js';
import { siwcCliCommand } from '#surfaces/core/siwc/index.js';

it('admits only trusted SIWC HTTP 429 limit evidence to the API continuation branch', () => {
  const encoded = (code: string, status: number | null) => {
    const body = siwcRejection({ error: { code } }, status);
    return body ? Buffer.from(JSON.stringify(body)).toString('base64') : null;
  };
  const limit = encoded('subscription_sharing_usage_limit_exceeded', 429);
  expect(siwcLimitContinuation(SIWC_INFERENCE.adapter.id, 429, limit)).toBe(true);
  for (const [code, status] of [['subscription_sharing_usage_unavailable', 503], ['subscription_sharing_usage_limit_exceeded', 503],
    ['subscription_sharing_usage_limit_exceeded', null], ['unknown', 429]] as const) {
    expect(siwcLimitContinuation(SIWC_INFERENCE.adapter.id, status, encoded(code, status))).toBe(false);
  }
  expect(siwcLimitContinuation('native-cli-headless', 429, limit)).toBe(false);
  expect(siwcLimitContinuation(SIWC_INFERENCE.adapter.id, 429, 'truncated')).toBe(false);
});
it('keeps email in the rich local view only; JSON and MCP omit it entirely', () => {
  const view = { schemaVersion: 1 as const, connectionId: '00000000-0000-4000-8000-000000000001', generation: 1, email: 'fixture@example.test',
    state: 'connected' as const, planUse: true, remoteRevocation: 'not-attempted' as const };
  expect(siwcConnectionView(view, 'terminal')).toHaveProperty('email', view.email);
  for (const surface of ['json', 'mcp'] as const) expect(siwcConnectionView(view, surface)).not.toHaveProperty('email');
});
it('refuses noninteractive JSON sign-in before invoking the host', async () => {
  const host = vi.fn();
  await expect(siwcCliCommand(['models', 'connect', '--connection', 'fixture', '--scope', 'scope', '--json'],
    { stdin: Object.assign(process.stdin, {}), stdout: { write() { return true; }, isTTY: false }, env: {} }, host)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(host).not.toHaveBeenCalled();
});
