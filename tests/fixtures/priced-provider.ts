import type { IncomingMessage, ServerResponse } from 'node:http';

export { createLocalTls as createPricedProviderTls } from './local-tls.js';

export function replyPricedProviderMetadata(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method !== 'GET' || request.url !== '/api/v1/models/vendor/model/endpoints') return false;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: { id: 'vendor/model', endpoints: [{
    model_id: 'vendor/model', tag: 'provider/region', provider_name: 'Fixture', context_length: 4096,
    max_prompt_tokens: 1000, max_completion_tokens: 32, status: 0, supported_parameters: ['max_completion_tokens'],
    pricing: { prompt: '0.000001', completion: '0.000002', request: '0', input_cache_read: '0',
      input_cache_write: '0', internal_reasoning: '0' },
  }] } }));
  return true;
}

export function pricedProviderDefinition(origin: string, caPem: string) {
  return Object.freeze({ endpoint: `${origin}/chat`, authentication: Object.freeze({ type: 'none' as const }),
    tls: Object.freeze({ caPem }), maxOutputTokens: 8,
    metadataEndpoint: `${origin}/api/v1/models/vendor/model/endpoints`, endpointTag: 'provider/region',
    metadataLimits: Object.freeze({ maxAgeMs: 60_000, maxResponseBytes: 64_000, timeoutMs: 1000 }) });
}

export function fixtureBudget(scopeId = 'scope') {
  return Object.freeze({ schemaVersion: 1 as const, budgets: [Object.freeze({ schemaVersion: 1 as const, scopeId,
    budgetId: 'budget', revision: 1, currency: 'USD' as const, limitMinorUnits: 1000 })] });
}
