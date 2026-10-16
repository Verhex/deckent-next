import { expect, it } from 'vitest';
import { createDefaultConfig, validateConfig } from '#platform/index.js';
import { CONFIG_VALUE_CHOICES } from '#platform/core/config-fields/index.js';
it('has a strict versioned config, safe defaults and a registered selection for each event bound', () => {
  const config = createDefaultConfig(), events = config.service.events;
  expect(events).toMatchObject({ schemaVersion: 1, enabled: false });
  for (const key of Object.keys(events)) expect(CONFIG_VALUE_CHOICES).toHaveProperty('service.events.' + key);
  expect(() => validateConfig({ service: { events: { unknown: 1 } } })).toThrow();
});
it('reserves a control connection and enforces timeout, byte, page and subscriber invariants', () => {
  for (const events of [{ enabled: true, maxSubscribers: 32 }, { heartbeatMs: 30000, idleTimeoutMs: 1000 }, { subscriberMaxEvents: 1 },
    { subscriberMaxBytes: 0 }, { readPageSize: 4096, maxSnapshotRows: 10 }, { maxSubscribersPerPrincipal: 100 }]) {
    expect(() => validateConfig({ service: { events } })).toThrow();
  }
  expect(validateConfig({ service: { maxConnections: 2, events: { enabled: true, maxSubscribers: 1, maxSubscribersPerPrincipal: 1 } } }).config.service.events.enabled).toBe(true);
});
