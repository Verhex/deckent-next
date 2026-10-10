import { expect, it } from 'vitest';
import { ProviderSpendNoChargeRegistry, providerSpendNoChargeRegistry } from '#engine/index.js';

// Law 10 (lead 2026-10-10, E2 round 3): the packaged no-charge policy is the seed; a distribution adds its own vendor certifications through
// `deckent/extensions` before composeCore seals. Add-only: an overlay can never widen an existing certification.
const core = { vendor: 'vendor', endpoints: ['https://api.vendor.example/v1/chat/completions'], statuses: [400, 429], source: 'https://vendor.example/errors' };
const overlay = { vendor: 'acme.llm', endpoints: ['https://llm.acme.example/v1/chat/completions'], statuses: [400, 422], source: 'https://acme.example/errors',
  retrievedAt: '2026-10-10' };
const code = (value: string) => expect.objectContaining({ name: 'RegistryError', code: value });

it('adds a namespaced vendor certification and finds it only for its exact endpoint and statuses', () => {
  const registry = new ProviderSpendNoChargeRegistry([core]);
  registry.register(overlay);
  expect(registry.find('https://llm.acme.example/v1/chat/completions', 422)).toMatchObject({ vendor: 'acme.llm' });
  expect(registry.find('https://llm.acme.example/v1/chat/completions', 429)).toBeNull();
  expect(registry.find('https://llm.acme.example/v1/chat/completions/', 400)).toBeNull();
  expect(registry.find('https://api.vendor.example/v1/chat/completions', 400)).toMatchObject({ vendor: 'vendor' });
});

it('an overlay cannot relax an existing certification, take the core namespace, or certify uncertain statuses', () => {
  const registry = new ProviderSpendNoChargeRegistry([core]);
  // Same endpoint with more statuses (500/503 are uncertain, 404 is not certified for this vendor): refused, the core row is unchanged.
  expect(() => registry.register({ ...overlay, endpoints: core.endpoints, statuses: [400, 404] })).toThrow(code('REGISTRY_ADAPTER_DUPLICATE'));
  expect(registry.find('https://api.vendor.example/v1/chat/completions', 404)).toBeNull();
  expect(() => registry.register({ ...overlay, vendor: 'vendor' })).toThrow(code('REGISTRY_NAMESPACE_RESERVED'));
  expect(() => registry.register({ ...overlay, vendor: 'other' })).toThrow(code('REGISTRY_NAMESPACE_RESERVED'));
  for (const statuses of [[500], [503], [408], [409], [499], [200]]) expect(() => registry.register({ ...overlay, statuses })).toThrow(code('REGISTRY_MANIFEST_INVALID'));
  for (const endpoint of ['http://llm.acme.example/v1', 'https://llm.acme.example/v1?x=1', 'https://user:pw@llm.acme.example/v1', 'https://llm.acme.example/v1#a'])
    expect(() => registry.register({ ...overlay, endpoints: [endpoint] })).toThrow(code('REGISTRY_MANIFEST_INVALID'));
  registry.register(overlay);
  expect(() => registry.register({ ...overlay, vendor: 'acme.other' })).toThrow(code('REGISTRY_ADAPTER_DUPLICATE'));
});

it('refuses every registration after sealing; an undefined provider stays uncertified (held)', () => {
  const registry = new ProviderSpendNoChargeRegistry([core]);
  registry.seal();
  expect(() => registry.register(overlay)).toThrow(code('REGISTRY_SEALED'));
  expect(registry.find('https://llm.acme.example/v1/chat/completions', 400)).toBeNull();
  // The shipped seed certifies only exact vendor URLs: a local or unknown endpoint never releases money.
  expect(providerSpendNoChargeRegistry.find('https://127.0.0.1:8443/v1/chat/completions', 400)).toBeNull();
  expect(providerSpendNoChargeRegistry.find('https://api.openai.com/v1/chat/completions', 400)).toMatchObject({ vendor: 'openai' });
  expect(providerSpendNoChargeRegistry.find('https://api.openai.com/v1/chat/completions', 500)).toBeNull();
});

it('an overlay cannot widen a certified host through another path or port, and must date its source (batch F, E2 law audit)', () => {
  const registry = new ProviderSpendNoChargeRegistry([core]);
  // Host-level widening: another endpoint on a host a row already certifies is refused, whatever its path or port.
  for (const endpoint of ['https://api.vendor.example/v1/embeddings', 'https://api.vendor.example:8443/v1/chat/completions', 'https://api.vendor.example/v2/chat'])
    expect(() => registry.register({ ...overlay, endpoints: [endpoint] })).toThrow(code('REGISTRY_ADAPTER_DUPLICATE'));
  expect(registry.find('https://api.vendor.example/v1/embeddings', 400)).toBeNull();
  // A mixed row (one fresh endpoint + one on the certified host) is refused whole; nothing of it is admitted.
  expect(() => registry.register({ ...overlay, endpoints: ['https://llm.acme.example/v1/chat/completions', 'https://api.vendor.example/v1/x'] })).toThrow(code('REGISTRY_ADAPTER_DUPLICATE'));
  expect(registry.find('https://llm.acme.example/v1/chat/completions', 400)).toBeNull();
  // Provenance: an overlay row without (or with a malformed) source date is invalid; the seed's rows are dated by the policy file instead.
  const undated = Object.fromEntries(Object.entries(overlay).filter(([key]) => key !== 'retrievedAt'));
  for (const input of [undated, { ...overlay, retrievedAt: '10/10/2026' }, { ...overlay, retrievedAt: '' }]) expect(() => registry.register(input)).toThrow(code('REGISTRY_MANIFEST_INVALID'));
  expect(() => new ProviderSpendNoChargeRegistry([{ ...core, retrievedAt: '2026-10-09' }])).toThrow(code('REGISTRY_MANIFEST_INVALID'));
  registry.register(overlay);
  expect(registry.find('https://llm.acme.example/v1/chat/completions', 400)).toMatchObject({ vendor: 'acme.llm', retrievedAt: '2026-10-10' });
  // A second overlay cannot widen the first one's host either.
  expect(() => registry.register({ ...overlay, vendor: 'acme.other', endpoints: ['https://llm.acme.example/v1/responses'] })).toThrow(code('REGISTRY_ADAPTER_DUPLICATE'));
});
