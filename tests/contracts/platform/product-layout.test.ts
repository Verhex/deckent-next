import { describe, expect, it } from 'vitest';
import { inspectProductLayout, resolveProductLayout, productResourcePath, type ProductResource } from '../../../src/platform/core/host/index.js';

describe('product resource layout', () => {
  it('keeps durable resources below one root in development and installed projects', () => {
    for (const projectRoot of ['/development', '/customer']) {
      const layout = resolveProductLayout({ projectRoot });
      expect(productResourcePath(layout, 'memory')).toBe(`${projectRoot}/.deckent/brain/memory.db`);
      for (const resource of Object.keys(layout.resources) as ProductResource[]) expect(productResourcePath(layout, resource)).toMatch(new RegExp(`^${projectRoot}/\\.deckent/`));
    }
  });
  it('pins immutable revisions and copies configuration before later reloads', () => {
    const resources = { crashes: 'diagnostics/crashes' };
    const first = resolveProductLayout({ projectRoot: '/project', root: '/storage/a', resources });
    resources.crashes = 'changed';
    const second = resolveProductLayout({ projectRoot: '/project', root: '/storage/b', resources });
    expect(productResourcePath(first, 'crashes')).toBe('/storage/a/diagnostics/crashes');
    expect(first.revision).not.toBe(second.revision);
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.resources)).toBe(true);
    expect(resolveProductLayout({ projectRoot: '/project', root: '/storage/a', resources: { crashes: 'diagnostics/crashes' } }).revision).toBe(first.revision);
  });
  it('anchors config and the installation journal at the project bootstrap when data root relocates', () => {
    const layout = resolveProductLayout({ projectRoot: '/project', root: '/storage/data' });
    expect(productResourcePath(layout, 'config')).toBe('/project/.deckent/config.json');
    expect(productResourcePath(layout, 'installationJournal')).toBe('/project/.deckent/installation/journal.json');
    expect(productResourcePath(layout, 'memory')).toBe('/storage/data/brain/memory.db');
    expect(inspectProductLayout(layout).resources.installationJournal).toBe('/project/.deckent/installation/journal.json');
    const globalLayout = resolveProductLayout({ projectRoot: '/project', root: '/storage/data', bootstrapConfigPath: '/global/config.json' });
    expect(productResourcePath(globalLayout, 'config')).toBe('/global/config.json');
    expect(productResourcePath(globalLayout, 'installationJournal')).toBe('/global/installation/journal.json');
  });
  it('rejects fixed resource redirects and exact fixed-to-movable path collisions', () => {
    expect(() => resolveProductLayout({ projectRoot: '/project', resources: { config: 'other.json' } })).toThrow('LAYOUT_RESOURCE_INVALID');
    expect(() => resolveProductLayout({ projectRoot: '/project', resources: { installationJournal: 'other.json' } })).toThrow('LAYOUT_RESOURCE_INVALID');
    expect(() => resolveProductLayout({ projectRoot: '/project', root: '/project/.deckent/installation', resources: { policy: 'journal.json' } }))
      .toThrow('LAYOUT_RESOURCE_INVALID');
  });
  it('rejects traversal and platform-ambiguous resource names instead of normalizing them', () => {
    for (const crashes of ['../outside', '/absolute', 'a/../b', 'a\\b', 'C:outside', 'x\0y', 'a//b', 'CON.txt', 'a.']) {
      expect(() => resolveProductLayout({ projectRoot: '/p', resources: { crashes } })).toThrow('LAYOUT_RESOURCE_INVALID');
    }
    expect(() => resolveProductLayout({ projectRoot: 'relative' })).toThrow('LAYOUT_ROOT_INVALID');
    expect(() => productResourcePath(resolveProductLayout({ projectRoot: '/p' }), '__proto__' as ProductResource)).toThrow('LAYOUT_RESOURCE_UNKNOWN');
  });
  it('resolves Windows locations without using the executing host path syntax', () => {
    const layout = resolveProductLayout({ projectRoot: 'C:\\project', root: 'D:\\data', platform: 'win32' });
    expect(productResourcePath(layout, 'memory')).toBe('D:\\data\\brain\\memory.db');
  });
});
