import { describe, expect, it } from 'vitest';
import { resolveProductLayout, productResourcePath, type ProductResource } from '../../../src/kernel/core/platform/index.js';

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
