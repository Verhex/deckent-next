import { expect, it } from 'vitest';
import { resolveGlobalScopePaths, resolveProductLayout } from '#platform/index.js';
import { homeEnv, hostLayoutPlatform } from '../support/host-platform.js';

// PLATFORM-TEMIZLIK (2026-10-15): the cross-platform fixture plumbing, simulated for native Windows on any host. A fixture that names the
// host's layout platform resolves a drive-letter root, and a fixture home resolves through USERPROFILE where the product ignores HOME.
it('a native Windows fixture root resolves only with the host layout platform; POSIX hosts keep the posix family', () => {
  expect(hostLayoutPlatform('win32')).toBe('win32');
  for (const platform of ['linux', 'darwin']) expect(hostLayoutPlatform(platform)).toBe('posix');
  expect(() => resolveProductLayout({ projectRoot: 'C:\\fixture\\project' })).toThrow('LAYOUT_ROOT_INVALID');
  expect(resolveProductLayout({ projectRoot: 'C:\\fixture\\project', root: 'C:\\fixture\\data', platform: hostLayoutPlatform('win32') }))
    .toMatchObject({ platform: 'win32', root: 'C:\\fixture\\data' });
  expect(resolveProductLayout({ projectRoot: '/fixture/project', platform: hostLayoutPlatform('linux') })).toMatchObject({ platform: 'posix' });
});

it('a fixture home resolves on native Windows through USERPROFILE and on POSIX through HOME', () => {
  expect(() => resolveGlobalScopePaths('win32', { HOME: 'C:\\fixture\\home' })).toThrow('User home could not be resolved');
  expect(resolveGlobalScopePaths('win32', homeEnv('C:\\fixture\\home'))).toMatchObject({ home: 'C:\\fixture\\home', stateDir: 'C:\\fixture\\home\\.deckent' });
  expect(resolveGlobalScopePaths('darwin', homeEnv('/fixture/home'))).toMatchObject({ home: '/fixture/home', stateDir: '/fixture/home/.deckent' });
});
