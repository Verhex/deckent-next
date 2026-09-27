import { describe, expect, it } from 'vitest';
import { createDefaultConfig, versionedConfig } from '../../../src/platform/core/config/index.js';
import { inspectProductLayout, productResourcePath, resolveProductLayout } from '../../../src/platform/core/host/index.js';

describe('H34 company version boundaries', () => {
  it('rejects explicit config v2 without silently converting the authored object', () => {
    const authored = { schema_version: 2, company: { id: 'acme' } };
    expect(() => versionedConfig(authored)).toThrow(expect.objectContaining({ code: 'CONFIG_VERSION_UNSUPPORTED' }));
    expect(authored).toEqual({ schema_version: 2, company: { id: 'acme' } });
  });
  it('emits config v3 for defaults and unversioned layers', () => {
    expect(createDefaultConfig().schema_version).toBe(3);
    expect(versionedConfig({ company: { id: 'acme' } })).toEqual({ schema_version: 3, company: { id: 'acme' } });
    expect(versionedConfig({ schema_version: 3 })).toEqual({ schema_version: 3 });
  });
  it('rejects an old layout snapshot before resource path use or inspection', () => {
    const layout = resolveProductLayout({ projectRoot: '/project' });
    expect(layout.schemaVersion).toBe(3);
    const old = { ...layout, schemaVersion: 2 };
    expect(() => productResourcePath(old, 'memory')).toThrow(expect.objectContaining({ code: 'LAYOUT_VERSION_UNSUPPORTED' }));
    expect(() => inspectProductLayout(old)).toThrow(expect.objectContaining({ code: 'LAYOUT_VERSION_UNSUPPORTED' }));
    expect(inspectProductLayout(layout).schemaVersion).toBe(3);
  });
});
