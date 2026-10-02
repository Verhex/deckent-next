import { describe, expect, it } from 'vitest';
import { createDefaultConfig, versionedConfig } from '../../../src/platform/core/config/index.js';
import { inspectProductLayout, productResourcePath, resolveProductLayout } from '../../../src/platform/core/host/index.js';

describe('H34 company version boundaries', () => {
  it('rejects explicit config v2 without silently converting the authored object', () => {
    const authored = { schema_version: 2, company: { id: 'acme' } };
    expect(() => versionedConfig(authored)).toThrow(expect.objectContaining({ code: 'CONFIG_VERSION_UNSUPPORTED' }));
    expect(authored).toEqual({ schema_version: 2, company: { id: 'acme' } });
  });
  it('emits config v4 for defaults and unversioned layers', () => {
    expect(createDefaultConfig().schema_version).toBe(4);
    expect(versionedConfig({ company: { id: 'acme' } })).toEqual({ schema_version: 4, company: { id: 'acme' } });
    expect(versionedConfig({ schema_version: 4 })).toEqual({ schema_version: 4 });
  });
  it('rejects an old layout snapshot before resource path use or inspection', () => {
    const layout = resolveProductLayout({ projectRoot: '/project' });
    // SCR-A (owner 2026-09-28): registry v4 adds the `scratch` resource; every installation's layout revision changes with it.
    expect(layout.schemaVersion).toBe(4);
    for (const version of [2, 3]) {
      const old = { ...layout, schemaVersion: version };
      expect(() => productResourcePath(old, 'memory')).toThrow(expect.objectContaining({ code: 'LAYOUT_VERSION_UNSUPPORTED' }));
      expect(() => inspectProductLayout(old)).toThrow(expect.objectContaining({ code: 'LAYOUT_VERSION_UNSUPPORTED' }));
    }
    expect(inspectProductLayout(layout).schemaVersion).toBe(4);
    expect(productResourcePath(layout, 'scratch')).toBe('/project/.deckent/state/scratch');
    expect(inspectProductLayout(layout).resources.scratch).toBe('/project/.deckent/state/scratch');
  });
});
